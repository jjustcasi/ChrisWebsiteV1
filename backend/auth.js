function getUsers() {
  return JSON.parse(localStorage.getItem('chris_users') || '[]');
}

function saveUsers(users) {
  localStorage.setItem('chris_users', JSON.stringify(users));
}

function setSession(email) {
  localStorage.setItem('chris_session', email);
}

function setAuthToken(token) {
  if (token) localStorage.setItem('chris_auth_token', token);
}

function getSession() {
  return localStorage.getItem('chris_session');
}

function setUserRole(role) {
  localStorage.setItem('chris_user_role', role);
}

function getUserRole() {
  return localStorage.getItem('chris_user_role') || '';
}

function clearUserRole() {
  localStorage.removeItem('chris_user_role');
}

function clearSession() {
  localStorage.removeItem('chris_session');
  localStorage.removeItem('chris_auth_token');
  clearUserRole();
}

function showMessage(id, text, ok) {
  const msg = document.getElementById(id);
  if (!msg) return;
  msg.textContent = text;
  msg.className = 'message';
  if (!text) return;
  msg.classList.add(ok ? 'ok' : 'err');
}

function ensureLoggedOut() {
  const sessionEmail = getSession();
  const role = getUserRole();
  if (sessionEmail) {
    if (role === 'admin') {
      window.location.href = '/admin.html';
    } else {
      window.location.href = '/dashboard.html';
    }
  }
}

function setupSignupAutoUppercase() {
  const upperCaseFieldIds = [
    'signupSurname',
    'signupFirstName',
    'signupMiddleName',
    'signupSuffix'
  ];

  upperCaseFieldIds.forEach((id) => {
    const field = document.getElementById(id);
    if (!field) return;

    field.addEventListener('input', () => {
      field.value = field.value.toUpperCase();
    });
  });
}

function setupSignupPasswordEyeButtons() {
  const fieldButtonPairs = [
    { fieldId: 'signupPassword', buttonId: 'toggleSignupPassword', showLabel: 'Show password', hideLabel: 'Hide password' },
    { fieldId: 'signupConfirmPassword', buttonId: 'toggleSignupConfirmPassword', showLabel: 'Show confirm password', hideLabel: 'Hide confirm password' }
  ];

  fieldButtonPairs.forEach(({ fieldId, buttonId, showLabel, hideLabel }) => {
    const field = document.getElementById(fieldId);
    const button = document.getElementById(buttonId);
    if (!field || !button) return;

    button.addEventListener('click', () => {
      const shouldShow = field.type === 'password';
      field.type = shouldShow ? 'text' : 'password';
      const nextLabel = shouldShow ? hideLabel : showLabel;
      button.setAttribute('aria-label', nextLabel);
      button.title = nextLabel;
      button.classList.toggle('is-active', shouldShow);
    });
  });
}

function evaluatePasswordStrength(password) {
  const value = String(password || '');
  let score = 0;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value)) score += 1;
  if (/[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value)) score += 1;
  if (/[^A-Za-z0-9\s]/.test(value)) score += 1;
  if (/\s/.test(value)) score -= 1;

  if (score >= 5) return { level: 'strong', label: 'Strong' };
  if (score >= 3) return { level: 'medium', label: 'Medium' };
  return { level: 'weak', label: 'Weak' };
}

function setupSignupPasswordStrengthIndicator() {
  const field = document.getElementById('signupPassword');
  const indicator = document.getElementById('signupPasswordStrength');
  const label = indicator?.querySelector('.password-strength-label');
  if (!field || !indicator || !label) return;

  const render = () => {
    const strength = evaluatePasswordStrength(field.value);
    indicator.classList.toggle('is-medium', strength.level === 'medium');
    indicator.classList.toggle('is-strong', strength.level === 'strong');
    label.textContent = `Password strength: ${strength.label}`;
  };

  field.addEventListener('input', render);
  render();
}

const SIGNUP_DRAFT_KEY = 'chris_signup_draft';
let pendingMfaChallenge = null;

function cameFromPolicyPage() {
  const referrer = document.referrer || '';
  if (!referrer) return false;

  return /\/(terms|privacy|cookies)\.html$/i.test(referrer);
}

function getSignupDraftFieldIds() {
  return [
    'signupSurname',
    'signupFirstName',
    'signupMiddleName',
    'signupSuffix',
    'signupUsername',
    'signupEmail',
    'signupBirthday',
    'signupPassword',
    'signupConfirmPassword',
    'signupGender'
  ];
}

