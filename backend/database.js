require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const {
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_USER = '',
  DB_PASSWORD,
  DB_NAME,
  REQUIRE_MYSQL,
  USE_MYSQL,
} = process.env;

const DB_PASSWORD_SET = Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD');
const mysqlMode = String(USE_MYSQL || '').trim().toLowerCase();
const mysqlDisabled = mysqlMode === 'false';
const mysqlEnabled = mysqlMode === 'true';
const requireMysql = String(REQUIRE_MYSQL || '').trim().toLowerCase() === 'true' || mysqlEnabled;
const missingMysqlConfig = !DB_USER || !DB_NAME || !DB_PASSWORD_SET || DB_USER === 'your_mysql_user' || DB_PASSWORD === 'your_mysql_password';
let useFileFallback = mysqlDisabled || !mysqlEnabled || missingMysqlConfig;

let pool = null;
if (useFileFallback && requireMysql) {
  throw new Error('MySQL is enabled but database settings are incomplete. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_NAME, or set USE_MYSQL=false to use the local JSON store.');
}

if (!useFileFallback) {
  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
} else {
  console.warn('MySQL is not configured. Using local JSON fallback store for data.');
}

const STORE_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(STORE_DIR, 'local-db.json');

function isUsingFileFallback() {
  return useFileFallback;
}

function isConnectionUnavailable(error) {
  return ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error && error.code);
}

function shouldFallbackToFileStore(error) {
  return isConnectionUnavailable(error) || error?.code === 'ER_ACCESS_DENIED_ERROR';
}

function formatDateOnly(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    return value.includes('T') ? value.slice(0, 10) : value.slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function normalizeLeaveRow(row) {
  if (!row) return row;
  const startDate = formatDateOnly(row.startDate || row.start);
  const endDate = formatDateOnly(row.endDate || row.end);
  return {
    ...row,
    startDate,
    endDate,
    start: formatDateOnly(row.start || startDate),
    end: formatDateOnly(row.end || endDate),
  };
}

function normalizeAttendanceRow(row) {
  if (!row) return row;
  return {
    ...row,
    date: formatDateOnly(row.date),
    timeIn: row.timeIn || '',
    timeOut: row.timeOut || '',
    photo: row.photo || '',
  };
}

function normalizeTrainingRow(row) {
  if (!row) return row;
  const startDate = formatDateOnly(row.startDate || row.start);
  const endDate = formatDateOnly(row.endDate || row.end);
  return {
    ...row,
    startDate,
    endDate,
    start: formatDateOnly(row.start || startDate),
    end: formatDateOnly(row.end || endDate),
  };
}

function isMysqlSchemaStorageCorrupt(error) {
  return isMysqlTableMissingFromEngine(error) || isMysqlTablespaceOrphaned(error);
}

async function initializeDatabase() {
  if (useFileFallback || !pool) {
    ensureStorePath();
    return;
  }

  try {
    const connection = await pool.getConnection();
    connection.release();
    await ensureMysqlSchema();
  } catch (error) {
    if (requireMysql) {
      throw error;
    }

    if (!shouldFallbackToFileStore(error) && !isMysqlSchemaStorageCorrupt(error)) {
      throw error;
    }

    if (error?.code === 'ER_ACCESS_DENIED_ERROR') {
      console.warn(`MySQL authentication failed for ${DB_USER}@${DB_HOST}:${DB_PORT}. Using local JSON fallback store for data.`);
    } else if (isConnectionUnavailable(error)) {
      console.warn(`MySQL is unavailable at ${DB_HOST}:${DB_PORT} (${error.code}). Using local JSON fallback store for data.`);
    } else {
      console.warn(`MySQL schema ${DB_NAME} appears to have corrupted table metadata or orphaned tablespaces (${error.code || error.errno}). Using local JSON fallback store for data.`);
      console.warn('Repair MySQL by removing the orphaned table tablespace from the MySQL data directory, then restart the backend to use MySQL again.');
    }
    useFileFallback = true;
    try {
      await pool.end();
    } catch (_) {
      // Ignore cleanup errors while falling back to the local JSON store.
    }
    pool = null;
    ensureStorePath();
  }
}

async function ensureMysqlSchema() {
  const tableStatements = {
    users: `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) UNIQUE,
      name VARCHAR(255) NOT NULL,
      surname VARCHAR(255) NOT NULL,
      firstName VARCHAR(255) NOT NULL,
      middleName VARCHAR(255),
      suffix VARCHAR(50),
      email VARCHAR(255) NOT NULL UNIQUE,
      birthday DATE,
      password VARCHAR(255),
      gender VARCHAR(50),
      role VARCHAR(50) NOT NULL DEFAULT 'employee',
      google BOOLEAN NOT NULL DEFAULT FALSE,
      mfaSecret VARCHAR(64),
      mfaMethod VARCHAR(20) NOT NULL DEFAULT 'authenticator',
      mfaCodeHash VARCHAR(255),
      mfaCodeExpiresAt DATETIME,
      mfaEnabled BOOLEAN NOT NULL DEFAULT FALSE,
      failedLoginAttempts INT NOT NULL DEFAULT 0,
      lockoutUntil DATETIME
    )`,
    user_profiles: `CREATE TABLE IF NOT EXISTS user_profiles (
      email VARCHAR(255) PRIMARY KEY,
      department VARCHAR(255),
      position VARCHAR(255),
      phone VARCHAR(50),
      profileImage LONGTEXT,
      pdsData LONGTEXT,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    announcements: `CREATE TABLE IF NOT EXISTS announcements (
      id BIGINT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      image LONGTEXT,
      visible BOOLEAN NOT NULL DEFAULT TRUE,
      date VARCHAR(20) NOT NULL,
      createdByEmail VARCHAR(255),
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    leaves: `CREATE TABLE IF NOT EXISTS leaves (
      id BIGINT PRIMARY KEY,
      employeeEmail VARCHAR(255) NOT NULL,
      type VARCHAR(100) NOT NULL,
      startDate DATE NOT NULL,
      endDate DATE NOT NULL,
      days INT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Pending',
      medicalCertificate LONGTEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_leaves_employee_email (employeeEmail)
    )`,
    attendance: `CREATE TABLE IF NOT EXISTS attendance (
      id BIGINT PRIMARY KEY,
      employeeEmail VARCHAR(255) NOT NULL,
      date DATE NOT NULL,
      timeIn VARCHAR(20),
      timeOut VARCHAR(20),
      status VARCHAR(50) NOT NULL,
      photo LONGTEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_attendance_employee_email (employeeEmail)
    )`,
    trainings: `CREATE TABLE IF NOT EXISTS trainings (
      id BIGINT PRIMARY KEY,
      employeeEmail VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      startDate DATE,
      endDate DATE,
      hours VARCHAR(50),
      type VARCHAR(100),
      sponsor VARCHAR(255),
      status VARCHAR(50),
      certificate LONGTEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_trainings_employee_email (employeeEmail)
    )`,
    evaluations: `CREATE TABLE IF NOT EXISTS evaluations (
      employeeEmail VARCHAR(255) PRIMARY KEY,
      status VARCHAR(100) NOT NULL,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    leave_comments: `CREATE TABLE IF NOT EXISTS leave_comments (
      id BIGINT PRIMARY KEY,
      leaveId BIGINT NOT NULL,
      employeeEmail VARCHAR(255) NOT NULL,
      text TEXT NOT NULL,
      date VARCHAR(100) NOT NULL,
      createdByEmail VARCHAR(255),
      createdByRole VARCHAR(50),
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_leave_comments_employee_leave (employeeEmail, leaveId)
    )`,
    audit_logs: `CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT PRIMARY KEY,
      adminEmail VARCHAR(255) NOT NULL,
      action VARCHAR(255) NOT NULL,
      target VARCHAR(255),
      details TEXT,
      timestamp DATETIME NOT NULL,
      INDEX idx_audit_logs_timestamp (timestamp)
    )`,
  };

  for (const [table, statement] of Object.entries(tableStatements)) {
    await createMysqlTable(table, statement);
    await ensureMysqlTableUsable(table, statement);
  }

  await ensureMysqlColumns();
}

function isMysqlTableMissingFromEngine(error) {
  const message = String(error && (error.sqlMessage || error.message) || '').toLowerCase();
  return Number(error && error.errno) === 1932 || message.includes("doesn't exist in engine");
}

function isMysqlTablespaceOrphaned(error) {
  return Number(error && error.errno) === 1813 || error?.code === 'ER_TABLESPACE_EXISTS';
}

async function createMysqlTable(table, createStatement) {
  try {
    await pool.execute(createStatement);
  } catch (error) {
    if (!isMysqlTablespaceOrphaned(error)) {
      throw error;
    }

    console.warn(`MySQL table ${DB_NAME}.${table} has an orphaned tablespace. Discarding it before recreating the table.`);
    try {
      await pool.execute(`ALTER TABLE \`${table}\` DISCARD TABLESPACE`);
    } catch (discardError) {
      if (discardError?.code === 'ER_NO_SUCH_TABLE') {
        throw error;
      }
      throw discardError;
    }
    await pool.execute(`DROP TABLE IF EXISTS \`${table}\``);
    await pool.execute(createStatement);
  }
}

