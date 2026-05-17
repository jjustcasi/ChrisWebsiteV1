require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const {
  initializeDatabase,
  isUsingFileFallback,
  getUsers,
  getUserByEmail,
  getUserByUsername,
  getUserById,
  deleteUser,
  updateUserRole,
  updateUserUsername,
  createUser,
  getAnnouncements,
  createAnnouncement,
  updateAnnouncementVisibility,
  deleteAnnouncement,
  getLeaves,
  upsertLeavesForEmployee,
  updateLeaveStatus,
  getAttendance,
  upsertAttendanceForEmployee,
  getTrainings,
  upsertTrainingsForEmployee,
  getEvaluation,
  upsertEvaluation,
  getLeaveComments,
  createLeaveComment,
  deleteLeaveComment,
  getUserProfile,
  upsertUserProfile,
  updateUserPassword,
  updateUserMfa,
  updateUserLoginSecurity,
  resetUserLoginSecurity,
  getAuditLogs,
  createAuditLog,
} = require('./database');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const RAW_GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const ENABLE_GOOGLE_AUTH = String(process.env.ENABLE_GOOGLE_AUTH || '').toLowerCase() === 'true';

function isValidGoogleClientId(clientId) {
  return Boolean(clientId)
    && clientId !== 'YOUR_GOOGLE_CLIENT_ID'
    && !clientId.startsWith('your-')
    && !clientId.startsWith('GOOGLE_CLIENT_ID=')
    && clientId.endsWith('.apps.googleusercontent.com');
}

const GOOGLE_CLIENT_ID = isValidGoogleClientId(RAW_GOOGLE_CLIENT_ID) ? RAW_GOOGLE_CLIENT_ID : '';
const GOOGLE_AUTH_CONFIGURED = Boolean(GOOGLE_CLIENT_ID) && ENABLE_GOOGLE_AUTH;
const IS_PRODUCTION_DEPLOY = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  || Boolean(process.env.RAILWAY_ENVIRONMENT);

const app = express();
app.use(express.json({ limit: '25mb' }));

const MFA_ISSUER = process.env.MFA_ISSUER || 'CHRIS';
const MFA_CHALLENGE_SECRET = process.env.MFA_CHALLENGE_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MFA_CODE_TTL_MS = 5 * 60 * 1000;
const AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_LOCKOUT_THRESHOLD = 3;
const LOGIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MFA_METHODS = new Set(['authenticator', 'email']);
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || '';
const EMAIL_MFA_DEV_MODE = String(process.env.EMAIL_MFA_DEV_MODE || '').toLowerCase() === 'true';