function setupSignupDraftPersistence() {
  const fieldIds = getSignupDraftFieldIds();
  const availableFields = fieldIds
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  if (!availableFields.length) return;

  // Keep draft only when user returns from policy pages.
  if (!cameFromPolicyPage()) {
    sessionStorage.removeItem(SIGNUP_DRAFT_KEY);
  }

  const savedDraftRaw = sessionStorage.getItem(SIGNUP_DRAFT_KEY);
  if (savedDraftRaw) {
    try {
      const savedDraft = JSON.parse(savedDraftRaw);
      fieldIds.forEach((id) => {
        const field = document.getElementById(id);
        if (!field) return;
        if (typeof savedDraft[id] === 'string') {
          field.value = savedDraft[id];
        }
      });
    } catch (_) {
      sessionStorage.removeItem(SIGNUP_DRAFT_KEY);
    }
  }

  const saveDraft = () => {
    const draft = {};
    fieldIds.forEach((id) => {
      const field = document.getElementById(id);
      if (!field) return;
      draft[id] = field.value;
    });
    sessionStorage.setItem(SIGNUP_DRAFT_KEY, JSON.stringify(draft));
  };

  availableFields.forEach((field) => {
    field.addEventListener('input', saveDraft);
    field.addEventListener('change', saveDraft);
  });
}