async function ensureMysqlTableUsable(table, createStatement) {
  try {
    await pool.execute(`SELECT 1 FROM \`${table}\` LIMIT 1`);
  } catch (error) {
    if (!isMysqlTableMissingFromEngine(error)) {
      throw error;
    }

    console.warn(`MySQL table ${DB_NAME}.${table} exists in metadata but is missing from the storage engine. Recreating it.`);
    await pool.execute(`DROP TABLE IF EXISTS \`${table}\``);
    await createMysqlTable(table, createStatement);
  }
}

async function ensureMysqlColumns() {
  const tableColumns = {
    users: [
      ['username', 'VARCHAR(100) UNIQUE'],
      ['name', 'VARCHAR(255)'],
      ['surname', 'VARCHAR(255)'],
      ['firstName', 'VARCHAR(255)'],
      ['middleName', 'VARCHAR(255)'],
      ['suffix', 'VARCHAR(50)'],
      ['email', 'VARCHAR(255)'],
      ['birthday', 'DATE'],
      ['password', 'VARCHAR(255)'],
      ['gender', 'VARCHAR(50)'],
      ['role', "VARCHAR(50) NOT NULL DEFAULT 'employee'"],
      ['google', 'BOOLEAN NOT NULL DEFAULT FALSE'],
      ['mfaSecret', 'VARCHAR(64)'],
      ['mfaMethod', "VARCHAR(20) NOT NULL DEFAULT 'authenticator'"],
      ['mfaCodeHash', 'VARCHAR(255)'],
      ['mfaCodeExpiresAt', 'DATETIME'],
      ['mfaEnabled', 'BOOLEAN NOT NULL DEFAULT FALSE'],
      ['failedLoginAttempts', 'INT NOT NULL DEFAULT 0'],
      ['lockoutUntil', 'DATETIME'],
    ],
    user_profiles: [
      ['department', 'VARCHAR(255)'],
      ['position', 'VARCHAR(255)'],
      ['phone', 'VARCHAR(50)'],
      ['profileImage', 'LONGTEXT'],
      ['pdsData', 'LONGTEXT'],
      ['updatedAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ],
    announcements: [
      ['title', 'VARCHAR(255)'],
      ['description', 'TEXT'],
      ['image', 'LONGTEXT'],
      ['visible', 'BOOLEAN NOT NULL DEFAULT TRUE'],
      ['date', 'VARCHAR(20)'],
      ['createdByEmail', 'VARCHAR(255)'],
      ['createdAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ],
    leaves: [
      ['employeeEmail', 'VARCHAR(255)'],
      ['type', 'VARCHAR(100)'],
      ['startDate', 'DATE'],
      ['endDate', 'DATE'],
      ['days', 'INT NOT NULL DEFAULT 0'],
      ['status', "VARCHAR(50) NOT NULL DEFAULT 'Pending'"],
      ['medicalCertificate', 'LONGTEXT'],
      ['createdAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ],
    attendance: [
      ['employeeEmail', 'VARCHAR(255)'],
      ['date', 'DATE'],
      ['timeIn', 'VARCHAR(20)'],
      ['timeOut', 'VARCHAR(20)'],
      ['status', 'VARCHAR(50)'],
      ['photo', 'LONGTEXT'],
      ['createdAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ],
    trainings: [
      ['employeeEmail', 'VARCHAR(255)'],
      ['title', 'VARCHAR(255)'],
      ['startDate', 'DATE'],
      ['endDate', 'DATE'],
      ['hours', 'VARCHAR(50)'],
      ['type', 'VARCHAR(100)'],
      ['sponsor', 'VARCHAR(255)'],
      ['status', 'VARCHAR(50)'],
      ['certificate', 'LONGTEXT'],
      ['createdAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ],
    evaluations: [
      ['status', 'VARCHAR(100) NOT NULL'],
      ['updatedAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ],
    leave_comments: [
      ['leaveId', 'BIGINT'],
      ['employeeEmail', 'VARCHAR(255)'],
      ['text', 'TEXT'],
      ['date', 'VARCHAR(100)'],
      ['createdByEmail', 'VARCHAR(255)'],
      ['createdByRole', 'VARCHAR(50)'],
      ['createdAt', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ],
    audit_logs: [
      ['adminEmail', 'VARCHAR(255)'],
      ['action', 'VARCHAR(255)'],
      ['target', 'VARCHAR(255)'],
      ['details', 'TEXT'],
      ['timestamp', 'DATETIME'],
    ],
  };

  for (const [table, columns] of Object.entries(tableColumns)) {
    for (const [column, definition] of columns) {
      if (!(await mysqlColumnExists(table, column))) {
        await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      }
    }
  }
}

async function mysqlColumnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [DB_NAME, table, column]
  );
  return Number(rows[0]?.count || 0) > 0;
}

function ensureStorePath() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ users: [], userProfiles: [], announcements: [], leaves: [], attendance: [], trainings: [], evaluations: [], leaveComments: [], auditLogs: [] }, null, 2));
  }
}

function readStore() {
  ensureStorePath();
  try {
    const content = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(content || '{}');
    return {
      users: parsed.users || [],
      userProfiles: parsed.userProfiles || [],
      announcements: parsed.announcements || [],
      leaves: parsed.leaves || [],
      attendance: parsed.attendance || [],
      trainings: parsed.trainings || [],
      evaluations: parsed.evaluations || [],
      leaveComments: parsed.leaveComments || [],
      auditLogs: parsed.auditLogs || [],
    };
  } catch (err) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ users: [], userProfiles: [], announcements: [], leaves: [], attendance: [], trainings: [], evaluations: [], leaveComments: [], auditLogs: [] }, null, 2));
    return { users: [], userProfiles: [], announcements: [], leaves: [], attendance: [], trainings: [], evaluations: [], leaveComments: [], auditLogs: [] };
  }
}

function writeStore(store) {
  ensureStorePath();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

async function getUsers() {
  if (useFileFallback) {
    const store = readStore();
    const profilesByEmail = {};
    (store.userProfiles || []).forEach(p => {
      profilesByEmail[p.email] = p;
    });

    const getEmployeeProfile = (pdsData) => {
      const employeeProfile = pdsData && typeof pdsData === 'object' && pdsData.employeeProfile && typeof pdsData.employeeProfile === 'object'
        ? pdsData.employeeProfile
        : {};
      return {
        employeeId: employeeProfile.employeeId || '',
        employmentStatus: employeeProfile.employmentStatus || '',
        dateHired: employeeProfile.dateHired || '',
        contactInfo: employeeProfile.contactInfo || '',
        address: employeeProfile.address || '',
        emergencyContact: employeeProfile.emergencyContact || '',
        profilePhoto: employeeProfile.profilePhoto || '',
      };
    };

    return (store.users || []).map(u => ({
      ...u,
      department: profilesByEmail[u.email]?.department || '',
      position: profilesByEmail[u.email]?.position || '',
      phone: profilesByEmail[u.email]?.phone || '',
      profileImage: profilesByEmail[u.email]?.profileImage || '',
      ...getEmployeeProfile(profilesByEmail[u.email]?.pdsData),
    }));
  }

  const [rows] = await pool.execute('SELECT * FROM users');
  return rows;
}

async function getUserByEmail(email) {
  if (!email) return null;
  const normalizedEmail = email.toLowerCase();

  const getEmployeeProfile = (pdsData) => {
    const employeeProfile = pdsData && typeof pdsData === 'object' && pdsData.employeeProfile && typeof pdsData.employeeProfile === 'object'
      ? pdsData.employeeProfile
      : {};
    return {
      employeeId: employeeProfile.employeeId || '',
      employmentStatus: employeeProfile.employmentStatus || '',
      dateHired: employeeProfile.dateHired || '',
      contactInfo: employeeProfile.contactInfo || '',
      address: employeeProfile.address || '',
      emergencyContact: employeeProfile.emergencyContact || '',
      profilePhoto: employeeProfile.profilePhoto || '',
    };
  };

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.email === normalizedEmail) || null;
    if (!user) return null;
    const profile = (store.userProfiles || []).find(p => p.email === normalizedEmail) || {};
    return {
      ...user,
      department: profile.department || '',
      position: profile.position || '',
      phone: profile.phone || '',
      profileImage: profile.profileImage || '',
      ...getEmployeeProfile(profile.pdsData),
    };
  }

  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
  return rows[0] || null;
}

async function getUserByUsername(username) {
  if (!username) return null;
  const normalizedUsername = String(username).trim().toLowerCase();

  if (useFileFallback) {
    const store = readStore();
    return (store.users || []).find(u => String(u.username || '').toLowerCase() === normalizedUsername) || null;
  }

  const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? LIMIT 1', [normalizedUsername]);
  return rows[0] || null;
}

async function getUserById(id) {
  if (!id) return null;

  if (useFileFallback) {
    const store = readStore();
    return (store.users || []).find(u => u.id === id) || null;
  }

  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function deleteUser(id) {
  const user = await getUserById(id);
  if (!user) return null;
  const normalizedEmail = String(user.email || '').toLowerCase();

  if (useFileFallback) {
    const store = readStore();
    store.users = (store.users || []).filter(item => item.id !== id);
    store.userProfiles = (store.userProfiles || []).filter(item => item.email !== normalizedEmail);
    store.leaves = (store.leaves || []).filter(item => item.employeeEmail !== normalizedEmail);
    store.attendance = (store.attendance || []).filter(item => item.employeeEmail !== normalizedEmail);
    store.trainings = (store.trainings || []).filter(item => item.employeeEmail !== normalizedEmail);
    store.evaluations = (store.evaluations || []).filter(item => item.employeeEmail !== normalizedEmail);
    store.leaveComments = (store.leaveComments || []).filter(item => item.employeeEmail !== normalizedEmail);
    writeStore(store);
    return user;
  }

  await Promise.all([
    pool.execute('DELETE FROM leave_comments WHERE employeeEmail = ?', [normalizedEmail]),
    pool.execute('DELETE FROM evaluations WHERE employeeEmail = ?', [normalizedEmail]),
    pool.execute('DELETE FROM trainings WHERE employeeEmail = ?', [normalizedEmail]),
    pool.execute('DELETE FROM attendance WHERE employeeEmail = ?', [normalizedEmail]),
    pool.execute('DELETE FROM leaves WHERE employeeEmail = ?', [normalizedEmail]),
    pool.execute('DELETE FROM user_profiles WHERE email = ?', [normalizedEmail]),
    pool.execute('DELETE FROM users WHERE id = ?', [id]),
  ]);

  return user;
}

async function updateUserRole(id, role) {
  if (!id || !role) return null;

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.id === id);
    if (!user) return null;
    user.role = role;
    writeStore(store);
    return user;
  }

  await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  return getUserById(id);
}