app.get('/backend/:page', (req, res, next) => {
  if (!/^[a-z0-9-]+\.html$/i.test(req.params.page)) {
    next();
    return;
  }
  res.redirect(302, `/${req.params.page}`);
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify({
    googleClientId: GOOGLE_CLIENT_ID,
    googleAuthConfigured: GOOGLE_AUTH_CONFIGURED,
  })};`);
});

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@chris.com';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const EXTRA_ADMIN_EMAIL = process.env.EXTRA_ADMIN_EMAIL || '';
const EXTRA_ADMIN_PASSWORD = process.env.EXTRA_ADMIN_PASSWORD || '';
const EXTRA_ADMIN_USERNAME = process.env.EXTRA_ADMIN_USERNAME || '';

function isPlaceholderValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized
    || normalized.includes('example.com')
    || normalized.includes('replace-with')
    || normalized.includes('change-me')
    || normalized.startsWith('your_')
    || normalized.startsWith('your-');
}

function isSmtpConfigured() {
  return !isPlaceholderValue(SMTP_HOST)
    && !isPlaceholderValue(SMTP_FROM)
    && !isPlaceholderValue(SMTP_USER)
    && !isPlaceholderValue(SMTP_PASS);
}

function validateDeploymentConfig() {
  if (!IS_PRODUCTION_DEPLOY) return;

  const missing = [];
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin123') missing.push('ADMIN_PASSWORD');
  if (!process.env.SESSION_SECRET && !process.env.MFA_CHALLENGE_SECRET) missing.push('SESSION_SECRET or MFA_CHALLENGE_SECRET');
  if ((EXTRA_ADMIN_EMAIL && !EXTRA_ADMIN_PASSWORD) || (!EXTRA_ADMIN_EMAIL && EXTRA_ADMIN_PASSWORD)) {
    missing.push('both EXTRA_ADMIN_EMAIL and EXTRA_ADMIN_PASSWORD');
  }

  if (missing.length) {
    throw new Error(`Missing production environment variable(s): ${missing.join(', ')}`);
  }
}

async function ensureAdminAccount({ email, password, username = '', name = 'Admin User', isDefault = false }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedUsername = String(username || normalizedEmail.split('@')[0] || 'admin').trim().toLowerCase();
  if (!normalizedEmail || !password) return;

  const existingAdmin = await getUserByEmail(normalizedEmail);
  if (existingAdmin) {
    const usernameOwner = validateUsername(normalizedUsername) ? await getUserByUsername(normalizedUsername) : null;
    if (!existingAdmin.username && validateUsername(normalizedUsername) && (!usernameOwner || usernameOwner.id === existingAdmin.id)) {
      await updateUserUsername(existingAdmin.id, normalizedUsername);
      console.log(`Updated existing admin ${normalizedEmail} with username: ${normalizedUsername}.`);
    }
    if (existingAdmin.role !== 'admin') {
      await updateUserRole(existingAdmin.id, 'admin');
      console.log(`Updated existing user ${normalizedEmail} to admin role.`);
    }
    return;
  }

  const finalUsername = validateUsername(normalizedUsername)
    && !(await getUserByUsername(normalizedUsername))
    ? normalizedUsername
    : await generateAvailableUsername(normalizedEmail, 'admin');

  await createUser({
    name,
    username: finalUsername,
    surname: 'Admin',
    firstName: 'Admin',
    middleName: '',
    suffix: '',
    email: normalizedEmail,
    birthday: '2000-01-01',
    password: bcrypt.hashSync(password, 10),
    gender: 'Other',
    role: 'admin',
    google: false,
  });
  console.log(`Created ${isDefault ? 'default' : 'extra'} admin account: ${normalizedEmail}`);
}

async function ensureAdminAccounts() {
  await ensureAdminAccount({
    email: DEFAULT_ADMIN_EMAIL,
    password: DEFAULT_ADMIN_PASSWORD,
    username: 'admin',
    isDefault: true,
  });

  if (EXTRA_ADMIN_EMAIL || EXTRA_ADMIN_PASSWORD) {
    await ensureAdminAccount({
      email: EXTRA_ADMIN_EMAIL,
      password: EXTRA_ADMIN_PASSWORD,
      username: EXTRA_ADMIN_USERNAME,
      name: 'Recovery Admin',
    });
  }
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function validateUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9._-]{3,30}$/.test(username);
}

function validateStrongPassword(password) {
  const value = String(password || '');
  return value.length >= 12
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /[0-9]/.test(value)
    && /[^A-Za-z0-9\s]/.test(value)
    && !/\s/.test(value);
}

function normalizeMfaMethod(method) {
  const normalized = String(method || 'authenticator').trim().toLowerCase();
  return MFA_METHODS.has(normalized) ? normalized : 'authenticator';
}

function validateBirthday(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

async function generateAvailableUsername(email, fallback = 'user') {
  const emailName = String(email || '').split('@')[0] || fallback;
  const base = emailName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24) || fallback;

  let candidate = base.length >= 3 ? base : `${base}user`.slice(0, 24);
  let suffix = 1;
  while (await getUserByUsername(candidate)) {
    candidate = `${base.slice(0, 24)}${suffix}`;
    suffix += 1;
  }
  return candidate;
}

app.post('/api/auth/signup', async (req, res) => {
  const { username, surname, firstName, middleName, suffix, email, birthday, password, gender } = req.body;
  if (!username || !surname || !firstName || !email || !birthday || !password || !gender) {
    return res.status(400).json({ success: false, message: 'Please complete all sign up fields.' });
  }

  if (!validateUsername(username)) {
    return res.status(400).json({ success: false, message: 'Username must be 3-30 characters and use only letters, numbers, dots, underscores, or hyphens.' });
  }

  if (!validateEmail(email)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  }

  if (!validateBirthday(birthday)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid birthday in YYYY-MM-DD format.' });
  }

  if (!validateStrongPassword(password)) {
    return res.status(400).json({ success: false, message: 'Password must be strong: use at least 12 characters with uppercase, lowercase, number, and symbol.' });
  }

  const normalizedEmail = email.toLowerCase();
  const normalizedUsername = username.trim().toLowerCase();
  const existingUser = await getUserByEmail(normalizedEmail);
  if (existingUser) {
    return res.status(409).json({ success: false, message: 'Account already exists. Please login instead.' });
  }
  const existingUsername = await getUserByUsername(normalizedUsername);
  if (existingUsername) {
    return res.status(409).json({ success: false, message: 'Username is already taken. Please choose another one.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const name = [firstName, middleName, surname, suffix]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  const user = await createUser({
    name: name.trim(),
    username: normalizedUsername,
    surname: surname.trim(),
    firstName: firstName.trim(),
    middleName: String(middleName || '').trim(),
    suffix: String(suffix || '').trim(),
    email: normalizedEmail,
    birthday,
    password: hashedPassword,
    gender,
    role: 'employee',
    google: false,
  });

  return res.json({ success: true, user: safeAuthUser(user), sessionToken: createAuthSession(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const mfaMethod = normalizeMfaMethod(req.body.mfaMethod);
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  const loginId = String(username).trim().toLowerCase();
  const isEmailLogin = validateEmail(loginId);
  const user = isEmailLogin ? await getUserByEmail(loginId) : await getUserByUsername(loginId);
  if (isEmailLogin && user && user.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Employees must login with username.' });
  }

  if (!user || !user.password) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }

  const lockoutUntil = user.lockoutUntil ? new Date(user.lockoutUntil) : null;
  if (lockoutUntil && !Number.isNaN(lockoutUntil.getTime()) && lockoutUntil.getTime() > Date.now()) {
    const remainingMinutes = Math.max(1, Math.ceil((lockoutUntil.getTime() - Date.now()) / 60000));
    return res.status(423).json({
      success: false,
      message: `Account locked due to 3 failed login attempts. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
    });
  }

  if (!bcrypt.compareSync(password, user.password)) {
    const failedAttempts = Number(user.failedLoginAttempts || 0) + 1;
    const shouldLock = failedAttempts >= LOGIN_LOCKOUT_THRESHOLD;
    const nextLockoutUntil = shouldLock ? new Date(Date.now() + LOGIN_LOCKOUT_DURATION_MS) : null;

    await updateUserLoginSecurity(user.email, {
      failedLoginAttempts: shouldLock ? LOGIN_LOCKOUT_THRESHOLD : failedAttempts,
      lockoutUntil: nextLockoutUntil,
    });

    return res.status(401).json({
      success: false,
      message: shouldLock
        ? 'Account locked due to 3 failed login attempts. Please try again in 15 minutes.'
        : `Invalid username or password. ${LOGIN_LOCKOUT_THRESHOLD - failedAttempts} attempt${LOGIN_LOCKOUT_THRESHOLD - failedAttempts === 1 ? '' : 's'} left before lockout.`,
    });
  }

  await resetUserLoginSecurity(user.email);

  try {
    return res.json(await buildMfaResponse(user, mfaMethod));
  } catch (error) {
    console.error('Failed to start MFA challenge:', error);
    return res.status(500).json({ success: false, message: error.message || 'Unable to start MFA verification.' });
  }
});