function setupLoginPasswordEyeButton() {
  const field = document.getElementById('loginPassword');
  const button = document.getElementById('toggleLoginPassword');
  if (!field || !button) return;

  button.addEventListener('click', () => {
    const shouldShow = field.type === 'password';
    field.type = shouldShow ? 'text' : 'password';
    const nextLabel = shouldShow ? 'Hide password' : 'Show password';
    button.setAttribute('aria-label', nextLabel);
    button.title = nextLabel;
    button.classList.toggle('is-active', shouldShow);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupSignupAutoUppercase();
  setupSignupPasswordEyeButtons();
  setupSignupPasswordStrengthIndicator();
  setupSignupDraftPersistence();
  setupLoginPasswordEyeButton();
});

function ensureLocalUserRecord(user) {
  if (!user || !user.email) return;
  const email = user.email.toLowerCase();
  const users = getUsers();
  const storedUser = users.find((u) => u.email === email);
  if (!storedUser) {
    users.push({
      name: user.name || email,
      username: user.username || '',
      surname: user.surname || '',
      firstName: user.firstName || '',
      middleName: user.middleName || '',
      suffix: user.suffix || '',
      email,
      birthday: user.birthday || '',
      password: user.password || '',
      gender: user.gender || '',
      role: user.role || 'employee',
      google: user.google || false,
    });
    saveUsers(users);
  } else if (user.role && storedUser.role !== user.role) {
    storedUser.role = user.role;
    saveUsers(users);
  }

  const leavesKey = 'chris_leaves_' + email;
  const trainingsKey = 'chris_trainings_' + email;
  if (!localStorage.getItem(leavesKey)) {
    localStorage.setItem(leavesKey, JSON.stringify([]));
  }
  if (!localStorage.getItem(trainingsKey)) {
    localStorage.setItem(trainingsKey, JSON.stringify([]));
  }
}

function createLocalUser(user) {
  const users = getUsers();
  if (users.some((u) => u.email === user.email.toLowerCase())) {
    return false;
  }

  const newUser = {
    name: user.name || user.email,
    username: user.username || '',
    surname: user.surname || '',
    firstName: user.firstName || '',
    middleName: user.middleName || '',
    suffix: user.suffix || '',
    email: user.email.toLowerCase(),
    birthday: user.birthday || '',
    password: user.password || '',
    gender: user.gender || '',
    role: user.role || 'employee',
    google: user.google || false,
  };

  users.push(newUser);
  saveUsers(users);
  ensureLocalUserRecord(newUser);
  return true;
}

function finishAuthenticatedSession(user, localUserPayload, sessionToken) {
  const authUser = user || {};
  const email = String(authUser.email || localUserPayload?.email || '').toLowerCase();
  if (!email) {
    showMessage('authMessage', 'Authentication completed, but user details were missing.', false);
    return;
  }

  ensureLocalUserRecord({
    ...(localUserPayload || {}),
    email,
    name: authUser.name || localUserPayload?.name || email,
    password: '',
    role: authUser.role || localUserPayload?.role || 'employee',
    google: localUserPayload?.google || false
  });

  setUserRole(authUser.role || localUserPayload?.role || 'employee');
  setAuthToken(sessionToken || authUser.sessionToken || '');
  sessionStorage.removeItem(SIGNUP_DRAFT_KEY);
  setSession(email);
  window.location.href = (authUser.role || localUserPayload?.role) === 'admin' ? '/admin.html' : '/dashboard.html';
}

function hidePrimaryAuthControls() {
  document.querySelectorAll('.auth-card > form, .google-login-divider, #googleSignInButton, #googleSignUpButton, .auth-switch-link').forEach((element) => {
    element.classList.add('hidden');
  });
}

function showMfaChallenge(data, localUserPayload) {
  pendingMfaChallenge = {
    token: data.challengeToken,
    localUserPayload: localUserPayload || null
  };

  hidePrimaryAuthControls();

  const section = document.getElementById('mfaChallengeSection');
  const title = document.getElementById('mfaChallengeTitle');
  const setup = document.getElementById('mfaSetupInstructions');
  const setupQr = document.getElementById('mfaSetupQr');
  const secret = document.getElementById('mfaSetupSecret');
  const account = document.getElementById('mfaSetupAccount');
  const issuer = document.getElementById('mfaSetupIssuer');
  const codeField = document.getElementById('mfaCode');
  const recipient = document.getElementById('mfaRecipient');

  if (section) section.classList.remove('hidden');
  const selectedMethod = document.getElementById('loginMfaMethod')?.value || '';
  const method = data.mfaMethod || data.mfa?.method || selectedMethod || 'authenticator';
  const isAuthenticator = method === 'authenticator';
  if (title) {
    title.textContent = isAuthenticator
      ? (data.mfaSetupRequired ? 'Set up authenticator MFA' : 'Authenticator verification')
      : 'Email verification';
  }
  if (recipient) {
    const email = data.mfa?.email || data.user?.email || pendingMfaChallenge.localUserPayload?.email || '';
    recipient.textContent = method === 'email' && email ? `Code sent to ${email}` : '';
    recipient.classList.toggle('hidden', method !== 'email' || !email);
  }
  if (setup) setup.classList.toggle('hidden', !isAuthenticator);
  if (setupQr) {
    setupQr.src = data.mfa?.qrCodeDataUrl || '';
    setupQr.classList.toggle('hidden', !data.mfa?.qrCodeDataUrl);
  }
  if (secret) secret.textContent = data.mfa?.secret || '';
  if (account) account.textContent = data.mfa?.accountName || '';
  if (issuer) issuer.textContent = data.mfa?.issuer || '';

  showMessage(
    'authMessage',
    isAuthenticator
      ? 'Scan the QR code in your authenticator app, then enter the 6-digit code.'
      : (data.mfa?.deliveryMessage || (method === 'email' ? 'Enter the 6-digit code sent to your account email.' : 'Enter the 6-digit code from your authenticator app.')),
    true
  );

  if (codeField) {
    codeField.value = '';
    codeField.focus();
  }
}

function verifyMfaCode() {
  const code = document.getElementById('mfaCode')?.value.trim() || '';
  if (!pendingMfaChallenge?.token) {
    showMessage('authMessage', 'Please login again to start MFA verification.', false);
    return;
  }

  fetch('/api/auth/mfa/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ challengeToken: pendingMfaChallenge.token, code })
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) {
        showMessage('authMessage', data.message || 'Invalid authenticator code.', false);
        return;
      }

      finishAuthenticatedSession(data.user, pendingMfaChallenge.localUserPayload, data.sessionToken);
    })
    .catch(() => {
      showMessage('authMessage', 'Unable to reach the authentication server.', false);
    });
}