async function updateUserUsername(id, username) {
  if (!id || !username) return null;
  const normalizedUsername = String(username).trim().toLowerCase();

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.id === id);
    if (!user) return null;
    user.username = normalizedUsername;
    writeStore(store);
    return user;
  }

  await pool.execute('UPDATE users SET username = ? WHERE id = ?', [normalizedUsername, id]);
  return getUserById(id);
}

async function createUser(user) {
  const {
    name,
    username,
    surname,
    firstName,
    middleName,
    suffix,
    email,
    birthday,
    password,
    gender,
    role,
    google,
  } = user;

  if (useFileFallback) {
    const store = readStore();
    const users = store.users || [];
    const nextId = users.length ? Math.max(...users.map(u => u.id || 0)) + 1 : 1;
    const newUser = {
      id: nextId,
      username: username ? String(username).trim().toLowerCase() : '',
      name,
      surname,
      firstName,
      middleName,
      suffix,
      email: email.toLowerCase(),
      birthday,
      password,
      gender,
      role: role || 'employee',
      google: google ? true : false,
      mfaSecret: '',
      mfaMethod: 'authenticator',
      mfaCodeHash: '',
      mfaCodeExpiresAt: null,
      mfaEnabled: false,
      failedLoginAttempts: 0,
      lockoutUntil: null,
    };
    users.push(newUser);
    store.users = users;
    writeStore(store);
    return newUser;
  }

  const [result] = await pool.execute(
    `INSERT INTO users
      (username, name, surname, firstName, middleName, suffix, email, birthday, password, gender, role, google)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      username ? String(username).trim().toLowerCase() : null,
      name,
      surname,
      firstName,
      middleName,
      suffix,
      email.toLowerCase(),
      birthday || null,
      password,
      gender,
      role,
      google ? 1 : 0,
    ]
  );

  return {
    id: result.insertId,
    username: username ? String(username).trim().toLowerCase() : '',
    name,
    surname,
    firstName,
    middleName,
    suffix,
    email: email.toLowerCase(),
    birthday,
    password,
    gender,
    role,
    google,
    mfaMethod: 'authenticator',
    mfaCodeHash: '',
    mfaCodeExpiresAt: null,
    mfaEnabled: false,
    failedLoginAttempts: 0,
    lockoutUntil: null,
  };
}

async function getAnnouncements() {
  if (useFileFallback) {
    const store = readStore();
    return (store.announcements || []).slice().sort((a, b) => (String(b.date || '')).localeCompare(String(a.date || '')));
  }

  const [rows] = await pool.execute('SELECT id, title, description, image, visible, date, createdByEmail, createdAt FROM announcements ORDER BY createdAt DESC');
  return rows;
}

async function createAnnouncement(item) {
  if (useFileFallback) {
    const store = readStore();
    const announcement = {
      id: Number(item.id),
      title: item.title,
      description: item.description,
      image: item.image || '',
      visible: item.visible !== false,
      date: item.date,
      createdByEmail: item.createdByEmail || '',
      createdAt: new Date().toISOString(),
    };
    store.announcements.unshift(announcement);
    writeStore(store);
    return announcement;
  }

  await pool.execute(
    'INSERT INTO announcements (id, title, description, image, visible, date, createdByEmail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(item.id), item.title, item.description, item.image || '', item.visible === false ? 0 : 1, item.date, item.createdByEmail || null]
  );
  return item;
}

async function updateAnnouncementVisibility(id, visible) {
  if (useFileFallback) {
    const store = readStore();
    const item = (store.announcements || []).find(a => Number(a.id) === Number(id));
    if (!item) return null;
    item.visible = !!visible;
    writeStore(store);
    return item;
  }

  await pool.execute('UPDATE announcements SET visible = ? WHERE id = ?', [visible ? 1 : 0, Number(id)]);
  const [rows] = await pool.execute('SELECT id, title, description, image, visible, date, createdByEmail, createdAt FROM announcements WHERE id = ? LIMIT 1', [Number(id)]);
  return rows[0] || null;
}

async function deleteAnnouncement(id) {
  if (useFileFallback) {
    const store = readStore();
    store.announcements = (store.announcements || []).filter(a => Number(a.id) !== Number(id));
    writeStore(store);
    return true;
  }

  await pool.execute('DELETE FROM announcements WHERE id = ?', [Number(id)]);
  return true;
}

async function getLeaves(email) {
  if (useFileFallback) {
    const store = readStore();
    const items = store.leaves || [];
    const filtered = email ? items.filter(l => l.employeeEmail === email.toLowerCase()) : items;
    return filtered.slice().map(normalizeLeaveRow).sort((a, b) => new Date(b.startDate || b.start) - new Date(a.startDate || a.start));
  }

  if (email) {
    const [rows] = await pool.execute('SELECT * FROM leaves WHERE employeeEmail = ? ORDER BY startDate DESC', [email.toLowerCase()]);
    return rows.map(normalizeLeaveRow);
  }

  const [rows] = await pool.execute('SELECT * FROM leaves ORDER BY startDate DESC');
  return rows.map(normalizeLeaveRow);
}

async function upsertLeavesForEmployee(email, leaves) {
  const normalizedEmail = (email || '').toLowerCase();

  if (useFileFallback) {
    const store = readStore();
    store.leaves = (store.leaves || []).filter(l => l.employeeEmail !== normalizedEmail);
    const prepared = (leaves || []).map(l => ({
      id: Number(l.id),
      employeeEmail: normalizedEmail,
      type: l.type,
      startDate: formatDateOnly(l.startDate || l.start),
      endDate: formatDateOnly(l.endDate || l.end),
      days: Number(l.days || 0),
      status: l.status || 'Pending',
      medicalCertificate: l.medicalCertificate ? JSON.stringify(l.medicalCertificate) : null,
      start: formatDateOnly(l.start || l.startDate),
      end: formatDateOnly(l.end || l.endDate),
    }));
    store.leaves.push(...prepared);
    writeStore(store);
    return prepared;
  }

  await pool.execute('DELETE FROM leaves WHERE employeeEmail = ?', [normalizedEmail]);
  for (const l of leaves || []) {
    await pool.execute(
      'INSERT INTO leaves (id, employeeEmail, type, startDate, endDate, days, status, medicalCertificate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        Number(l.id),
        normalizedEmail,
        l.type,
        formatDateOnly(l.startDate || l.start),
        formatDateOnly(l.endDate || l.end),
        Number(l.days || 0),
        l.status || 'Pending',
        l.medicalCertificate ? JSON.stringify(l.medicalCertificate) : null,
      ]
    );
  }
  return getLeaves(normalizedEmail);
}

async function updateLeaveStatus(id, status) {
  if (useFileFallback) {
    const store = readStore();
    const found = (store.leaves || []).find(l => Number(l.id) === Number(id));
    if (!found) return null;
    found.status = status;
    writeStore(store);
    return found;
  }

  await pool.execute('UPDATE leaves SET status = ? WHERE id = ?', [status, Number(id)]);
  const [rows] = await pool.execute('SELECT * FROM leaves WHERE id = ? LIMIT 1', [Number(id)]);
  return normalizeLeaveRow(rows[0]) || null;
}

async function getAttendance(email) {
  const normalizedEmail = (email || '').toLowerCase();
  if (useFileFallback) {
    const store = readStore();
    return (store.attendance || []).filter(a => a.employeeEmail === normalizedEmail).slice().map(normalizeAttendanceRow).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  const [rows] = await pool.execute('SELECT * FROM attendance WHERE employeeEmail = ? ORDER BY date DESC', [normalizedEmail]);
  return rows.map(normalizeAttendanceRow);
}

async function upsertAttendanceForEmployee(email, attendance) {
  const normalizedEmail = (email || '').toLowerCase();
  if (useFileFallback) {
    const store = readStore();
    store.attendance = (store.attendance || []).filter(a => a.employeeEmail !== normalizedEmail);
    const prepared = (attendance || []).map(a => ({
      id: Number(a.id),
      employeeEmail: normalizedEmail,
      date: formatDateOnly(a.date),
      timeIn: a.timeIn || '',
      timeOut: a.timeOut || '',
      status: a.status,
      photo: a.photo || '',
    }));
    store.attendance.push(...prepared);
    writeStore(store);
    return prepared;
  }

  await pool.execute('DELETE FROM attendance WHERE employeeEmail = ?', [normalizedEmail]);
  for (const a of attendance || []) {
    await pool.execute(
      'INSERT INTO attendance (id, employeeEmail, date, timeIn, timeOut, status, photo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [Number(a.id), normalizedEmail, formatDateOnly(a.date), a.timeIn || null, a.timeOut || null, a.status, a.photo || null]
    );
  }
  return getAttendance(normalizedEmail);
}

async function getTrainings(email) {
  const normalizedEmail = (email || '').toLowerCase();
  if (useFileFallback) {
    const store = readStore();
    return (store.trainings || []).filter(t => t.employeeEmail === normalizedEmail).slice().map(normalizeTrainingRow).sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  }

  const [rows] = await pool.execute('SELECT * FROM trainings WHERE employeeEmail = ? ORDER BY startDate DESC', [normalizedEmail]);
  return rows.map(normalizeTrainingRow);
}

async function upsertTrainingsForEmployee(email, trainings) {
  const normalizedEmail = (email || '').toLowerCase();
  if (useFileFallback) {
    const store = readStore();
    store.trainings = (store.trainings || []).filter(t => t.employeeEmail !== normalizedEmail);
    const prepared = (trainings || []).map(t => ({
      id: Number(t.id),
      employeeEmail: normalizedEmail,
      title: t.title,
      startDate: formatDateOnly(t.startDate || t.start) || null,
      endDate: formatDateOnly(t.endDate || t.end) || null,
      hours: t.hours || null,
      type: t.type || null,
      sponsor: t.sponsor || t.conductedBy || null,
      status: t.status || null,
      certificate: t.certificate || null,
      start: formatDateOnly(t.start || t.startDate) || null,
      end: formatDateOnly(t.end || t.endDate) || null,
    }));
    store.trainings.push(...prepared);
    writeStore(store);
    return prepared;
  }

  await pool.execute('DELETE FROM trainings WHERE employeeEmail = ?', [normalizedEmail]);
  for (const t of trainings || []) {
    await pool.execute(
      'INSERT INTO trainings (id, employeeEmail, title, startDate, endDate, hours, type, sponsor, status, certificate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [Number(t.id), normalizedEmail, t.title, formatDateOnly(t.startDate || t.start) || null, formatDateOnly(t.endDate || t.end) || null, t.hours || null, t.type || null, t.sponsor || t.conductedBy || null, t.status || null, t.certificate ? JSON.stringify(t.certificate) : null]
    );
  }
  return getTrainings(normalizedEmail);
}

async function getEvaluation(email) {
  const normalizedEmail = (email || '').toLowerCase();
  if (useFileFallback) {
    const store = readStore();
    return (store.evaluations || []).find(e => e.employeeEmail === normalizedEmail) || { employeeEmail: normalizedEmail, status: '' };
  }

  const [rows] = await pool.execute('SELECT * FROM evaluations WHERE employeeEmail = ? LIMIT 1', [normalizedEmail]);
  return rows[0] || { employeeEmail: normalizedEmail, status: '' };
}

async function upsertEvaluation(email, status) {
  const normalizedEmail = (email || '').toLowerCase();
  if (useFileFallback) {
    const store = readStore();
    const evaluations = store.evaluations || [];
    const existing = evaluations.find(e => e.employeeEmail === normalizedEmail);
    if (existing) {
      existing.status = status || '';
      existing.updatedAt = new Date().toISOString();
    } else {
      evaluations.push({ employeeEmail: normalizedEmail, status: status || '', updatedAt: new Date().toISOString() });
    }
    store.evaluations = evaluations;
    writeStore(store);
    return getEvaluation(normalizedEmail);
  }

  await pool.execute(
    'INSERT INTO evaluations (employeeEmail, status) VALUES (?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)',
    [normalizedEmail, status || '']
  );
  return getEvaluation(normalizedEmail);
}

async function getLeaveComments(employeeEmail, leaveId) {
  const normalizedEmail = (employeeEmail || '').toLowerCase();
  const normalizedLeaveId = Number(leaveId);

  if (useFileFallback) {
    const store = readStore();
    return (store.leaveComments || [])
      .filter(c => c.employeeEmail === normalizedEmail && Number(c.leaveId) === normalizedLeaveId)
      .slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  }

  const [rows] = await pool.execute(
    'SELECT id, leaveId, employeeEmail, text, date, createdByEmail, createdByRole, createdAt FROM leave_comments WHERE employeeEmail = ? AND leaveId = ? ORDER BY createdAt ASC',
    [normalizedEmail, normalizedLeaveId]
  );
  return rows;
}

async function createLeaveComment(item) {
  const payload = {
    id: Number(item.id),
    leaveId: Number(item.leaveId),
    employeeEmail: String(item.employeeEmail || '').toLowerCase(),
    text: item.text || '',
    date: item.date || new Date().toLocaleString(),
    createdByEmail: item.createdByEmail || '',
    createdByRole: item.createdByRole || '',
    createdAt: new Date().toISOString(),
  };

  if (useFileFallback) {
    const store = readStore();
    store.leaveComments.push(payload);
    writeStore(store);
    return payload;
  }

  await pool.execute(
    'INSERT INTO leave_comments (id, leaveId, employeeEmail, text, date, createdByEmail, createdByRole) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [payload.id, payload.leaveId, payload.employeeEmail, payload.text, payload.date, payload.createdByEmail || null, payload.createdByRole || null]
  );
  return payload;
}

async function deleteLeaveComment(id) {
  const normalizedId = Number(id);
  if (useFileFallback) {
    const store = readStore();
    store.leaveComments = (store.leaveComments || []).filter(c => Number(c.id) !== normalizedId);
    writeStore(store);
    return true;
  }

  await pool.execute('DELETE FROM leave_comments WHERE id = ?', [normalizedId]);
  return true;
}

async function getUserProfile(email) {
  const normalizedEmail = (email || '').toLowerCase();
  if (!normalizedEmail) return null;

  const getEmployeeProfile = (pdsData) => {
    const employeeProfile = pdsData && typeof pdsData === 'object' && pdsData.employeeProfile && typeof pdsData.employeeProfile === 'object'
      ? pdsData.employeeProfile
      : {};
    return {
      employeeId: employeeProfile.employeeId || '',
      employmentStatus: employeeProfile.employmentStatus || '',
      dateHired: employeeProfile.dateHired || '',
      contactInfo: employeeProfile.contactInfo || '',
      address: employeeProfile.address || '',
      emergencyContact: employeeProfile.emergencyContact || '',
      profilePhoto: employeeProfile.profilePhoto || '',
    };
  };

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.email === normalizedEmail);
    if (!user) return null;
    const profile = (store.userProfiles || []).find(p => p.email === normalizedEmail) || {};
    const pdsData = profile.pdsData && typeof profile.pdsData === 'object' ? profile.pdsData : {};
    return {
      email: normalizedEmail,
      username: user.username || '',
      name: user.name || '',
      department: profile.department || '',
      position: profile.position || '',
      phone: profile.phone || '',
      profileImage: profile.profileImage || '',
      pdsData,
      ...getEmployeeProfile(pdsData),
      gender: user.gender || '',
    };
  }

  const user = await getUserByEmail(normalizedEmail);
  if (!user) return null;
  const [rows] = await pool.execute('SELECT email, department, position, phone, profileImage, pdsData FROM user_profiles WHERE email = ? LIMIT 1', [normalizedEmail]);
  const profile = rows[0] || {};
  let pdsData = {};
  if (profile.pdsData) {
    try {
      pdsData = JSON.parse(profile.pdsData);
    } catch (_) {
      pdsData = {};
    }
  }
  return {
    email: normalizedEmail,
    username: user.username || '',
    name: user.name || '',
    department: profile.department || '',
    position: profile.position || '',
    phone: profile.phone || '',
    profileImage: profile.profileImage || '',
    pdsData,
    ...getEmployeeProfile(pdsData),
    gender: user.gender || '',
  };
}

async function upsertUserProfile(email, profile) {
  const normalizedEmail = (email || '').toLowerCase();
  if (!normalizedEmail) return null;

  const mergePdsData = (existingData, incomingData) => {
    const current = existingData && typeof existingData === 'object' ? existingData : {};
    const next = incomingData && typeof incomingData === 'object' ? incomingData : {};
    const currentEmployeeProfile = current.employeeProfile && typeof current.employeeProfile === 'object' ? current.employeeProfile : {};
    const nextEmployeeProfile = next.employeeProfile && typeof next.employeeProfile === 'object' ? next.employeeProfile : {};
    const employeeIdFromPds = String(
      nextEmployeeProfile.employeeId ||
      next.latestPersonalInfo?.employeeNumber ||
      next.employeeNumber ||
      ''
    ).trim();
    return {
      ...current,
      ...next,
      employeeProfile: {
        ...currentEmployeeProfile,
        ...nextEmployeeProfile,
        ...(employeeIdFromPds ? { employeeId: employeeIdFromPds } : {}),
      },
    };
  };

  if (useFileFallback) {
    const store = readStore();
    const users = store.users || [];
    const user = users.find(u => u.email === normalizedEmail);
    if (!user) return null;

    if (profile.name !== undefined) user.name = profile.name;
    if (profile.gender !== undefined) user.gender = profile.gender;

    const profiles = store.userProfiles || [];
    let existing = profiles.find(p => p.email === normalizedEmail);
    if (!existing) {
      existing = { email: normalizedEmail, department: '', position: '', phone: '', profileImage: '' };
      profiles.push(existing);
    }

    if (profile.department !== undefined) existing.department = profile.department;
    if (profile.position !== undefined) existing.position = profile.position;
    if (profile.phone !== undefined) existing.phone = profile.phone;
    if (profile.profileImage !== undefined) existing.profileImage = profile.profileImage;
    if (profile.pdsData !== undefined) existing.pdsData = mergePdsData(existing.pdsData, profile.pdsData);

    store.users = users;
    store.userProfiles = profiles;
    writeStore(store);
    return getUserProfile(normalizedEmail);
  }

  if (profile.name !== undefined || profile.gender !== undefined) {
    await pool.execute('UPDATE users SET name = COALESCE(?, name), gender = COALESCE(?, gender) WHERE email = ?', [profile.name ?? null, profile.gender ?? null, normalizedEmail]);
  }

  const [existingRows] = await pool.execute('SELECT pdsData FROM user_profiles WHERE email = ? LIMIT 1', [normalizedEmail]);
  let existingPdsData = {};
  if (existingRows[0] && existingRows[0].pdsData) {
    try {
      existingPdsData = JSON.parse(existingRows[0].pdsData);
    } catch (_) {
      existingPdsData = {};
    }
  }
  const mergedPdsData = mergePdsData(existingPdsData, profile.pdsData);

  await pool.execute(
    'INSERT INTO user_profiles (email, department, position, phone, profileImage, pdsData) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE department = VALUES(department), position = VALUES(position), phone = VALUES(phone), profileImage = VALUES(profileImage), pdsData = VALUES(pdsData)',
    [normalizedEmail, profile.department || '', profile.position || '', profile.phone || '', profile.profileImage || '', JSON.stringify(mergedPdsData)]
  );

  return getUserProfile(normalizedEmail);
}

async function updateUserPassword(email, hashedPassword) {
  const normalizedEmail = (email || '').toLowerCase();
  if (!normalizedEmail || !hashedPassword) return false;

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.email === normalizedEmail);
    if (!user) return false;
    user.password = hashedPassword;
    writeStore(store);
    return true;
  }

  await pool.execute('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, normalizedEmail]);
  return true;
}

async function updateUserMfa(email, secret, enabled, options = {}) {
  const normalizedEmail = (email || '').toLowerCase();
  if (!normalizedEmail) return null;
  const method = options.method || null;
  const hasCodeHash = Object.prototype.hasOwnProperty.call(options, 'codeHash');
  const hasCodeExpiresAt = Object.prototype.hasOwnProperty.call(options, 'codeExpiresAt');
  const codeHash = hasCodeHash ? options.codeHash : null;
  const codeExpiresAt = hasCodeExpiresAt ? options.codeExpiresAt : null;

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.email === normalizedEmail);
    if (!user) return null;
    user.mfaSecret = secret || '';
    if (method) user.mfaMethod = method;
    if (hasCodeHash) user.mfaCodeHash = codeHash || '';
    if (hasCodeExpiresAt) user.mfaCodeExpiresAt = codeExpiresAt || null;
    user.mfaEnabled = !!enabled;
    writeStore(store);
    return getUserByEmail(normalizedEmail);
  }

  await pool.execute(
    `UPDATE users
      SET mfaSecret = ?,
          mfaEnabled = ?,
          mfaMethod = COALESCE(?, mfaMethod),
          mfaCodeHash = CASE WHEN ? THEN ? ELSE mfaCodeHash END,
          mfaCodeExpiresAt = CASE WHEN ? THEN ? ELSE mfaCodeExpiresAt END
      WHERE email = ?`,
    [
      secret || '',
      enabled ? 1 : 0,
      method,
      hasCodeHash, codeHash || null,
      hasCodeExpiresAt, codeExpiresAt || null,
      normalizedEmail,
    ]
  );
  return getUserByEmail(normalizedEmail);
}

async function updateUserLoginSecurity(email, { failedLoginAttempts = 0, lockoutUntil = null } = {}) {
  const normalizedEmail = (email || '').toLowerCase();
  if (!normalizedEmail) return null;

  if (useFileFallback) {
    const store = readStore();
    const user = (store.users || []).find(u => u.email === normalizedEmail);
    if (!user) return null;
    user.failedLoginAttempts = Number(failedLoginAttempts) || 0;
    user.lockoutUntil = lockoutUntil || null;
    writeStore(store);
    return getUserByEmail(normalizedEmail);
  }

  await pool.execute(
    'UPDATE users SET failedLoginAttempts = ?, lockoutUntil = ? WHERE email = ?',
    [Number(failedLoginAttempts) || 0, lockoutUntil || null, normalizedEmail]
  );
  return getUserByEmail(normalizedEmail);
}

async function resetUserLoginSecurity(email) {
  return updateUserLoginSecurity(email, { failedLoginAttempts: 0, lockoutUntil: null });
}

async function getAuditLogs(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  if (useFileFallback) {
    const store = readStore();
    return (store.auditLogs || [])
      .slice()
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
      .slice(0, safeLimit);
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, adminEmail, action, target, details, timestamp FROM audit_logs ORDER BY timestamp DESC LIMIT ?',
      [safeLimit]
    );
    return rows;
  } catch (error) {
    return [];
  }
}

async function createAuditLog(entry) {
  const payload = {
    id: Number(entry.id) || Date.now(),
    adminEmail: String(entry.adminEmail || '').toLowerCase(),
    action: String(entry.action || '').trim(),
    target: String(entry.target || '').trim(),
    details: String(entry.details || '').trim(),
    timestamp: entry.timestamp || new Date().toISOString(),
  };

  if (useFileFallback) {
    const store = readStore();
    store.auditLogs = store.auditLogs || [];
    store.auditLogs.unshift(payload);
    writeStore(store);
    return payload;
  }

  try {
    await pool.execute(
      'INSERT INTO audit_logs (id, adminEmail, action, target, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      [payload.id, payload.adminEmail, payload.action, payload.target, payload.details, payload.timestamp]
    );
  } catch (error) {
    return payload;
  }
  return payload;
}

module.exports = {
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
};