app.post('/api/auth/mfa/verify', async (req, res) => {
  const { challengeToken, code } = req.body;
  const challenge = verifyMfaChallenge(challengeToken);
  if (!challenge) {
    return res.status(401).json({ success: false, message: 'MFA challenge expired. Please login again.' });
  }

  const user = await getUserByEmail(challenge.email);
  if (!user) {
    return res.status(401).json({ success: false, message: 'MFA setup is not available. Please login again.' });
  }

  const method = normalizeMfaMethod(challenge.method || user.mfaMethod);
  if (method === 'authenticator') {
    if (!user.mfaSecret) {
      return res.status(401).json({ success: false, message: 'MFA setup is not available. Please login again.' });
    }

    if (!verifyTotp(user.mfaSecret, code)) {
      return res.status(401).json({ success: false, message: 'Invalid authenticator code.' });
    }
  } else if (!verifyStoredMfaCode(user, code)) {
    return res.status(401).json({ success: false, message: `Invalid ${method.toUpperCase()} code.` });
  }

  await updateUserMfa(user.email, user.mfaSecret, true, {
    method,
    codeHash: method === 'authenticator' ? null : '',
    codeExpiresAt: null,
  });

  return res.json({ success: true, user: safeAuthUser(user), sessionToken: createAuthSession(user) });
});

app.get('/api/auth/me', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }

  const user = await getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  return res.json({ success: true, user: safeAuthUser(user) });
});

async function isAdminUser(email) {
  if (!email) return false;
  const user = await getUserByEmail(email.toLowerCase());
  return !!user && user.role === 'admin';
}

async function requireAdmin(req, res) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    res.status(401).json({ success: false, message: 'Valid admin session is required.' });
    return null;
  }

  const isAdmin = await isAdminUser(session.email);
  if (!isAdmin || session.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin privileges required.' });
    return null;
  }

  return session.email;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysAgoDate(days) {
  const now = new Date();
  const safeDays = Math.max(Number(days) || 30, 1);
  return new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
}

app.get('/api/admin/users', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const users = await getUsers();
  const safeUsers = users.map(u => ({
    id: u.id,
    username: u.username || '',
    name: u.name,
    email: u.email,
    role: u.role || 'employee',
    department: u.department || '',
    position: u.position || '',
    phone: u.phone || '',
    gender: u.gender || '',
    profileImage: u.profileImage || '',
    employeeId: u.employeeId || '',
    employmentStatus: u.employmentStatus || '',
    dateHired: u.dateHired || '',
    contactInfo: u.contactInfo || '',
    address: u.address || '',
    emergencyContact: u.emergencyContact || '',
  }));
  return res.json({ success: true, users: safeUsers });
});