function signup() {
  const surname = document.getElementById('signupSurname').value.trim().toUpperCase();
  const firstName = document.getElementById('signupFirstName').value.trim().toUpperCase();
  const middleName = document.getElementById('signupMiddleName').value.trim().toUpperCase();
  const suffix = document.getElementById('signupSuffix').value.trim().toUpperCase();
  const username = document.getElementById('signupUsername').value.trim().toLowerCase();
  const email = document.getElementById('signupEmail').value.trim().toLowerCase();
  const birthday = document.getElementById('signupBirthday').value;
  const password = document.getElementById('signupPassword').value;
  const confirmPassword = document.getElementById('signupConfirmPassword').value;
  const gender = document.getElementById('signupGender').value;

  if (!surname || !firstName || !username || !email || !birthday || !password || !confirmPassword || !gender) {
    showMessage('authMessage', 'Please complete all sign up fields.', false);
    return;
  }

  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    showMessage('authMessage', 'Username must be 3-30 characters and use only letters, numbers, dots, underscores, or hyphens.', false);
    return;
  }

  if (password !== confirmPassword) {
    showMessage('authMessage', 'Password and confirm password do not match.', false);
    return;
  }

  if (evaluatePasswordStrength(password).level !== 'strong') {
    showMessage('authMessage', 'Password must be strong: use at least 12 characters with uppercase, lowercase, number, and symbol.', false);
    return;
  }

  if (!document.getElementById('agreeTerms').checked) {
    showMessage('authMessage', 'You must agree to the Terms and Conditions and Privacy Policy.', false);
    return;
  }

  const localUserPayload = {
    email,
    username,
    name: [firstName, middleName, surname, suffix].filter(Boolean).join(' '),
    surname,
    firstName,
    middleName,
    suffix,
    birthday,
    password,
    gender,
    role: 'employee',
    google: false,
  };

  fetch('/api/auth/signup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      surname,
      firstName,
      middleName,
      suffix,
      username,
      email,
      birthday,
      password,
      gender
    })
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) {
        showMessage('authMessage', data.message || 'Failed to create account.', false);
        return;
      }

      if (data.mfaRequired) {
        showMfaChallenge(data, localUserPayload);
        return;
      }

      finishAuthenticatedSession(data.user, localUserPayload, data.sessionToken);
    })
    .catch(() => {
      showMessage('authMessage', 'Unable to reach the authentication server. Please try signing up again.', false);
    });
}

function login() {
  const username = document.getElementById('loginUsername').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  const mfaMethod = document.getElementById('loginMfaMethod')?.value || 'authenticator';

  fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password, mfaMethod })
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) {
        showMessage('authMessage', data.message || 'Invalid username, password, or MFA setup.', false);
        return;
      }

      if (data.mfaRequired) {
        showMfaChallenge(data, { username, google: false });
        return;
      }

      finishAuthenticatedSession(data.user, { username, google: false }, data.sessionToken);
    })
    .catch(() => {
      showMessage('authMessage', 'Unable to reach the authentication server. Login requires MFA verification.', false);
    });
}

function handleCredentialResponse(response) {
  if (!response || !response.credential) {
    showMessage('authMessage', 'Google login failed. Please try again.', false);
    return;
  }

  const termsCheckbox = document.getElementById('agreeTerms');
  if (termsCheckbox && !termsCheckbox.checked) {
    showMessage('authMessage', 'Please agree to the Terms and Conditions and Privacy Policy before signing up with Google.', false);
    return;
  }

  const mfaMethod = document.getElementById('loginMfaMethod')?.value || 'authenticator';

  fetch('/api/auth/google', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      credential: response.credential,
      mfaMethod
    })
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) {
        showMessage('authMessage', data.message || 'Google authentication failed.', false);
        return;
      }

      const localUserPayload = {
        email: data.user.email,
        name: data.user.name || data.user.email,
        role: data.user.role || 'employee',
        google: true,
      };

      if (data.mfaRequired) {
        if (!document.getElementById('mfaChallengeSection')) {
          sessionStorage.setItem('chris_auth_message', 'Google account created. Please login and choose your MFA method to continue.');
          window.location.href = '/login.html';
          return;
        }

        showMfaChallenge(data, localUserPayload);
        return;
      }

      finishAuthenticatedSession(data.user, localUserPayload, data.sessionToken);
    })
    .catch(() => {
      showMessage('authMessage', 'Unable to reach the authentication server.', false);
    });
}

function initializeGoogleAuthButton(buttonId) {
  const buttonContainer = document.getElementById(buttonId);
  if (!buttonContainer) return false;

  const clientId = window.APP_CONFIG?.googleClientId || '';
  if (!window.APP_CONFIG?.googleAuthConfigured || !clientId) {
    buttonContainer.classList.add('hidden');
    return false;
  }

  if (!window.google) {
    window.setTimeout(() => initializeGoogleAuthButton(buttonId), 100);
    return false;
  }

  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleCredentialResponse
  });

  google.accounts.id.renderButton(buttonContainer, {
    theme: 'outline',
    size: 'large',
    width: '100%'
  });

  return true;
}

function showStoredAuthMessage() {
  const message = sessionStorage.getItem('chris_auth_message');
  if (!message) return;
  sessionStorage.removeItem('chris_auth_message');
  showMessage('authMessage', message, true);
}

window.addEventListener('DOMContentLoaded', showStoredAuthMessage);
