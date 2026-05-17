let currentUser = null;
let selectedProfileImage = '';

function getUsers() {
  return JSON.parse(localStorage.getItem('chris_users') || '[]');
}

function saveUsers(users) {
  localStorage.setItem('chris_users', JSON.stringify(users));
}

function getSession() {
  return localStorage.getItem('chris_session');
}

function clearSession() {
  localStorage.removeItem('chris_session');
  localStorage.removeItem('chris_user_role');
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Request failed');
  return data;
}

async function apiSend(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Request failed');
  return data;
}

function showMessage(text, ok) {
  const msg = document.getElementById('settingsMessage');
  msg.textContent = text;
  msg.className = 'message';
  if (!text) return;
  msg.classList.add(ok ? 'ok' : 'err');
}

function renderProfilePreview(imageData) {
  const preview = document.getElementById('profileImagePreview');
  if (!preview) return;

  if (imageData) {
    preview.innerHTML = '<img src="' + imageData + '" alt="Profile" class="profile-pic">';
  } else {
    const name = String(document.getElementById('fullName')?.value || currentUser?.name || 'U');
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const initials = parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (parts[0] || 'U').slice(0, 2).toUpperCase();
    preview.innerHTML = '<span class="profile-avatar">' + initials + '</span>';
  }
}

function upsertLocalUserProfile(profile) {
  if (!profile || !profile.email) return;

  const users = getUsers();
  const email = String(profile.email || '').toLowerCase();
  const idx = users.findIndex(u => String(u.email || '').toLowerCase() === email);
  if (idx === -1) return;

  users[idx] = {
    ...users[idx],
    name: profile.name !== undefined ? profile.name : users[idx].name,
    department: profile.department !== undefined ? profile.department : users[idx].department,
    position: profile.position !== undefined ? profile.position : users[idx].position,
    phone: profile.phone !== undefined ? profile.phone : users[idx].phone,
    gender: profile.gender !== undefined ? profile.gender : users[idx].gender,
    profileImage: profile.profileImage !== undefined ? profile.profileImage : users[idx].profileImage,
    pdsData: profile.pdsData !== undefined ? profile.pdsData : users[idx].pdsData,
    employeeId: profile.employeeId !== undefined ? profile.employeeId : users[idx].employeeId,
    employmentStatus: profile.employmentStatus !== undefined ? profile.employmentStatus : users[idx].employmentStatus,
    dateHired: profile.dateHired !== undefined ? profile.dateHired : users[idx].dateHired,
    address: profile.address !== undefined ? profile.address : users[idx].address,
    emergencyContact: profile.emergencyContact !== undefined ? profile.emergencyContact : users[idx].emergencyContact,
  };

  saveUsers(users);
}

function bindImageInput() {
  const input = document.getElementById('profileImage');
  if (!input) return;

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) {
      selectedProfileImage = currentUser?.profileImage || '';
      renderProfilePreview(selectedProfileImage);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      selectedProfileImage = String(reader.result || '');
      renderProfilePreview(selectedProfileImage);
    };
    reader.readAsDataURL(file);
  });
}

async function requireLogin() {
  const sessionEmail = String(getSession() || '').trim().toLowerCase();
  if (!sessionEmail) {
    window.location.href = '/login.html';
    return false;
  }

  try {
    const data = await apiGet('/api/users/profile?email=' + encodeURIComponent(sessionEmail));
    currentUser = data.profile;
    upsertLocalUserProfile(currentUser);
    return true;
  } catch (err) {
    const localUser = getUsers().find(u => String(u.email || '').toLowerCase() === sessionEmail);
    if (!localUser) {
      clearSession();
      window.location.href = '/login.html';
      return false;
    }

    currentUser = {
      email: sessionEmail,
      name: localUser.name || sessionEmail,
      department: 'CHR',
      position: localUser.position || 'CHR Employee',
      phone: localUser.phone || '',
      profileImage: localUser.profileImage || '',
      gender: localUser.gender || '',
      pdsData: localUser.pdsData || {},
    };

    return true;
  }
}

async function initializeSettings() {
  const loggedIn = await requireLogin();
  if (!loggedIn) return;

  document.getElementById('fullName').value = currentUser.name || '';
  document.getElementById('email').value = currentUser.email || '';
  const employeeProfile = currentUser.pdsData?.employeeProfile || {};
  document.getElementById('department').value = 'CHR';
  document.getElementById('position').value = currentUser.position || 'CHR Employee';
  document.getElementById('employeeId').value = employeeProfile.employeeId || currentUser.employeeId || '';
  document.getElementById('gender').value = currentUser.gender || 'Not specified';
  document.getElementById('dateHired').value = employeeProfile.dateHired || currentUser.dateHired || '';
  document.getElementById('phone').value = employeeProfile.contactInfo || currentUser.phone || '';
  document.getElementById('address').value = employeeProfile.address || currentUser.address || '';
  document.getElementById('emergencyContact').value = employeeProfile.emergencyContact || currentUser.emergencyContact || '';
  selectedProfileImage = currentUser.profileImage || '';
  renderProfilePreview(selectedProfileImage);
  bindImageInput();
}

async function saveSettings() {
  if (!currentUser) return;

  const fullName = document.getElementById('fullName').value.trim();
  const department = 'CHR';
  const position = document.getElementById('position').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const address = document.getElementById('address').value.trim();
  const emergencyContact = document.getElementById('emergencyContact').value.trim();

  if (!fullName) {
    showMessage('Full name is required.', false);
    return;
  }

  const currentPdsData = currentUser.pdsData && typeof currentUser.pdsData === 'object' ? currentUser.pdsData : {};
  const currentEmployeeProfile = currentPdsData.employeeProfile && typeof currentPdsData.employeeProfile === 'object' ? currentPdsData.employeeProfile : {};
  const employeeProfile = {
    ...currentEmployeeProfile,
    contactInfo: phone,
    address,
    emergencyContact,
    profilePhoto: selectedProfileImage,
  };
  const pdsData = {
    ...currentPdsData,
    employeeProfile,
  };

  try {
    const data = await apiSend('/api/users/profile', 'PUT', {
      email: currentUser.email,
      name: fullName,
      department,
      position: position || 'CHR Employee',
      phone,
      profileImage: selectedProfileImage,
      gender: currentUser.gender || '',
      pdsData,
      employeeProfile,
    });
    currentUser = data.profile || currentUser;
    currentUser.pdsData = currentUser.pdsData || pdsData;
    upsertLocalUserProfile(currentUser);
    showMessage('Profile updated successfully.', true);
  } catch (err) {
    currentUser = {
      ...currentUser,
      name: fullName,
      department,
      position: position || 'CHR Employee',
      phone,
      profileImage: selectedProfileImage,
      pdsData,
    };
    upsertLocalUserProfile(currentUser);
    showMessage('Profile saved locally. Backend sync is currently unavailable.', true);
  }
}

function logout() {
  if (!window.confirm('Are you sure you want to logout?')) {
    return;
  }
  clearSession();
  window.location.href = '/index.html';
}