app.post('/api/admin/users', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const { name, username, email, password, role = 'employee', surname = '', firstName = '', middleName = '', suffix = '', birthday = '', gender = '' } = req.body;
  if (!email || !name || !role) {
    return res.status(400).json({ success: false, message: 'Name, email, and role are required.' });
  }

  const normalizedEmail = email.toLowerCase();
  const normalizedUsername = String(username || email.split('@')[0] || '').trim().toLowerCase();
  if (normalizedUsername && !validateUsername(normalizedUsername)) {
    return res.status(400).json({ success: false, message: 'Username must be 3-30 characters and use only letters, numbers, dots, underscores, or hyphens.' });
  }
  const existingUser = await getUserByEmail(normalizedEmail);
  if (existingUser) {
    return res.status(409).json({ success: false, message: 'User already exists.' });
  }
  if (normalizedUsername && await getUserByUsername(normalizedUsername)) {
    return res.status(409).json({ success: false, message: 'Username is already taken.' });
  }

  const hashedPassword = password ? bcrypt.hashSync(password, 10) : '';
  const user = await createUser({
    name,
    username: normalizedUsername,
    surname,
    firstName,
    middleName,
    suffix,
    email: normalizedEmail,
    birthday,
    password: hashedPassword,
    gender,
    role,
    google: false,
  });

  return res.json({ success: true, user: { email: user.email, name: user.name, role: user.role || role } });
});

app.put('/api/admin/users/:id/role', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const userId = Number(req.params.id);
  const { role } = req.body;
  if (!userId || !role) {
    return res.status(400).json({ success: false, message: 'User id and role are required.' });
  }

  const user = await getUserById(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const updatedUser = await updateUserRole(userId, role);
  return res.json({ success: true, user: { id: updatedUser.id, email: updatedUser.email, name: updatedUser.name, role: updatedUser.role || 'employee' } });
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'User id is required.' });
  }

  const deletedUser = await deleteUser(userId);
  if (!deletedUser) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  return res.json({ success: true, user: { id: deletedUser.id, email: deletedUser.email, name: deletedUser.name } });
});

app.get('/api/admin/reports/summary', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const days = Math.max(Number(req.query.days) || 30, 1);
  const departmentFilter = String(req.query.department || '').trim().toLowerCase();
  const since = daysAgoDate(days);
  const now = new Date();
  const futureUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const users = await getUsers();
  const scopedUsers = users.filter(user => {
    if (!departmentFilter) return true;
    return String(user.department || '').trim().toLowerCase() === departmentFilter;
  });

  const userData = await Promise.all(
    scopedUsers.map(async (user) => {
      const email = String(user.email || '').toLowerCase();
      const [leaves, trainings, attendance] = await Promise.all([
        getLeaves(email),
        getTrainings(email),
        getAttendance(email),
      ]);
      return { user, leaves: leaves || [], trainings: trainings || [], attendance: attendance || [] };
    })
  );

  let pendingLeaves = 0;
  let approvedLeaves = 0;
  let rejectedLeaves = 0;
  let upcomingTrainings = 0;
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  const recentLeaves = [];

  userData.forEach(({ user, leaves, trainings, attendance }) => {
    leaves.forEach((item) => {
      const startRaw = item.start || item.startDate;
      const startDate = parseDateOrNull(startRaw);
      if (startDate && startDate >= since) {
        const status = String(item.status || 'Pending');
        if (status === 'Pending') pendingLeaves += 1;
        if (status === 'Approved') approvedLeaves += 1;
        if (status === 'Rejected') rejectedLeaves += 1;
      }

      recentLeaves.push({
        id: Number(item.id),
        employeeEmail: user.email,
        employeeName: user.name || user.email,
        type: item.type,
        start: startRaw,
        end: item.end || item.endDate,
        days: Number(item.days || 0),
        status: item.status || 'Pending',
      });
    });

    trainings.forEach((item) => {
      const trainingStart = parseDateOrNull(item.start || item.startDate);
      if (trainingStart && trainingStart >= now && trainingStart <= futureUntil) {
        upcomingTrainings += 1;
      }
    });

    attendance.forEach((item) => {
      const attendanceDate = parseDateOrNull(item.date);
      if (!attendanceDate || attendanceDate < since) return;
      const status = String(item.status || '').toLowerCase();
      if (status === 'present') presentCount += 1;
      else if (status === 'late') lateCount += 1;
      else if (status === 'absent') absentCount += 1;
    });
  });

  const attendanceTotal = presentCount + lateCount + absentCount;
  const attendancePresentRate = attendanceTotal ? Math.round((presentCount / attendanceTotal) * 100) : 0;

  recentLeaves.sort((a, b) => {
    const da = parseDateOrNull(a.start);
    const db = parseDateOrNull(b.start);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  return res.json({
    success: true,
    summary: {
      rangeDays: days,
      department: departmentFilter,
      generatedAt: new Date().toISOString(),
      metrics: {
        totalEmployees: scopedUsers.length,
        pendingLeaves,
        approvedLeaves,
        rejectedLeaves,
        upcomingTrainings,
        attendancePresentRate,
        presentCount,
        lateCount,
        absentCount,
      },
      recentLeaves: recentLeaves.slice(0, 10),
    },
  });
});

app.get('/api/admin/audit-logs', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const items = await getAuditLogs(limit);
  return res.json({ success: true, items });
});

app.post('/api/admin/audit-logs', async (req, res) => {
  const requesterEmail = await requireAdmin(req, res);
  if (!requesterEmail) return;

  const { action, target = '', details = '', timestamp } = req.body;
  if (!action) {
    return res.status(400).json({ success: false, message: 'action is required.' });
  }

  const item = await createAuditLog({
    id: Date.now(),
    adminEmail: requesterEmail,
    action,
    target,
    details,
    timestamp: timestamp || new Date().toISOString(),
  });

  return res.json({ success: true, item });
});

app.get('/api/hr/announcements', async (req, res) => {
  const visibleOnly = String(req.query.visibleOnly || '') === '1';
  const items = await getAnnouncements();
  const filtered = visibleOnly ? items.filter(item => item.visible !== false && item.visible !== 0) : items;
  return res.json({ success: true, items: filtered });
});

app.post('/api/hr/announcements', async (req, res) => {
  const { id, title, description, image, visible, date, createdByEmail } = req.body;
  if (!id || !title || !description || !date) {
    return res.status(400).json({ success: false, message: 'id, title, description, and date are required.' });
  }

  const item = await createAnnouncement({ id, title, description, image, visible: visible !== false, date, createdByEmail });
  return res.json({ success: true, item });
});

app.put('/api/hr/announcements/:id/visibility', async (req, res) => {
  const visible = !!req.body.visible;
  const item = await updateAnnouncementVisibility(req.params.id, visible);
  if (!item) {
    return res.status(404).json({ success: false, message: 'Announcement not found.' });
  }
  return res.json({ success: true, item });
});

app.delete('/api/hr/announcements/:id', async (req, res) => {
  await deleteAnnouncement(req.params.id);
  return res.json({ success: true });
});

app.get('/api/hr/leaves', async (req, res) => {
  const email = req.query.email ? String(req.query.email).toLowerCase() : '';
  const items = await getLeaves(email || null);
  return res.json({ success: true, items });
});

app.put('/api/hr/leaves', async (req, res) => {
  const { email, items = [] } = req.body;
  const normalizedEmail = String(email || '').toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const saved = await upsertLeavesForEmployee(normalizedEmail, items);
  return res.json({ success: true, items: saved });
});

app.put('/api/hr/leaves/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ success: false, message: 'status is required.' });
  }

  const leave = await updateLeaveStatus(req.params.id, status);
  if (!leave) {
    return res.status(404).json({ success: false, message: 'Leave record not found.' });
  }

  return res.json({ success: true, leave });
});

app.get('/api/hr/attendance', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const items = await getAttendance(email);
  return res.json({ success: true, items });
});

app.put('/api/hr/attendance', async (req, res) => {
  const { email, items = [] } = req.body;
  const normalizedEmail = String(email || '').toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const saved = await upsertAttendanceForEmployee(normalizedEmail, items);
  return res.json({ success: true, items: saved });
});

app.get('/api/hr/trainings', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const items = await getTrainings(email);
  return res.json({ success: true, items });
});

app.put('/api/hr/trainings', async (req, res) => {
  const { email, items = [] } = req.body;
  const normalizedEmail = String(email || '').toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const saved = await upsertTrainingsForEmployee(normalizedEmail, items);
  return res.json({ success: true, items: saved });
});

app.get('/api/hr/evaluations', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const item = await getEvaluation(email);
  return res.json({ success: true, item });
});

app.put('/api/hr/evaluations', async (req, res) => {
  const { email, status } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const item = await upsertEvaluation(String(email).toLowerCase(), status || '');
  return res.json({ success: true, item });
});

app.get('/api/hr/snapshot', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const [leaveRows, trainingRows, attendanceRows, evaluationRow, announcementRows, profile] = await Promise.all([
    getLeaves(email),
    getTrainings(email),
    getAttendance(email),
    getEvaluation(email),
    getAnnouncements(),
    getUserProfile(email),
  ]);

  const leaves = leaveRows.map(row => ({
    id: Number(row.id),
    type: row.type,
    start: row.start || row.startDate,
    end: row.end || row.endDate,
    days: Number(row.days || 0),
    status: row.status || 'Pending',
    medicalCertificate: row.medicalCertificate ? (typeof row.medicalCertificate === 'string' ? JSON.parse(row.medicalCertificate) : row.medicalCertificate) : null,
  }));

  const trainings = trainingRows.map(row => ({
    id: Number(row.id),
    title: row.title,
    start: row.start || row.startDate,
    end: row.end || row.endDate,
    hours: row.hours,
    type: row.type,
    sponsor: row.sponsor,
    conductedBy: row.conductedBy || row.sponsor,
    status: row.status || '',
    certificate: row.certificate ? (typeof row.certificate === 'string' ? (() => { try { return JSON.parse(row.certificate); } catch (_) { return null; } })() : row.certificate) : null,
  }));

  const attendance = attendanceRows.map(row => ({
    id: Number(row.id),
    date: row.date,
    timeIn: row.timeIn || '',
    timeOut: row.timeOut || '',
    status: row.status,
    photo: row.photo || '',
  }));

  const announcements = announcementRows
    .filter(item => item.visible !== false && item.visible !== 0)
    .map(item => ({
    id: Number(item.id),
    title: item.title,
    description: item.description,
    image: item.image || '',
    date: item.date,
  }));

  return res.json({
    success: true,
    snapshot: {
      leaves,
      trainings,
      attendance,
      evaluation: {
        status: (evaluationRow && evaluationRow.status) || '',
        updatedAt: (evaluationRow && evaluationRow.updatedAt) || null,
      },
      announcements,
      pdsData: (profile && profile.pdsData) || {},
    }
  });
});

app.put('/api/hr/snapshot', async (req, res) => {
  const { email, leaves = [], trainings = [], attendance = [], evaluation = { status: '' }, pdsData = {} } = req.body;
  const normalizedEmail = String(email || '').toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  await Promise.all([
    upsertLeavesForEmployee(normalizedEmail, leaves),
    upsertTrainingsForEmployee(normalizedEmail, trainings),
    upsertAttendanceForEmployee(normalizedEmail, attendance),
    upsertEvaluation(normalizedEmail, (evaluation && evaluation.status) || ''),
    upsertUserProfile(normalizedEmail, { pdsData }),
  ]);

  return res.json({ success: true });
});

app.get('/api/hr/leave-comments', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  const leaveId = Number(req.query.leaveId);
  if (!email || !leaveId) {
    return res.status(400).json({ success: false, message: 'email and leaveId are required.' });
  }

  const items = await getLeaveComments(email, leaveId);
  return res.json({ success: true, items });
});

app.post('/api/hr/leave-comments', async (req, res) => {
  const { id, leaveId, employeeEmail, text, date, createdByEmail, createdByRole } = req.body;
  if (!id || !leaveId || !employeeEmail || !text) {
    return res.status(400).json({ success: false, message: 'id, leaveId, employeeEmail, and text are required.' });
  }

  const item = await createLeaveComment({ id, leaveId, employeeEmail, text, date, createdByEmail, createdByRole });
  return res.json({ success: true, item });
});

app.delete('/api/hr/leave-comments/:id', async (req, res) => {
  await deleteLeaveComment(req.params.id);
  return res.json({ success: true });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  const mfaMethod = normalizeMfaMethod(req.body.mfaMethod);
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ success: false, message: 'Google Sign-In is not configured. Set GOOGLE_CLIENT_ID in .env to a real OAuth web client ID, then restart the server.' });
  }

  if (!credential) {
    return res.status(400).json({ success: false, message: 'Google credential is required.' });
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid Google credential.' });
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    return res.status(400).json({ success: false, message: 'Google token did not contain an email.' });
  }

  const email = payload.email.toLowerCase();
  let user = await getUserByEmail(email);

  if (!user) {
    const nameParts = (payload.name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const surname = nameParts.slice(1).join(' ') || '';

    user = await createUser({
      name: payload.name || email,
      username: await generateAvailableUsername(email, 'googleuser'),
      surname,
      firstName,
      middleName: '',
      suffix: '',
      email,
      birthday: '',
      password: '',
      gender: '',
      role: 'employee',
      google: true,
    });
  }

  try {
    return res.json(await buildMfaResponse(user, mfaMethod));
  } catch (error) {
    console.error('Failed to start MFA challenge:', error);
    return res.status(500).json({ success: false, message: error.message || 'Unable to start MFA verification.' });
  }
});

app.get('/api/users/profile', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const profile = await getUserProfile(email);
  if (!profile) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  return res.json({ success: true, profile });
});

app.put('/api/users/profile', async (req, res) => {
  const { email, username, name, department, position, phone, profileImage, gender, newPassword, pdsData, employeeProfile } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ success: false, message: 'email is required.' });
  }

  const user = await getUserByEmail(normalizedEmail);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  if (username !== undefined) {
    const normalizedUsername = String(username || '').trim().toLowerCase();
    if (normalizedUsername && !validateUsername(normalizedUsername)) {
      return res.status(400).json({ success: false, message: 'Username must be 3-30 characters and use only letters, numbers, dots, underscores, or hyphens.' });
    }

    if (normalizedUsername) {
      const existingUsername = await getUserByUsername(normalizedUsername);
      if (existingUsername && Number(existingUsername.id) !== Number(user.id)) {
        return res.status(409).json({ success: false, message: 'Username is already taken.' });
      }
      if (String(user.username || '').toLowerCase() !== normalizedUsername) {
        await updateUserUsername(user.id, normalizedUsername);
      }
    }
  }

  if (newPassword) {
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const hashed = bcrypt.hashSync(String(newPassword), 10);
    await updateUserPassword(normalizedEmail, hashed);
  }

  const profile = await upsertUserProfile(normalizedEmail, {
    name: name !== undefined ? String(name).trim() : undefined,
    department: department !== undefined ? String(department).trim() : undefined,
    position: position !== undefined ? String(position).trim() : undefined,
    phone: phone !== undefined ? String(phone).trim() : undefined,
    profileImage: profileImage !== undefined ? profileImage : undefined,
    gender: gender !== undefined ? String(gender).trim() : undefined,
    pdsData: {
      ...(pdsData && typeof pdsData === 'object' ? pdsData : {}),
      ...(employeeProfile && typeof employeeProfile === 'object' ? { employeeProfile } : {}),
    },
  });

  return res.json({ success: true, profile });
});

// Download PDS file as PDF
app.get('/api/pds/download/:email', async (req, res) => {
  try {
    // Verify authentication
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const sessionEmail = getSession === 'function' ? getSession() : null;
    
    // Get requesting user's email from session
    const email = String(req.query.email || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email parameter required' });
    }

    // Get user profile with PDS data
    const profile = await getUserProfile(email);
    if (!profile || !profile.pdsData) {
      return res.status(404).json({ success: false, message: 'PDS data not found' });
    }

    const pdsData = profile.pdsData || {};
    const latestUpload = pdsData.latestUpload || null;
    
    if (!latestUpload || !latestUpload.fileData) {
      return res.status(404).json({ success: false, message: 'No PDS file available for download' });
    }

    // Check if file is already PDF
    const fileName = latestUpload.fileName || 'pds.pdf';
    const fileType = latestUpload.fileType || 'application/pdf';
    const fileData = latestUpload.fileData;

    // If the file is already a data URL, extract the base64 part
    let base64Data = fileData;
    if (fileData.startsWith('data:')) {
      const matches = fileData.match(/data:([^;]+);base64,(.+)/);
      if (matches && matches[2]) {
        base64Data = matches[2];
      }
    }

    const buffer = Buffer.from(base64Data, 'base64');
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName.replace(/\.[^.]+$/, '.pdf'))}"`);
    res.setHeader('Content-Length', buffer.length);
    
    res.send(buffer);
  } catch (error) {
    console.error('Error downloading PDS:', error);
    res.status(500).json({ success: false, message: 'Failed to download PDS file' });
  }
});

app.use(express.static(path.join(__dirname, '..')));

// Global error handler for unhandled promise rejections
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

async function startServer() {
  validateDeploymentConfig();
  await initializeDatabase();
  await ensureAdminAccounts();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CHRIS Website backend started on port ${PORT}`);

    if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID') {
      console.warn('WARNING: Google authentication is disabled until ENABLE_GOOGLE_AUTH=true and a valid GOOGLE_CLIENT_ID are set.');
    }

    if (isUsingFileFallback()) {
      console.warn('Using local JSON fallback store. Set USE_MYSQL=true with valid DB settings to use MySQL in production.');
    }

    if (!isSmtpConfigured()) {
      console.warn('Email MFA SMTP is not fully configured. Set real SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM values before using email codes.');
    }
  });

  server.on('error', (error) => {
    throw error;
  });
}

function safeAuthUser(user) {
  return { email: user.email, username: user.username || '', name: user.name, role: user.role || 'employee' };
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', MFA_CHALLENGE_SECRET).update(payload).digest('base64url');
}

function createMfaChallenge(email, method = 'authenticator') {
  const payload = JSON.stringify({
    email: String(email || '').toLowerCase(),
    method: normalizeMfaMethod(method),
    exp: Date.now() + MFA_CHALLENGE_TTL_MS,
    purpose: 'mfa-login',
  });
  const encodedPayload = base64UrlEncode(payload);
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function createAuthSession(user) {
  const payload = JSON.stringify({
    email: String(user.email || '').toLowerCase(),
    role: user.role || 'employee',
    exp: Date.now() + AUTH_SESSION_TTL_MS,
    purpose: 'auth-session',
  });
  const encodedPayload = base64UrlEncode(payload);
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function verifyAuthSession(token) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signPayload(encodedPayload);
  const given = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_) {
    return null;
  }

  if (payload.purpose !== 'auth-session' || !payload.email || Number(payload.exp || 0) < Date.now()) return null;
  return payload;
}

async function getAuthenticatedSession(req) {
  const authHeader = String(req.headers.authorization || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const session = verifyAuthSession(match ? match[1] : '');
  if (!session) return null;

  const user = await getUserByEmail(String(session.email || '').toLowerCase());
  if (!user) return null;
  return {
    email: String(user.email || '').toLowerCase(),
    role: user.role || 'employee',
    user,
  };
}

function verifyMfaChallenge(token) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signPayload(encodedPayload);
  const given = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_) {
    return null;
  }

  if (payload.purpose !== 'mfa-login' || !payload.email || Number(payload.exp || 0) < Date.now()) return null;
  return payload;
}

function generateBase32Secret(length = 32) {
  const bytes = crypto.randomBytes(length);
  let output = '';
  for (const byte of bytes) {
    output += BASE32_ALPHABET[byte % BASE32_ALPHABET.length];
  }
  return output;
}

function base32ToBuffer(secret) {
  const clean = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, stepOffset = 0) {
  const timeStep = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const hmac = crypto.createHmac('sha1', base32ToBuffer(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code) {
  const normalizedCode = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) return false;
  return [-1, 0, 1].some((offset) => generateTotp(secret, offset) === normalizedCode);
}

function generateMfaCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashMfaCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function verifyStoredMfaCode(user, code) {
  const normalizedCode = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedCode) || !user.mfaCodeHash) return false;

  const expiresAt = new Date(user.mfaCodeExpiresAt || 0).getTime();
  if (!expiresAt || expiresAt < Date.now()) return false;

  const expected = Buffer.from(String(user.mfaCodeHash), 'hex');
  const given = Buffer.from(hashMfaCode(normalizedCode), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

async function sendMfaCode(user, method, code) {
  if (method !== 'email') {
    throw new Error('Unsupported MFA method.');
  }

  if (!isSmtpConfigured()) {
    if (EMAIL_MFA_DEV_MODE || process.env.NODE_ENV !== 'production') {
      console.warn(`[MFA] Email SMTP is not configured. Development code for ${user.email}: ${code}`);
      return `Email MFA is in development mode. Use the code printed in the server console for ${user.email}.`;
    }

    throw new Error('Email MFA is not configured. Set real SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM values. For SendGrid, use SMTP_USER=apikey, SMTP_PASS=<SendGrid API key>, and a verified sender in SMTP_FROM.');
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER || SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });

  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject: `${MFA_ISSUER} verification code`,
      text: `Your ${MFA_ISSUER} verification code is ${code}. It expires in 5 minutes.`,
    });
  } catch (error) {
    console.error('Failed to send email MFA code:', {
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode,
    });
    throw new Error('Email MFA could not send. Check SMTP credentials, sender verification, and Railway SMTP variables.');
  }

  return `A verification code was sent to ${user.email}.`;
}

function buildOtpAuthUrl(user, secret) {
  const issuer = encodeURIComponent(MFA_ISSUER);
  const account = encodeURIComponent(user.email);
  const cleanSecret = String(secret || '').replace(/\s+/g, '').toUpperCase();
  return `otpauth://totp/${issuer}:${account}?secret=${encodeURIComponent(cleanSecret)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

async function buildMfaResponse(user, selectedMethod) {
  const method = normalizeMfaMethod(selectedMethod || user.mfaMethod);
  let secret = user.mfaSecret || '';
  const setupRequired = method === 'authenticator' && (!secret || !user.mfaEnabled);

  if (method === 'authenticator' && setupRequired) {
    secret = generateBase32Secret();
    await updateUserMfa(user.email, secret, false, { method });
  } else if (method === 'authenticator') {
    await updateUserMfa(user.email, secret, user.mfaEnabled, { method });
  }

  const response = {
    success: true,
    mfaRequired: true,
    mfaSetupRequired: setupRequired,
    mfaMethod: method,
    user: safeAuthUser(user),
    challengeToken: createMfaChallenge(user.email, method),
  };

  if (method === 'authenticator') {
    const otpauthUrl = buildOtpAuthUrl(user, secret);
    response.mfa = {
      method,
      issuer: MFA_ISSUER,
      accountName: user.email,
      secret,
      otpauthUrl,
      qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, {
        errorCorrectionLevel: 'H',
        margin: 4,
        width: 320,
      }),
    };
  } else if (method === 'email') {
    const code = generateMfaCode();
    const expiresAt = new Date(Date.now() + MFA_CODE_TTL_MS);
    await updateUserMfa(user.email, secret, user.mfaEnabled, {
      method,
      codeHash: hashMfaCode(code),
      codeExpiresAt: expiresAt,
    });
    response.mfa = {
      method,
      email: user.email,
      deliveryMessage: await sendMfaCode(user, method, code),
    };
  }

  return response;
}

startServer().catch(error => {
  console.error('Failed to start backend:', error);
  process.exit(1);
});
