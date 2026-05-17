const ADMIN_NAME = 'Admin';

let selectedEmployeeEmail = '';
let currentLeaveInModal = null;
let adminUsers = [];
let allLeavesCache = [];
let latestOverviewSummary = null;
const hrCache = {
  leavesByEmail: {},
  attendanceByEmail: {},
  trainingsByEmail: {},
  evaluationsByEmail: {},
  pdsDataByEmail: {},
  announcements: [],
};
const PROMOTION_CERTIFICATION_POINT_TARGET = 100;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '-';
  return date.toLocaleString();
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateOnly(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : getLocalDateString(date);
}

function formatTimeDisplay(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return String(value);
  const hours24 = Number(match[1]);
  if (!Number.isFinite(hours24)) return String(value);
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${match[2]} ${suffix}`;
}

function normalizeLeaveRecord(record) {
  const start = formatDateOnly(record.start || record.startDate);
  const end = formatDateOnly(record.end || record.endDate);
  return { ...record, start, end, startDate: start, endDate: end };
}

function normalizeTrainingRecord(record) {
  const start = formatDateOnly(record.start || record.startDate);
  const end = formatDateOnly(record.end || record.endDate);
  return { ...record, start, end, startDate: start, endDate: end };
}

function calculateCertificationPoints(training = {}) {
  if (!training.certificate || !training.certificate.data) return 0;

  const type = String(training.type || '').trim().toLowerCase();
  // New type options: 'Basic course', 'Basic supervisory', 'Advance supervisory'
  // Preserve compatibility with old type names if present.
  const typeBonus = {
    'advance supervisory': 15,
    'basic supervisory': 10,
    'basic course': 5,
    managerial: 15,
    supervisory: 10,
    technical: 8,
    compliance: 5,
    foundation: 5,
  }[type] || 5;
  const hours = Number(training.hours || 0);
  const hoursBonus = Number.isFinite(hours) ? Math.floor(hours / 8) : 0;

  return 10 + hoursBonus + typeBonus;
}

function getCertificationPointSummary(trainings = []) {
  return trainings.reduce((summary, training) => {
    const points = calculateCertificationPoints(training);
    if (!points) return summary;

    summary.total += points;
    summary.certificateCount += 1;
    return summary;
  }, { total: 0, certificateCount: 0 });
}

function normalizeAttendanceRecord(record) {
  return {
    ...record,
    date: formatDateOnly(record.date),
    timeIn: record.timeIn || '',
    timeOut: record.timeOut || '',
    photo: record.photo || '',
  };
}

function getSessionEmail() {
  return (typeof getSession === 'function' ? getSession() : localStorage.getItem('chris_session') || '').toLowerCase();
}

function getAuthToken() {
  return localStorage.getItem('chris_auth_token') || '';
}

function getAuthHeaders(extraHeaders = {}) {
  const token = getAuthToken();
  return {
    ...extraHeaders,
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
}

async function apiGet(url) {
  const res = await fetch(url, { headers: getAuthHeaders() });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Request failed');
  return data;
}

async function apiSend(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.message || 'Request failed');
  return data;
}

async function loadUsersFromApi() {
  const data = await apiGet('/api/admin/users');
  adminUsers = (data.users || []).map(user => ({ ...user, department: 'CHR' }));
}

async function loadAllLeavesFromApi() {
  const data = await apiGet('/api/hr/leaves');
  allLeavesCache = (data.items || []).map(item => ({
    ...normalizeLeaveRecord(item),
  }));

  hrCache.leavesByEmail = {};
  allLeavesCache.forEach(item => {
    const email = (item.employeeEmail || '').toLowerCase();
    if (!email) return;
    if (!hrCache.leavesByEmail[email]) hrCache.leavesByEmail[email] = [];
    hrCache.leavesByEmail[email].push(item);
  });
}

async function loadAnnouncementsFromApi() {
  const data = await apiGet('/api/hr/announcements');
  hrCache.announcements = (data.items || []).map(item => ({
    id: Number(item.id),
    title: item.title,
    description: item.description,
    image: item.image || '',
    visible: item.visible !== false && item.visible !== 0,
    date: item.date,
  }));
}

async function loadEmployeeSnapshot(email) {
  const normalizedEmail = String(email || '').toLowerCase();
  if (!normalizedEmail) return;

  const data = await apiGet('/api/hr/snapshot?email=' + encodeURIComponent(normalizedEmail));
  const snapshot = data.snapshot || {};
  hrCache.leavesByEmail[normalizedEmail] = (snapshot.leaves || []).map(item => ({ ...normalizeLeaveRecord(item), employeeEmail: normalizedEmail }));
  hrCache.attendanceByEmail[normalizedEmail] = (snapshot.attendance || []).map(normalizeAttendanceRecord);
  hrCache.trainingsByEmail[normalizedEmail] = (snapshot.trainings || []).map(normalizeTrainingRecord);
  hrCache.evaluationsByEmail[normalizedEmail] = snapshot.evaluation || { status: '' };
  hrCache.pdsDataByEmail[normalizedEmail] = snapshot.pdsData || {};

  allLeavesCache = allLeavesCache.filter(item => item.employeeEmail !== normalizedEmail).concat(hrCache.leavesByEmail[normalizedEmail]);
}

function getUsers() {
  return adminUsers;
}

function showAuthMessage(text, ok) {
  const msg = document.getElementById('adminAuthMessage');
  if (!msg) return;
  msg.textContent = text;
  msg.className = 'message';
  if (!text) return;
  msg.classList.add(ok ? 'ok' : 'err');
}

function userKey(type, email) {
  return 'chris_' + type + '_' + email;
}

async function initializeAdminPortal() {
  const sessionEmail = getSession();
  const role = getUserRole();
  if (!sessionEmail || role !== 'admin') {
    window.location.href = '/login.html';
    return;
  }

  await openAdminPanel();
  setAdminProfile();
  // Check for leave notifications
  checkForNewLeaveNotifications();
  // Poll for new leave requests every 2 seconds
  setInterval(checkForNewLeaveNotifications, 2000);
}

function setAdminProfile() {
  const avatar = document.getElementById('adminProfileAvatar');
  const name = document.getElementById('adminProfileName');
  if (avatar) avatar.textContent = getInitials(ADMIN_NAME);
  if (name) name.textContent = getFirstName(ADMIN_NAME);
}

function getFirstName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : 'Admin';
}

function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

async function openAdminPanel() {
  document.getElementById('adminDashboardSection').classList.remove('hidden');
  document.getElementById('adminLogoutBtn').classList.remove('hidden');

  await loadUsersFromApi();
  await Promise.all([loadAllLeavesFromApi(), loadAnnouncementsFromApi()]);
  populateOverviewDepartmentFilter();
  
  // Show overview page by default
  showAdminPage('overview');
  await renderAdminOverview();
  
  hydrateEmployeeSelect();
  renderGlobalAnnouncements();
}

function adminLogout() {
  if (!window.confirm('Are you sure you want to logout?')) {
    return;
  }
  clearSession();
  selectedEmployeeEmail = '';
  lastNotificationIds = [];
  localStorage.removeItem('admin_last_notification_ids');
  window.location.href = '/index.html';
}

function hydrateEmployeeSelect() {
  const users = getUsers();

  hydrateSelectOptions('employeeSelect', users);
  hydrateSelectOptions('civhrEmployeeSelect', users);
  hydrateSelectOptions('trainingEmployeeSelect', users);
  populateEmployeeDirectoryFilters();
  
  if (!users.length) {
    selectedEmployeeEmail = '';
    const selectedText = document.getElementById('selectedEmployeeText');
    if (selectedText) selectedText.textContent = 'None';
    renderEmployeeProfileForm();
    renderEmployeeLeaves();
    renderEmployeeAttendance();
    hydrateEmployeeEvaluation();
    renderPersonalDataSheet();
    renderTrainingMonitoring();
    return;
  }

  if (!selectedEmployeeEmail || !users.some(u => u.email === selectedEmployeeEmail)) {
    selectedEmployeeEmail = users[0].email;
  }

  syncEmployeeSelectors();
  selectEmployee();
}

function renderEmployeeDirectory() {
  const tbody = document.querySelector('#employeeDirectoryTable tbody');
  const list = document.getElementById('employeeDirectoryList');
  const count = document.getElementById('employeeDirectoryCount');
  if (!tbody && !list) return;

  const query = String(document.getElementById('employeeDirectorySearch')?.value || '').trim().toLowerCase();
  const statusFilter = String(document.getElementById('employeeDirectoryStatusFilter')?.value || '').trim().toLowerCase();
  const totalUsers = getUsers().length;
  const users = getUsers().filter(user => {
    const profile = getEmployeeProfileByEmail(user.email);
    const employeeStatus = String(profile.employmentStatus || user.employmentStatus || 'Active').toLowerCase();
    if (statusFilter && employeeStatus !== statusFilter) return false;
    if (!query) return true;
    const haystack = [user.name, user.email, 'CHR', user.position, user.employeeId, user.employmentStatus].join(' ').toLowerCase();
    return haystack.includes(query);
  });

  if (tbody) tbody.innerHTML = '';
  if (list) list.innerHTML = '';
  if (count) {
    const label = users.length === 1 ? 'employee' : 'employees';
    count.textContent = `${users.length} of ${totalUsers} ${label}`;
  }

  if (!users.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6">No matching employees found.</td></tr>';
    if (list) list.innerHTML = '<div class="employee-directory-empty"><strong>No matching employees</strong><span>Try a different search term or status filter.</span></div>';
    renderEmployeeManagementKpis();
    return;
  }

  users.forEach(user => {
    const normalizedEmail = String(user.email || '').toLowerCase();
    const userId = Number(user.id || 0);
    const profile = getEmployeeProfileByEmail(normalizedEmail);
    const selectedClass = normalizedEmail === selectedEmployeeEmail ? ' is-selected' : '';
    const employeeId = profile.employeeId || user.employeeId || 'No ID';
    const employmentStatus = profile.employmentStatus || user.employmentStatus || 'Active';
    if (list) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `employee-list-item${selectedClass}`;
      if (selectedClass) item.setAttribute('aria-current', 'true');
      item.onclick = () => selectEmployeeByEmail(normalizedEmail);
      item.innerHTML = `
        <span class="employee-list-avatar">${renderEmployeeAvatar(user, profile)}</span>
        <span class="employee-list-main">
          <strong>${escapeHtml(user.name || normalizedEmail)}</strong>
          <small>${escapeHtml(normalizedEmail)}</small>
          <span class="employee-list-tags">
            <span>${escapeHtml(user.position || 'No position')}</span>
            <span>CHR</span>
            <span>${escapeHtml(employeeId)}</span>
          </span>
        </span>
        <span class="employee-status-pill status-${escapeHtml(getEmploymentStatusClass(employmentStatus))}">${escapeHtml(employmentStatus)}</span>`;
      list.appendChild(item);
    }

    const row = `
      <tr>
        <td>${escapeHtml(user.name || '-')}</td>
        <td>${escapeHtml(user.email || '-')}</td>
        <td>CHR</td>
        <td>${escapeHtml(user.position || '-')}</td>
        <td>${renderEmployeeDirectoryBadges(normalizedEmail)}</td>
        <td>
          <div class="actions" style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-outline" onclick="viewEmployeeFullProfile('${String(user.email || '').replace(/'/g, "\\'")}')">View Profile</button>
            <button class="btn btn-danger" onclick="deleteEmployeeById(${userId})">Terminate</button>
          </div>
        </td>
      </tr>`;
    if (tbody) tbody.innerHTML += row;
  });

  renderEmployeeManagementKpis();
  renderEmployeeContextHeaders();
}

function getSelectedEmployeeProfile() {
  const pdsData = hrCache.pdsDataByEmail[selectedEmployeeEmail] || {};
  return pdsData.employeeProfile || {};
}

function getEmployeeProfileByEmail(email) {
  const normalizedEmail = String(email || '').toLowerCase();
  const pdsData = hrCache.pdsDataByEmail[normalizedEmail] || {};
  return pdsData.employeeProfile || {};
}

function getEmploymentStatusClass(status) {
  return String(status || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function renderEmployeeAvatar(user = {}, profile = {}) {
  const image = profile.profilePhoto || user.profileImage || '';
  if (image) {
    return `<img src="${escapeHtml(image)}" alt="">`;
  }
  return escapeHtml(getInitials(user.name || user.email || 'E'));
}

function renderEmployeeManagementKpis() {
  const container = document.getElementById('employeeManagementKpis');
  if (!container) return;

  const users = getUsers();
  const activeStatuses = new Set(['active', 'probationary', 'on leave', 'contractual']);
  const activeCount = users.filter(user => {
    const profile = getEmployeeProfileByEmail(user.email);
    return activeStatuses.has(String(profile.employmentStatus || user.employmentStatus || 'Active').toLowerCase());
  }).length;
  const pendingLeaves = getAllEmployeesLeaves().filter(item => String(item.status || '').toLowerCase() === 'pending').length;
  const missingPds = users.filter(user => !(hrCache.pdsDataByEmail[String(user.email || '').toLowerCase()] || {}).submittedAt).length;

  container.innerHTML = `
    <div class="metric-card"><p class="metric-label">Employees</p><h3>${users.length}</h3><p class="metric-sub">${activeCount} active or in service</p></div>
    <div class="metric-card"><p class="metric-label">Department</p><h3>CHR</h3><p class="metric-sub">Managed by this website</p></div>
    <div class="metric-card"><p class="metric-label">Pending Leave</p><h3>${pendingLeaves}</h3><p class="metric-sub">Needs admin action</p></div>
    <div class="metric-card"><p class="metric-label">Missing PDS</p><h3>${missingPds}</h3><p class="metric-sub">Employees without submission</p></div>
  `;
}

function populateEmployeeDirectoryFilters() {
  const select = document.getElementById('employeeDirectoryDepartmentFilter');
  if (!select) return;

  select.innerHTML = '<option value="CHR">CHR</option>';
  select.value = 'CHR';
}

function getSelectedEmployeeDisplayData() {
  const user = getUsers().find(u => String(u.email || '').toLowerCase() === selectedEmployeeEmail) || {};
  const profile = getSelectedEmployeeProfile();
  const pdsData = hrCache.pdsDataByEmail[selectedEmployeeEmail] || {};
  const evaluation = hrCache.evaluationsByEmail[selectedEmployeeEmail] || {};
  return { user, profile, pdsData, evaluation };
}

function renderEmployeeContextHeaders() {
  const targets = ['employeeActivityContext', 'employeeRecordsContext'];
  const html = (() => {
    if (!selectedEmployeeEmail) return '<p class="form-note">Select an employee from the Overview tab first.</p>';
    const { user, profile } = getSelectedEmployeeDisplayData();
    return `
      <div class="employee-context-avatar">${renderEmployeeAvatar(user, profile)}</div>
      <div>
        <strong>${escapeHtml(user.name || selectedEmployeeEmail)}</strong>
        <p class="form-note">${escapeHtml(user.email || selectedEmployeeEmail)} &middot; ${escapeHtml(user.position || 'No position')} &middot; CHR</p>
      </div>`;
  })();

  targets.forEach(id => {
    const element = document.getElementById(id);
    if (element) element.innerHTML = html;
  });
}

function showEmployeeManagementTab(tabName = 'overview') {
  const tabs = ['overview', 'profile', 'activity', 'records'];
  const activeTab = tabs.includes(tabName) ? tabName : 'overview';
  const layout = document.getElementById('employeeDirectoryProfileLayout');

  tabs.forEach(tab => {
    const tabButton = document.getElementById('employeeTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (tabButton) tabButton.classList.toggle('active', tab === activeTab);
  });

  const show = (id, visible) => {
    const element = document.getElementById(id);
    if (element) element.classList.toggle('hidden', !visible);
  };

  show('employeeDirectoryPanel', activeTab === 'overview');
  show('employeeManagementSummary', activeTab === 'overview');
  show('employeeProfileManager', activeTab === 'profile');
  show('employeeLeavePanel', activeTab === 'activity');
  show('employeeAttendancePanel', activeTab === 'activity');
  show('employeeEvaluationPanel', activeTab === 'activity');
  show('employeePromotionPanel', activeTab === 'records');
  show('employeeDisciplinaryPanel', activeTab === 'records');

  if (layout) {
    layout.classList.toggle('is-single-panel', activeTab === 'overview' || activeTab === 'profile');
    layout.classList.toggle('hidden', activeTab === 'activity' || activeTab === 'records');
  }
}

function renderEmployeeProfileForm() {
  const profile = getSelectedEmployeeProfile();
  const user = getUsers().find(u => u.email === selectedEmployeeEmail) || {};

  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.value = value || '';
  };

  setValue('employeeProfileFullName', user.name || '');
  setValue('employeeProfileUsername', user.username || '');
  setValue('employeeProfileEmail', user.email || '');
  const emailField = document.getElementById('employeeProfileEmail');
  if (emailField) emailField.readOnly = Boolean(selectedEmployeeEmail);
  setValue('employeeProfileEmployeeId', profile.employeeId || '');
  setValue('employeeProfileDepartment', 'CHR');
  setValue('employeeProfilePosition', user.position || '');
  setValue('employeeProfileEmploymentStatus', profile.employmentStatus || 'Active');
  setValue('employeeProfileGender', user.gender || '');
  setValue('employeeProfileDateHired', profile.dateHired || '');
  setValue('employeeProfileContactInfo', profile.contactInfo || user.phone || '');
  setValue('employeeProfileAddress', profile.address || '');
  setValue('employeeProfileEmergencyContact', profile.emergencyContact || '');
  setValue('employeeProfileRole', user.role || 'employee');

  const photoPreview = document.getElementById('employeeProfilePhotoPreview');
  const photoData = profile.profilePhoto || user.profileImage || '';
  if (photoPreview) {
    photoPreview.src = photoData || '';
    photoPreview.style.display = photoData ? 'block' : 'none';
  }

  const photoField = document.getElementById('employeeProfilePhotoData');
  if (photoField) photoField.value = photoData || '';

  const statusHint = document.getElementById('employeeProfileModeHint');
  if (statusHint) {
    statusHint.textContent = selectedEmployeeEmail ? `Editing ${user.name || selectedEmployeeEmail}` : 'Select an employee from the Overview tab to edit their profile';
  }

  renderEmployeeContextHeaders();
}

function getLatestPdsSubmission(pdsData) {
  const history = Array.isArray(pdsData?.submissionHistory) ? pdsData.submissionHistory : [];
  return history[0] || pdsData?.lastSubmission || null;
}

function getCurrentPdsPersonalInfo(pdsData, user) {
  const latestSubmission = getLatestPdsSubmission(pdsData) || {};
  const latestPersonalInfo = pdsData?.latestPersonalInfo || latestSubmission.personalInfo || {};
  const employeeProfile = pdsData?.employeeProfile || {};

  return {
    employeeNumber: latestPersonalInfo.employeeNumber || employeeProfile.employeeId || user?.employeeId || '',
    phoneNumber: latestPersonalInfo.phoneNumber || employeeProfile.contactInfo || user?.phone || '',
    department: latestPersonalInfo.department || user?.department || 'CHR',
    position: latestPersonalInfo.position || user?.position || '',
  };
}

function getPdsFileViewLink(pdsFile) {
  if (!pdsFile || !pdsFile.fileData) {
    return '<span class="form-note">No uploaded PDS file.</span>';
  }

  const fileName = escapeHtml(pdsFile.fileName || 'uploaded-pds');
  const fileType = escapeHtml(pdsFile.fileType || 'application/octet-stream');
  const href = escapeHtml(pdsFile.fileData);

  return `
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      <a class="btn btn-outline" href="${href}" target="_blank" rel="noopener noreferrer">Open uploaded PDS</a>
      <button class="btn btn-outline" onclick="downloadPdsFile('${escapeHtml(selectedEmployeeEmail)}')">Download as PDF</button>
    </div>
    <p class="form-note" style="margin:8px 0 0;">${fileName} • ${fileType}</p>
  `;
}

function downloadPdsFile(email) {
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!normalizedEmail) {
    showNotification('No employee selected.', 'error', 2500);
    return;
  }

  const downloadUrl = `/api/pds/download/${encodeURIComponent(normalizedEmail)}?email=${encodeURIComponent(normalizedEmail)}`;
  
  // Create a temporary link and trigger download
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `pds-${normalizedEmail.replace('@', '-at-')}.pdf`;
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showNotification('PDS file download started.', 'success', 2500);
}

function clearEmployeeProfileForm() {
  selectedEmployeeEmail = '';
  syncEmployeeSelectors();
  showEmployeeManagementTab('profile');

  const selectedText = document.getElementById('selectedEmployeeText');
  if (selectedText) selectedText.textContent = 'None';

  ['employeeProfileFullName', 'employeeProfileUsername', 'employeeProfileEmail', 'employeeProfileEmployeeId', 'employeeProfileEmploymentStatus', 'employeeProfileGender', 'employeeProfileDepartment', 'employeeProfilePosition', 'employeeProfileDateHired', 'employeeProfileContactInfo', 'employeeProfileAddress', 'employeeProfileEmergencyContact', 'employeeProfilePhotoData'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.value = '';
  });

  const role = document.getElementById('employeeProfileRole');
  if (role) role.value = 'employee';
  const status = document.getElementById('employeeProfileEmploymentStatus');
  if (status) status.value = 'Active';
  const preview = document.getElementById('employeeProfilePhotoPreview');
  if (preview) {
    preview.src = '';
    preview.style.display = 'none';
  }

  renderEmployeeProfileForm();
  renderEmployeeDirectory();
  renderEmployeeManagementKpis();
  renderEmployeeManagementSummary();
  renderPromotionHistoryTable();
  renderDisciplinaryRecordsTable();
  renderEmployeeLeaves();
  renderEmployeeAttendance();
  hydrateEmployeeEvaluation();
}

function viewEmployeeFullProfile(email) {
  showAdminPage('employees');
  selectEmployeeByEmail(email);
  showEmployeeManagementTab('profile');
}

async function deleteEmployeeById(id) {
  const user = getUsers().find(item => Number(item.id) === Number(id));
  if (!user) {
    alert('Employee not found.');
    return;
  }

  const normalizedEmail = String(user.email || '').toLowerCase();
  const currentPdsData = hrCache.pdsDataByEmail[normalizedEmail] || {};
  const currentProfile = currentPdsData.employeeProfile || {};
  if (String(currentProfile.employmentStatus || user.employmentStatus || '').toLowerCase() === 'terminated') {
    showNotification(`${user.name || user.email} is already marked as terminated.`, 'info', 2500);
    return;
  }

  if (!confirm(`Mark ${user.name || user.email} as terminated? Their employee records will be kept for tracking.`)) {
    return;
  }

  const terminatedPdsData = {
    ...currentPdsData,
    employeeProfile: {
      ...currentProfile,
      employmentStatus: 'Terminated',
      terminatedAt: new Date().toISOString(),
    },
  };
  hrCache.pdsDataByEmail[normalizedEmail] = terminatedPdsData;

  try {
    await apiSend('/api/users/profile', 'PUT', {
      email: normalizedEmail,
      pdsData: terminatedPdsData,
    });
  } catch (_) {
    hrCache.pdsDataByEmail[normalizedEmail] = currentPdsData;
    showNotification('Failed to mark employee as terminated.', 'error', 2500);
    return;
  }

  logAdminAction('Terminate Employee', normalizedEmail, 'Marked employee status as Terminated');
  selectedEmployeeEmail = normalizedEmail;
  renderEmployeeDirectory();
  renderEmployeeProfileForm();
  renderEmployeeManagementSummary();
  renderEmployeeContextHeaders();
  renderEmployeeManagementKpis();
  showNotification('Employee marked as terminated. Records were kept.', 'success', 2500);

  Promise.allSettled([
    loadUsersFromApi(),
    loadEmployeeSnapshot(normalizedEmail),
    refreshOverviewInsights(),
  ]).then(() => {
    hydrateEmployeeSelect();
    renderEmployeeDirectory();
    renderEmployeeProfileForm();
    renderEmployeeManagementSummary();
    renderEmployeeContextHeaders();
    renderEmployeeManagementKpis();
  });
}

function renderEmployeeDirectoryBadges(email) {
  const leaves = hrCache.leavesByEmail[email] || [];
  const trainings = hrCache.trainingsByEmail[email] || [];
  const evaluation = hrCache.evaluationsByEmail[email] || {};
  const pdsData = hrCache.pdsDataByEmail[email] || {};
  const employeeProfile = pdsData.employeeProfile || {};

  const pendingLeaves = leaves.filter(l => String(l.status || '').toLowerCase() === 'pending').length;
  const approvedLeaves = leaves.filter(l => String(l.status || '').toLowerCase() === 'approved').length;
  const completedTrainings = trainings.filter(t => String(t.status || '').toLowerCase() === 'completed').length;
  const assignedTrainings = trainings.length;
  const pdsStatus = pdsData.submittedAt ? 'submitted' : 'not submitted';
  const evaluationStatus = evaluation.status ? String(evaluation.status) : 'Unrated';

  const badges = [];
  badges.push(`<span class="badge badge-secondary">${escapeHtml(employeeProfile.employmentStatus || 'Active')}</span>`);
  badges.push(`<span class="badge ${pdsData.submittedAt ? 'badge-info' : 'badge-secondary'}">PDS ${escapeHtml(pdsStatus)}</span>`);
  badges.push(`<span class="badge ${assignedTrainings && completedTrainings === assignedTrainings ? 'badge-success' : 'badge-warning'}">${assignedTrainings ? `${completedTrainings}/${assignedTrainings} trainings` : 'No trainings'}</span>`);
  if (pendingLeaves) {
    badges.push(`<span class="badge badge-warning">${pendingLeaves} leave pending</span>`);
  } else if (approvedLeaves) {
    badges.push(`<span class="badge badge-success">${approvedLeaves} approved leaves</span>`);
  } else {
    badges.push('<span class="badge badge-secondary">No leave data</span>');
  }
  badges.push(`<span class="badge badge-info">${escapeHtml(evaluationStatus)}</span>`);

  return badges.join('');
}

function selectEmployeeByEmail(email) {
  selectedEmployeeEmail = String(email || '').toLowerCase();
  syncEmployeeSelectors();
  selectEmployee();
}

async function selectEmployee() {
  const select = document.getElementById('employeeSelect');
  selectedEmployeeEmail = select ? select.value : selectedEmployeeEmail;
  syncEmployeeSelectors();

  if (selectedEmployeeEmail) {
    await loadEmployeeSnapshot(selectedEmployeeEmail);
  }

  const user = getUsers().find(u => u.email === selectedEmployeeEmail);
  const selectedText = document.getElementById('selectedEmployeeText');
  if (selectedText) {
    selectedText.textContent = user ? user.name + ' (' + user.email + ')' : 'None';
  }

  // Render supporting panels/pages
  renderPersonalDataSheet();
  renderEmployeeManagementSummary();
  renderEmployeeProfileForm();
  renderEmployeeContextHeaders();
  renderPromotionHistoryTable();
  renderDisciplinaryRecordsTable();
  renderEmployeeDirectory();
  renderLeaveMonitoring();
  renderTrainingMonitoring();

  // Render main content
  renderEmployeeLeaves();
  renderEmployeeAttendance();
  hydrateEmployeeEvaluation();
}

function renderEmployeeManagementSummary() {
  const container = document.getElementById('employeeManagementSummaryContent');
  if (!container) return;

  if (!selectedEmployeeEmail) {
    container.innerHTML = '<p class="form-note">Select an employee to view their summary.</p>';
    return;
  }

  const user = getUsers().find(u => u.email === selectedEmployeeEmail) || {};
  const leaves = hrCache.leavesByEmail[selectedEmployeeEmail] || [];
  const trainings = hrCache.trainingsByEmail[selectedEmployeeEmail] || [];
  const attendance = hrCache.attendanceByEmail[selectedEmployeeEmail] || [];
  const evaluation = hrCache.evaluationsByEmail[selectedEmployeeEmail] || { status: 'Not rated' };
  const pdsData = hrCache.pdsDataByEmail[selectedEmployeeEmail] || {};
  const employeeProfile = pdsData.employeeProfile || {};
  const promotionHistory = Array.isArray(employeeProfile.promotionHistory) ? employeeProfile.promotionHistory : [];
  const disciplinaryRecords = Array.isArray(employeeProfile.disciplinaryRecords) ? employeeProfile.disciplinaryRecords : [];

  const approvedLeaves = leaves.filter(l => String(l.status || '').toLowerCase() === 'approved').length;
  const pendingLeaves = leaves.filter(l => String(l.status || '').toLowerCase() === 'pending').length;
  const rejectedLeaves = leaves.filter(l => String(l.status || '').toLowerCase() === 'rejected').length;
  const completedTrainings = trainings.filter(t => String(t.status || '').toLowerCase() === 'completed').length;
  const assignedTrainings = trainings.length;
  const certificationPoints = getCertificationPointSummary(trainings);
  const pointsToTarget = Math.max(PROMOTION_CERTIFICATION_POINT_TARGET - certificationPoints.total, 0);
  const presentCount = attendance.filter(a => String(a.status || '').toLowerCase() === 'present').length;
  const lateCount = attendance.filter(a => String(a.status || '').toLowerCase() === 'late').length;
  const absentCount = attendance.filter(a => String(a.status || '').toLowerCase() === 'absent').length;
  const pdsStatus = pdsData.submittedAt ? `Submitted (${new Date(pdsData.submittedAt).toLocaleDateString()})` : 'Not submitted';
  const lastPdsUpdate = pdsData.updatedAt ? new Date(pdsData.updatedAt).toLocaleDateString() : 'Never';

  container.innerHTML = `
    <div class="overview-grid">
      <div class="metric-card">
        <p class="metric-label">Employee</p>
        <h3>${escapeHtml(user.name || selectedEmployeeEmail)}</h3>
        <p class="metric-sub">${escapeHtml(user.email || '')}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Employee ID</p>
        <h3>${escapeHtml(employeeProfile.employeeId || 'N/A')}</h3>
        <p class="metric-sub">${escapeHtml(employeeProfile.employmentStatus || user.role || 'Employee')}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Date Hired</p>
        <h3>${escapeHtml(employeeProfile.dateHired || 'N/A')}</h3>
        <p class="metric-sub">Last saved: ${escapeHtml(lastPdsUpdate)}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Contact</p>
        <h3>${escapeHtml(employeeProfile.contactInfo || user.phone || 'N/A')}</h3>
        <p class="metric-sub">${escapeHtml(employeeProfile.address || 'No address recorded')}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Emergency Contact</p>
        <h3>${escapeHtml(employeeProfile.emergencyContact || 'N/A')}</h3>
        <p class="metric-sub">${escapeHtml(employeeProfile.address || 'No address recorded')}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Profile Photo</p>
        <h3>${employeeProfile.profilePhoto ? 'Uploaded' : 'Not uploaded'}</h3>
        <p class="metric-sub">Full profile available</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">PDS Status</p>
        <h3>${escapeHtml(pdsStatus)}</h3>
        <p class="metric-sub">Training: ${assignedTrainings} • Attendance: ${attendance.length}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Records</p>
        <h3>${promotionHistory.length + disciplinaryRecords.length}</h3>
        <p class="metric-sub">Promotions: ${promotionHistory.length} • Discipline: ${disciplinaryRecords.length}</p>
      </div>
    </div>
    <div class="overview-grid">
      <div class="metric-card">
        <p class="metric-label">Leave</p>
        <h3>${approvedLeaves} approved</h3>
        <p class="metric-sub">${pendingLeaves} pending • ${rejectedLeaves} rejected</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Training</p>
        <h3>${assignedTrainings}</h3>
        <p class="metric-sub">${completedTrainings} completed</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Certification Points</p>
        <h3>${certificationPoints.total}</h3>
        <p class="metric-sub">${certificationPoints.certificateCount} certificates &bull; ${pointsToTarget ? `${pointsToTarget} to promotion target` : 'Promotion target met'}</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Attendance</p>
        <h3>${presentCount} / ${attendance.length}</h3>
        <p class="metric-sub">Present • ${lateCount} late • ${absentCount} absent</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Evaluation</p>
        <h3>${escapeHtml(evaluation.status || 'Not rated')}</h3>
        <p class="metric-sub">Current rating</p>
      </div>
    </div>
  `;
}

function saveEmployeeProfile() {
  const fullName = String(document.getElementById('employeeProfileFullName')?.value || '').trim();
  const username = String(document.getElementById('employeeProfileUsername')?.value || '').trim().toLowerCase();
  const email = String(document.getElementById('employeeProfileEmail')?.value || '').trim().toLowerCase();
  const employeeId = String(document.getElementById('employeeProfileEmployeeId')?.value || '').trim();
  const department = 'CHR';
  const position = String(document.getElementById('employeeProfilePosition')?.value || '').trim();
  const employmentStatus = String(document.getElementById('employeeProfileEmploymentStatus')?.value || 'Active').trim();
  const gender = String(document.getElementById('employeeProfileGender')?.value || '').trim();
  const dateHired = String(document.getElementById('employeeProfileDateHired')?.value || '').trim();
  const contactInfo = String(document.getElementById('employeeProfileContactInfo')?.value || '').trim();
  const address = String(document.getElementById('employeeProfileAddress')?.value || '').trim();
  const emergencyContact = String(document.getElementById('employeeProfileEmergencyContact')?.value || '').trim();
  const role = String(document.getElementById('employeeProfileRole')?.value || 'employee').trim();
  const profilePhoto = String(document.getElementById('employeeProfilePhotoData')?.value || '').trim();

  if (!fullName || !email) {
    alert('Full name and email are required.');
    return;
  }
  if (username && !/^[a-z0-9._-]{3,30}$/.test(username)) {
    alert('Username must be 3-30 characters and use only letters, numbers, dots, underscores, or hyphens.');
    return;
  }

  const existingUser = getUsers().find(item => String(item.email || '').toLowerCase() === email);
  const employeeProfile = {
    employeeId,
    employmentStatus,
    dateHired,
    contactInfo,
    address,
    emergencyContact,
    profilePhoto,
  };

  const syncProfile = () => apiSend('/api/users/profile', 'PUT', {
    email,
    username,
    name: fullName,
    department,
    position,
    phone: contactInfo,
    profileImage: profilePhoto,
    gender,
    pdsData: { employeeProfile },
  });

  const syncRole = () => {
    if (!existingUser || String(existingUser.role || 'employee') === role) return Promise.resolve();
    return apiSend('/api/admin/users/' + Number(existingUser.id) + '/role', 'PUT', {
      role,
    });
  };

  const finishSave = () => Promise.all([syncProfile(), syncRole()])
    .then(() => Promise.all([loadUsersFromApi(), loadEmployeeSnapshot(email)]))
    .then(() => {
      selectedEmployeeEmail = email;
      syncEmployeeSelectors();
      hydrateEmployeeSelect();
      populateEmployeeDirectoryFilters();
      renderEmployeeDirectory();
      renderEmployeeManagementSummary();
      renderEmployeeProfileForm();
      renderEmployeeContextHeaders();
      renderPromotionHistoryTable();
      renderDisciplinaryRecordsTable();
      populateOverviewDepartmentFilter();
      showNotification('Employee profile saved.', 'success', 2500);
    });

  if (existingUser) {
    finishSave().catch(error => showNotification(error.message || 'Failed to save employee profile.', 'error', 2500));
    return;
  }

  apiSend('/api/admin/users', 'POST', {
    name: fullName,
    username,
    email,
    password: password || 'changeme123',
    role,
  })
    .then(() => finishSave())
    .catch(error => showNotification(error.message || 'Failed to add employee.', 'error', 2500));
}

function handleEmployeeProfilePhotoUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = String(e.target.result || '');
    const field = document.getElementById('employeeProfilePhotoData');
    const preview = document.getElementById('employeeProfilePhotoPreview');
    if (field) field.value = dataUrl;
    if (preview) {
      preview.src = dataUrl;
      preview.style.display = 'block';
    }
  };
  reader.readAsDataURL(file);
}

function clearEmployeeProfilePhoto() {
  const field = document.getElementById('employeeProfilePhotoData');
  const preview = document.getElementById('employeeProfilePhotoPreview');
  const input = document.getElementById('employeeProfilePhotoInput');
  if (field) field.value = '';
  if (preview) {
    preview.src = '';
    preview.style.display = 'none';
  }
  if (input) input.value = '';
}

function renderPromotionHistoryTable() {
  const tbody = document.querySelector('#promotionHistoryTable tbody');
  if (!tbody) return;

  if (!selectedEmployeeEmail) {
    tbody.innerHTML = '<tr><td colspan="5">Select an employee to view promotion history.</td></tr>';
    return;
  }

  const profile = getSelectedEmployeeProfile();
  const history = Array.isArray(profile.promotionHistory) ? profile.promotionHistory : [];

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="5">No promotion history recorded.</td></tr>';
    return;
  }

  tbody.innerHTML = history.map(item => `
    <tr>
      <td>${escapeHtml(formatDateOnly(item.date) || '-')}</td>
      <td>${escapeHtml(item.from || item.previousPosition || '-')}</td>
      <td>${escapeHtml(item.to || item.newPosition || '-')}</td>
      <td>${escapeHtml(item.notes || item.reason || '-')}</td>
      <td><button class="btn btn-danger" type="button" onclick="deletePromotionRecord(${Number(item.id || 0)})">Delete</button></td>
    </tr>
  `).join('');
}

function renderDisciplinaryRecordsTable() {
  const tbody = document.querySelector('#disciplinaryRecordsTable tbody');
  if (!tbody) return;

  if (!selectedEmployeeEmail) {
    tbody.innerHTML = '<tr><td colspan="5">Select an employee to view disciplinary records.</td></tr>';
    return;
  }

  const profile = getSelectedEmployeeProfile();
  const history = Array.isArray(profile.disciplinaryRecords) ? profile.disciplinaryRecords : [];

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="5">No disciplinary records recorded.</td></tr>';
    return;
  }

  tbody.innerHTML = history.map(item => `
    <tr>
      <td>${escapeHtml(formatDateOnly(item.date) || '-')}</td>
      <td>${escapeHtml(item.type || item.action || '-')}</td>
      <td>${escapeHtml(item.details || item.notes || '-')}</td>
      <td>${escapeHtml(item.status || 'Open')}</td>
      <td><button class="btn btn-danger" type="button" onclick="deleteDisciplinaryRecord(${Number(item.id || 0)})">Delete</button></td>
    </tr>
  `).join('');
}

function saveEmployeeProfilePatch(employeeProfilePatch) {
  if (!selectedEmployeeEmail) return Promise.reject(new Error('Select an employee first.'));
  const currentPdsData = hrCache.pdsDataByEmail[selectedEmployeeEmail] || {};
  const currentProfile = currentPdsData.employeeProfile || {};
  const nextPdsData = {
    ...currentPdsData,
    employeeProfile: {
      ...currentProfile,
      ...employeeProfilePatch,
    },
  };

  hrCache.pdsDataByEmail[selectedEmployeeEmail] = nextPdsData;
  return apiSend('/api/users/profile', 'PUT', {
    email: selectedEmployeeEmail,
    pdsData: nextPdsData,
  });
}

function addPromotionRecord() {
  if (!selectedEmployeeEmail) {
    alert('Please select an employee first.');
    return;
  }

  const date = String(document.getElementById('promotionDate')?.value || '').trim();
  const from = String(document.getElementById('promotionFrom')?.value || '').trim();
  const to = String(document.getElementById('promotionTo')?.value || '').trim();
  const notes = String(document.getElementById('promotionNotes')?.value || '').trim();
  if (!date || !to) {
    alert('Promotion date and new position are required.');
    return;
  }

  const profile = getSelectedEmployeeProfile();
  const history = Array.isArray(profile.promotionHistory) ? profile.promotionHistory.slice() : [];
  history.unshift({ id: Date.now(), date, from, to, notes });

  saveEmployeeProfilePatch({ promotionHistory: history })
    .then(() => {
      ['promotionDate', 'promotionFrom', 'promotionTo', 'promotionNotes'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.value = '';
      });
      renderPromotionHistoryTable();
      renderEmployeeManagementSummary();
      renderEmployeeDirectory();
      logAdminAction('Add Promotion Record', selectedEmployeeEmail, `${from || '-'} to ${to}`);
      showNotification('Promotion record added.', 'success', 2500);
    })
    .catch(() => showNotification('Failed to add promotion record.', 'error', 2500));
}

function deletePromotionRecord(id) {
  if (!selectedEmployeeEmail || !id) return;
  const profile = getSelectedEmployeeProfile();
  const history = (Array.isArray(profile.promotionHistory) ? profile.promotionHistory : []).filter(item => Number(item.id) !== Number(id));
  saveEmployeeProfilePatch({ promotionHistory: history })
    .then(() => {
      renderPromotionHistoryTable();
      renderEmployeeManagementSummary();
      renderEmployeeDirectory();
      logAdminAction('Delete Promotion Record', selectedEmployeeEmail, `Removed promotion #${id}`);
      showNotification('Promotion record deleted.', 'success', 2200);
    })
    .catch(() => showNotification('Failed to delete promotion record.', 'error', 2500));
}

function addDisciplinaryRecord() {
  if (!selectedEmployeeEmail) {
    alert('Please select an employee first.');
    return;
  }

  const date = String(document.getElementById('disciplinaryDate')?.value || '').trim();
  const type = String(document.getElementById('disciplinaryType')?.value || '').trim();
  const details = String(document.getElementById('disciplinaryDetails')?.value || '').trim();
  const status = String(document.getElementById('disciplinaryStatus')?.value || 'Open').trim();
  if (!date || !type || !details) {
    alert('Date, type, and details are required.');
    return;
  }

  const profile = getSelectedEmployeeProfile();
  const history = Array.isArray(profile.disciplinaryRecords) ? profile.disciplinaryRecords.slice() : [];
  history.unshift({ id: Date.now(), date, type, details, status });

  saveEmployeeProfilePatch({ disciplinaryRecords: history })
    .then(() => {
      ['disciplinaryDate', 'disciplinaryType', 'disciplinaryDetails'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.value = '';
      });
      const statusEl = document.getElementById('disciplinaryStatus');
      if (statusEl) statusEl.value = 'Open';
      renderDisciplinaryRecordsTable();
      renderEmployeeManagementSummary();
      renderEmployeeDirectory();
      logAdminAction('Add Disciplinary Record', selectedEmployeeEmail, `${type}: ${details}`);
      showNotification('Disciplinary record added.', 'success', 2500);
    })
    .catch(() => showNotification('Failed to add disciplinary record.', 'error', 2500));
}

function deleteDisciplinaryRecord(id) {
  if (!selectedEmployeeEmail || !id) return;
  const profile = getSelectedEmployeeProfile();
  const history = (Array.isArray(profile.disciplinaryRecords) ? profile.disciplinaryRecords : []).filter(item => Number(item.id) !== Number(id));
  saveEmployeeProfilePatch({ disciplinaryRecords: history })
    .then(() => {
      renderDisciplinaryRecordsTable();
      renderEmployeeManagementSummary();
      renderEmployeeDirectory();
      logAdminAction('Delete Disciplinary Record', selectedEmployeeEmail, `Removed disciplinary record #${id}`);
      showNotification('Disciplinary record deleted.', 'success', 2200);
    })
    .catch(() => showNotification('Failed to delete disciplinary record.', 'error', 2500));
}

function hydrateSelectOptions(selectId, users) {
  const select = document.getElementById(selectId);
  if (!select) return;

  select.innerHTML = '<option value="">-- Select Employee --</option>';
  users.forEach(u => {
    const option = document.createElement('option');
    option.value = u.email;
    option.textContent = u.name + ' (' + u.email + ')';
    select.appendChild(option);
  });
}

function syncEmployeeSelectors() {
  ['employeeSelect', 'civhrEmployeeSelect', 'trainingEmployeeSelect'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.value = selectedEmployeeEmail || '';
  });
}

function selectEmployeeFrom(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  selectedEmployeeEmail = select.value;
  syncEmployeeSelectors();
  selectEmployee();
}

function switchAdminSidebarTab(tabName) {
  // Hide all panels
  document.getElementById('personalDataPanel').style.display = 'none';
  document.getElementById('leaveMonitoringPanel').style.display = 'none';
  document.getElementById('trainingMonitoringPanel').style.display = 'none';

  // Remove active class from all buttons
  document.getElementById('personalDataBtn').classList.remove('active');
  document.getElementById('leaveMonitoringBtn').classList.remove('active');
  document.getElementById('trainingMonitoringBtn').classList.remove('active');

  // Show selected panel and mark button as active
  if (tabName === 'personal') {
    document.getElementById('personalDataPanel').style.display = 'block';
    document.getElementById('personalDataBtn').classList.add('active');
  } else if (tabName === 'leave') {
    document.getElementById('leaveMonitoringPanel').style.display = 'block';
    document.getElementById('leaveMonitoringBtn').classList.add('active');
    renderLeaveMonitoring(); // Refresh the leave monitoring to show latest
  } else if (tabName === 'training') {
    document.getElementById('trainingMonitoringPanel').style.display = 'block';
    document.getElementById('trainingMonitoringBtn').classList.add('active');
  }
}

function getEmployeeLeaves() {
  if (!selectedEmployeeEmail) return [];
  return hrCache.leavesByEmail[selectedEmployeeEmail] || [];
}

function saveEmployeeLeaves(items) {
  if (!selectedEmployeeEmail) return;
  hrCache.leavesByEmail[selectedEmployeeEmail] = items;
  allLeavesCache = allLeavesCache.filter(item => item.employeeEmail !== selectedEmployeeEmail).concat(items.map(item => ({ ...item, employeeEmail: selectedEmployeeEmail })));
  apiSend('/api/hr/leaves', 'PUT', { email: selectedEmployeeEmail, items }).catch(() => {});
}

function updateEmployeeLeaveStatus(leaveId, status) {
  const items = getEmployeeLeaves().map(item =>
    item.id === leaveId ? { ...item, status } : item
  );
  saveEmployeeLeaves(items);
  logAdminAction('Update Leave Status', selectedEmployeeEmail, `Leave #${leaveId} marked as ${status}`);
  renderEmployeeLeaves();
  renderEmployeeManagementSummary();
  renderEmployeeContextHeaders();
  renderLeaveMonitoring();
}

function renderEmployeeLeaves() {
  const tbody = document.querySelector('#adminLeaveTable tbody');
  tbody.innerHTML = '';

  const items = getEmployeeLeaves();
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5">No leave requests for this employee.</td></tr>';
    return;
  }

  items.forEach(item => {
    const cssClass = (item.status || 'Pending').toLowerCase();
    const row = `
      <tr>
        <td>${item.type}</td>
        <td>${item.start}</td>
        <td>${item.end}</td>
        <td>${item.days}</td>
        <td><span class="status ${cssClass}">${item.status}</span></td>
      </tr>`;
    tbody.innerHTML += row;
  });
}

function getEmployeeEvaluation() {
  if (!selectedEmployeeEmail) return { status: '', updatedAt: null };
  const raw = hrCache.evaluationsByEmail[selectedEmployeeEmail] || { status: '' };
  const allowedStatuses = new Set([
    'Outstanding',
    'Very Satisfactory',
    'Satisfactory',
    'Unsatisfactory',
    'Poor',
  ]);

  return {
    status: allowedStatuses.has(raw.status) ? raw.status : '',
    updatedAt: raw.updatedAt || null,
  };
}

function hydrateEmployeeEvaluation() {
  const evaluation = getEmployeeEvaluation();
  document.getElementById('adminEvaluationStatus').value = evaluation.status || 'Satisfactory';
  
  // Display save status
  const statusElement = document.getElementById('evaluationSaveStatus');
  if (statusElement) {
    if (evaluation.updatedAt) {
      const savedDate = new Date(evaluation.updatedAt);
      const formattedDate = savedDate.toLocaleString();
      statusElement.innerHTML = `<div style="background:#d1fae5; padding:10px; border-radius:6px; border:1px solid #6ee7b7; color:#065f46;"><strong style="display:flex; align-items:center; gap:6px;">✓ Evaluation Saved</strong><small style="margin-top:4px; display:block;">${escapeHtml(formattedDate)}</small></div>`;
      statusElement.style.display = 'block';
    } else {
      statusElement.innerHTML = '<div style="background:#fef3c7; padding:10px; border-radius:6px; border:1px solid #fcd34d; color:#78350f;"><strong>Not saved yet</strong></div>';
      statusElement.style.display = 'block';
    }
  }
}

function saveEmployeeEvaluation() {
  if (!selectedEmployeeEmail) return;

  const payload = {
    status: document.getElementById('adminEvaluationStatus').value
  };
  hrCache.evaluationsByEmail[selectedEmployeeEmail] = payload;
  apiSend('/api/hr/evaluations', 'PUT', { email: selectedEmployeeEmail, status: payload.status }).catch(() => {});
  logAdminAction('Save Evaluation', selectedEmployeeEmail, `Rating set to ${payload.status}`);
  renderEmployeeManagementSummary();
  renderEmployeeContextHeaders();
}

function getEmployeeAttendance() {
  if (!selectedEmployeeEmail) return [];
  return hrCache.attendanceByEmail[selectedEmployeeEmail] || [];
}

function saveEmployeeAttendance(items) {
  if (!selectedEmployeeEmail) return;
  const normalizedItems = (items || []).map(normalizeAttendanceRecord);
  hrCache.attendanceByEmail[selectedEmployeeEmail] = normalizedItems;
  apiSend('/api/hr/attendance', 'PUT', { email: selectedEmployeeEmail, items: normalizedItems }).catch(() => {});
}

function addEmployeeAttendance() {
  if (!selectedEmployeeEmail) return;

  let date = document.getElementById('adminAttendanceDate').value;
  const timeIn = document.getElementById('adminAttendanceTimeIn')?.value || '';
  const timeOut = document.getElementById('adminAttendanceTimeOut')?.value || '';
  const selected = document.querySelector('input[name="adminAttendanceStatus"]:checked');
  const status = selected ? selected.value : 'Present';
  if (!date) {
    date = getLocalDateString();
    document.getElementById('adminAttendanceDate').value = date;
  }

  const items = getEmployeeAttendance();
  items.unshift({ id: Date.now(), date, timeIn, timeOut, status });
  saveEmployeeAttendance(items);
  logAdminAction('Add Attendance', selectedEmployeeEmail, `${date} marked as ${status} (${timeIn || 'no time in'} - ${timeOut || 'no time out'})`);
  renderEmployeeAttendance();
  renderEmployeeManagementSummary();
  renderEmployeeContextHeaders();
}

function removeEmployeeAttendance(id) {
  const items = getEmployeeAttendance().filter(item => item.id !== id);
  saveEmployeeAttendance(items);
  logAdminAction('Delete Attendance', selectedEmployeeEmail, `Removed attendance record #${id}`);
  renderEmployeeAttendance();
  renderEmployeeManagementSummary();
  renderEmployeeContextHeaders();
}

// ============ Sidebar Dashboard Functions ============

function renderPersonalDataSheet() {
  const container = document.getElementById('personalDataSheet');
  if (!container) return;
  
  if (!selectedEmployeeEmail) {
    container.innerHTML = '<p class="form-note">Select an employee to view personal data.</p>';
    return;
  }

  const user = getUsers().find(u => u.email === selectedEmployeeEmail);
  if (!user) {
    container.innerHTML = '<p class="form-note">Employee data not found.</p>';
    return;
  }

  const pdsData = hrCache.pdsDataByEmail[selectedEmployeeEmail] || {};
  const latestSubmission = getLatestPdsSubmission(pdsData);
  const personalInfo = getCurrentPdsPersonalInfo(pdsData, user);
  const pdsSavedAt = pdsData.updatedAt ? new Date(pdsData.updatedAt).toLocaleString() : 'Never saved';
  const pdsSubmitted = latestSubmission?.submittedAt ? `Yes (${new Date(latestSubmission.submittedAt).toLocaleString()})` : 'No';
  const latestFile = latestSubmission?.pdsFile || pdsData.latestUpload || null;

  const history = Array.isArray(pdsData.submissionHistory) ? pdsData.submissionHistory : [];
  const historyRows = history.length
    ? history.map(entry => {
        const pdsFile = entry.pdsFile;
        const fileLink = pdsFile && pdsFile.fileData
          ? `<a href="${escapeHtml(pdsFile.fileData)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline">View</a>`
          : '<span class="form-note">No file</span>';
        return `
        <tr>
          <td>${escapeHtml(entry.submittedAt ? new Date(entry.submittedAt).toLocaleDateString() : '-')}</td>
          <td>${escapeHtml(entry.personalInfo?.employeeNumber || '-')}</td>
          <td>${escapeHtml(entry.personalInfo?.phoneNumber || '-')}</td>
          <td>${escapeHtml(entry.personalInfo?.department || '-')}</td>
          <td>${escapeHtml(entry.personalInfo?.position || '-')}</td>
          <td>${fileLink}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" style="text-align:center; color:#6b7280;">No PDS submissions available.</td></tr>';

  container.innerHTML = `
    <div style="background: #f8fafc; padding: 14px; border-radius: 10px; border: 1px solid #e2e8f0; display:grid; gap:10px;">
      <div class="grid-2">
        <div>
          <label for="pdsEmployeeNumber">Employee Number/ID</label>
          <input id="pdsEmployeeNumber" type="text" value="${escapeHtml(personalInfo.employeeNumber || '')}" readonly>
        </div>
        <div>
          <label for="pdsPhoneNumber">Phone Number</label>
          <input id="pdsPhoneNumber" type="text" value="${escapeHtml(personalInfo.phoneNumber || '')}" readonly>
        </div>
      </div>
      <div class="grid-2">
        <div>
          <label for="pdsDepartmentOffice">Department/Office</label>
          <input id="pdsDepartmentOffice" type="text" value="${escapeHtml(personalInfo.department || '')}" readonly>
        </div>
        <div>
          <label for="pdsPositionDesignation">Position/Designation</label>
          <input id="pdsPositionDesignation" type="text" value="${escapeHtml(personalInfo.position || '')}" readonly>
        </div>
      </div>
      <div style="background:#eef2ff; padding:12px; border-radius:10px; border:1px solid #dbeafe;">
        <p style="margin:0 0 6px 0;"><strong>PDS Saved:</strong> ${pdsSavedAt}</p>
        <p style="margin:0;"><strong>PDS Submitted:</strong> ${pdsSubmitted}</p>
        <div style="margin-top:10px;">${getPdsFileViewLink(latestFile)}</div>
      </div>
      <div class="form-note">View only. Employee-edited information is synced automatically from the employee portal.</div>
      <div style="background:#ffffff; padding:12px; border-radius:10px; border:1px solid #e2e8f0;">
        <h4 style="margin:0 0 10px 0;">PDS Submission History</h4>
        <div class="table-wrap" style="max-height:260px; overflow:auto;">
          <table style="min-width:100%;">
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee ID</th>
                <th>Phone Number</th>
                <th>Department/Office</th>
                <th>Position/Designation</th>
                <th>Uploaded PDS</th>
              </tr>
            </thead>
            <tbody>
              ${historyRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function savePersonalDataSheet() {
  if (!selectedEmployeeEmail) return;

  const payload = {
    email: selectedEmployeeEmail,
    pdsData: {
      latestPersonalInfo: {
        employeeNumber: String(document.getElementById('pdsEmployeeNumber')?.value || '').trim(),
        phoneNumber: String(document.getElementById('pdsPhoneNumber')?.value || '').trim(),
        department: String(document.getElementById('pdsDepartmentOffice')?.value || '').trim(),
        position: String(document.getElementById('pdsPositionDesignation')?.value || '').trim(),
      },
    },
  };

  apiSend('/api/users/profile', 'PUT', payload)
    .then(() => loadUsersFromApi())
    .then(() => {
      hydrateEmployeeSelect();
      renderEmployeeDirectory();
      populateOverviewDepartmentFilter();
      return loadEmployeeSnapshot(selectedEmployeeEmail)
        .catch(() => null)
        .then(() => {
          renderPersonalDataSheet();
          renderEmployeeManagementSummary();
          logAdminAction('Update Personal Data Sheet', selectedEmployeeEmail, 'Updated employee PDS record');
          showNotification('PDS record updated successfully.', 'success', 2500);
        });
    })
    .catch(() => {
      showNotification('Failed to save PDS record.', 'error', 2500);
    });
}

function renderLeaveMonitoring() {
  const container = document.getElementById('leaveMonitoringContent');
  if (!container) return;
  
  if (!selectedEmployeeEmail) {
    container.innerHTML = '<p style="color: #a1a5b4; text-align: center; padding: 20px 10px;">Select an employee to view leave requests</p>';
    return;
  }

  const leaves = getEmployeeLeaves();
  
  if (!leaves.length) {
    container.innerHTML = '<p style="color: #a1a5b4; text-align: center; padding: 15px 10px;">No leave requests</p>';
    return;
  }

  let html = '<div style="max-height: 600px; overflow-y: auto;">';
  
  leaves.forEach(leave => {
    const cssClass = (leave.status || 'Pending').toLowerCase();
    let statusColor = '#a1a5b4';
    if (cssClass === 'approved') statusColor = '#10b981';
    if (cssClass === 'rejected') statusColor = '#ef4444';
    if (cssClass === 'pending') statusColor = '#f59e0b';
    
    html += `
      <div style="background: rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; margin-bottom: 10px; color: white;">
        <p style="margin: 0 0 6px 0; font-weight: 600; font-size: 0.9rem;">${leave.type}</p>
        <p style="margin: 0 0 6px 0; font-size: 0.85rem; color: #a1a5b4;">
          ${leave.start} → ${leave.end}
        </p>
        <p style="margin: 0; font-size: 0.85rem;">
          <span style="background: ${statusColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 0.8rem;">${leave.status}</span>
          <span style="color: #a1a5b4; margin-left: 8px;">${leave.days} days</span>
        </p>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

function getEmployeeTrainings() {
  if (!selectedEmployeeEmail) return [];
  return hrCache.trainingsByEmail[selectedEmployeeEmail] || [];
}

function saveEmployeeTrainings(items) {
  if (!selectedEmployeeEmail) return;
  hrCache.trainingsByEmail[selectedEmployeeEmail] = items;
  apiSend('/api/hr/trainings', 'PUT', { email: selectedEmployeeEmail, items }).catch(() => {});
}

function getEmployeePdsData() {
  if (!selectedEmployeeEmail) return {};
  if (!hrCache.pdsDataByEmail[selectedEmployeeEmail] || typeof hrCache.pdsDataByEmail[selectedEmployeeEmail] !== 'object') {
    hrCache.pdsDataByEmail[selectedEmployeeEmail] = {};
  }
  return hrCache.pdsDataByEmail[selectedEmployeeEmail];
}

function saveEmployeePdsData(pdsData) {
  if (!selectedEmployeeEmail) return;
  hrCache.pdsDataByEmail[selectedEmployeeEmail] = pdsData;
  apiSend('/api/users/profile', 'PUT', { email: selectedEmployeeEmail, pdsData }).catch(() => {});
}

function showAdminLndTab(tabName) {
  const tabs = {
    assign: { tab: 'adminLndAssignTrainingTab', panel: 'adminLndAssignTrainingPanel' },
    records: { tab: 'adminLndTrainingRecordsTab', panel: 'adminLndTrainingRecordsPanel' },
  };

  Object.entries(tabs).forEach(([name, config]) => {
    const tab = document.getElementById(config.tab);
    const panel = document.getElementById(config.panel);
    const active = name === tabName;
    if (tab) {
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (panel) {
      panel.classList.toggle('hidden', !active);
    }
  });

  renderTrainingMonitoring();
}

function assignTrainingToEmployee() {
  const title = String(document.getElementById('adminTrainingTitle')?.value || '').trim();
  const sponsor = String(document.getElementById('adminTrainingSponsor')?.value || '').trim();
  const start = document.getElementById('adminTrainingStart')?.value || '';
  const end = document.getElementById('adminTrainingEnd')?.value || '';
  const hours = Number(document.getElementById('adminTrainingHours')?.value || 0);
  const type = String(document.getElementById('adminTrainingType')?.value || 'Technical');
  const assignAll = Boolean(document.getElementById('adminTrainingAssignAll')?.checked);

  if (!title) {
    alert('Training title is required.');
    return;
  }

  if (assignAll) {
    const users = getUsers();
    if (!users.length) {
      alert('No employees available to assign.');
      return;
    }

    const timestamp = new Date().toISOString();
    const promises = users.map((user, idx) => {
      const email = String(user.email || '').toLowerCase();
      if (!email) return Promise.resolve();
      const items = (hrCache.trainingsByEmail[email] || []).slice();
      items.unshift({
        id: Date.now() + idx,
        title,
        sponsor,
        start,
        end,
        hours,
        type,
        status: 'Assigned',
        source: 'admin',
        assignedAt: timestamp,
      });
      hrCache.trainingsByEmail[email] = items;
      return apiSend('/api/hr/trainings', 'PUT', { email, items }).catch(() => {});
    });

    Promise.all(promises).then(() => {
      logAdminAction('Assign Training', 'all', `${title} (${type})`);
      renderTrainingMonitoring();
      showAdminLndTab('records');
      document.getElementById('adminTrainingTitle').value = '';
      document.getElementById('adminTrainingSponsor').value = '';
      document.getElementById('adminTrainingStart').value = '';
      document.getElementById('adminTrainingEnd').value = '';
      document.getElementById('adminTrainingHours').value = '';
      const cnt = users.length;
      showNotification(`Assigned "${title}" to ${cnt} employees.`, 'success', 3000);
    });

    return;
  }

  if (!selectedEmployeeEmail) {
    alert('Please select an employee first.');
    return;
  }

  const items = getEmployeeTrainings();
  items.unshift({
    id: Date.now(),
    title,
    sponsor,
    start,
    end,
    hours,
    type,
    status: 'Assigned',
    source: 'admin',
    assignedAt: new Date().toISOString(),
  });

  saveEmployeeTrainings(items);
  logAdminAction('Assign Training', selectedEmployeeEmail, `${title} (${type})`);
  renderTrainingMonitoring();
  showAdminLndTab('records');

  document.getElementById('adminTrainingTitle').value = '';
  document.getElementById('adminTrainingSponsor').value = '';
  document.getElementById('adminTrainingStart').value = '';
  document.getElementById('adminTrainingEnd').value = '';
  document.getElementById('adminTrainingHours').value = '';
}

function updateTrainingStatus(trainingId, status) {
  const items = getEmployeeTrainings().map(item =>
    item.id === trainingId ? { ...item, status } : item
  );
  saveEmployeeTrainings(items);
  logAdminAction('Update Training Status', selectedEmployeeEmail, `Training #${trainingId} marked as ${status}`);
  renderTrainingMonitoring();
}

function renderTrainingMonitoring() {
  const tbody = document.querySelector('#adminTrainingTable tbody');
  const pointsSummaryContainer = document.getElementById('adminTrainingPointsSummary');
  if (!tbody) return;
  tbody.innerHTML = '';

  const items = getEmployeeTrainings();
  const pointSummary = getCertificationPointSummary(items);

  if (pointsSummaryContainer) {
    const pointsToTarget = Math.max(PROMOTION_CERTIFICATION_POINT_TARGET - pointSummary.total, 0);
    pointsSummaryContainer.innerHTML = `
      <div class="metric-card">
        <p class="metric-label">Certification Points</p>
        <h3>${pointSummary.total}</h3>
        <p class="metric-sub">${pointSummary.certificateCount} uploaded certificates</p>
      </div>
      <div class="metric-card">
        <p class="metric-label">Promotion Target</p>
        <h3>${PROMOTION_CERTIFICATION_POINT_TARGET}</h3>
        <p class="metric-sub">${pointsToTarget ? `${pointsToTarget} points remaining` : 'Target met'}</p>
      </div>
    `;
  }

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="10">No training records for this employee.</td></tr>';
    return;
  }

  items.forEach(item => {
    // Determine status: "Ongoing" if no certificate, otherwise use stored status or "Completed"
    let status = item.status || 'Assigned';
    if (!item.certificate || !item.certificate.data) {
      status = 'Ongoing';
    } else if (status === 'Assigned') {
      status = 'Completed';
    }

    const source = item.source ? String(item.source).charAt(0).toUpperCase() + String(item.source).slice(1) : 'Admin';
    const points = calculateCertificationPoints(item);
    
    // Certificate column: show "View" button if certificate exists, otherwise show "-"
    const certificateAction = item.certificate && item.certificate.data
      ? `<button class="btn btn-outline" onclick="viewAdminTrainingCertificate(${item.id})">View</button>`
      : '-';
    
    // Action buttons: Show status management buttons
    const actionButtons = status !== 'Completed' 
      ? `<button class="btn btn-success" onclick="updateTrainingStatus(${item.id}, 'Completed')">Mark Completed</button>` 
      : `<button class="btn btn-outline" onclick="updateTrainingStatus(${item.id}, 'Assigned')">Reopen</button>`;

    const row = `
      <tr>
        <td>${escapeHtml(item.title || '-')}</td>
        <td>${escapeHtml(item.start || '-')} - ${escapeHtml(item.end || '-')}</td>
        <td>${escapeHtml(item.hours || '-')}</td>
        <td>${escapeHtml(item.type || '-')}</td>
        <td>${escapeHtml(item.sponsor || item.conductedBy || '-')}</td>
        <td>${certificateAction}</td>
        <td>${points || '-'}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(source)}</td>
        <td>
          <div class="actions" style="display:flex; gap:6px; flex-wrap:wrap;">
            ${actionButtons}
          </div>
        </td>
      </tr>`;
    tbody.innerHTML += row;
  });
}

function viewAdminTrainingCertificate(trainingId) {
  const item = getEmployeeTrainings().find(record => Number(record.id) === Number(trainingId));
  const certificate = item?.certificate;
  if (!certificate || !certificate.data) {
    showNotification('No certificate file is attached to this training record.', 'error', 2500);
    return;
  }

  const fileWindow = window.open('', '_blank');
  if (!fileWindow) {
    showNotification('Please allow pop-ups to view the certificate.', 'error', 2500);
    return;
  }

  fileWindow.document.write(`
    <!doctype html>
    <html>
      <head><title>${escapeHtml(certificate.name || 'Certificate')}</title></head>
      <body style="margin:0;background:#f8fafc;">
        <iframe src="${certificate.data}" title="${escapeHtml(certificate.name || 'Certificate')}" style="width:100%;height:100vh;border:0;"></iframe>
      </body>
    </html>
  `);
  fileWindow.document.close();
}

function renderEmployeeAttendance() {
  const tbody = document.querySelector('#adminAttendanceTable tbody');
  tbody.innerHTML = '';

  const items = getEmployeeAttendance();
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5">No attendance records for this employee.</td></tr>';
    return;
  }

  items.forEach(item => {
    const row = `
      <tr>
        <td>${escapeHtml(item.date || '-')}</td>
        <td>${escapeHtml(formatTimeDisplay(item.timeIn) || 'Not recorded')}</td>
        <td>${escapeHtml(formatTimeDisplay(item.timeOut) || 'Not recorded')}</td>
        <td>${escapeHtml(item.status || '-')}</td>
        <td><button class="btn btn-danger" onclick="removeEmployeeAttendance(${item.id})">Delete</button></td>
      </tr>`;
    tbody.innerHTML += row;
  });
}

function getGlobalAnnouncements() {
  return hrCache.announcements || [];
}

function saveGlobalAnnouncements(items) {
  hrCache.announcements = items;
}

function addGlobalAnnouncement() {
  const titleInput = document.getElementById('adminAnnouncementTitle');
  const descriptionInput = document.getElementById('adminAnnouncementDescription');
  const imageInput = document.getElementById('adminAnnouncementImage');
  const title = titleInput.value.trim();
  const description = descriptionInput.value.trim();
  const imageFile = imageInput.files && imageInput.files[0];

  if (!title || !description) {
    alert('Please enter both a title and description for the announcement.');
    return;
  }

  const payload = {
    id: Date.now(),
    title,
    description,
    date: getLocalDateString(),
    image: '',
    visible: true,
  };

  const saveAnnouncement = (imageDataUrl = '') => {
    if (imageDataUrl) payload.image = imageDataUrl;
    apiSend('/api/hr/announcements', 'POST', {
      ...payload,
      createdByEmail: getSessionEmail(),
    }).then(() => {
      logAdminAction('Create Announcement', payload.title, payload.visible ? 'Visible to employees' : 'Hidden from employees');
      return loadAnnouncementsFromApi().then(() => renderGlobalAnnouncements());
    }).catch(() => {});
    titleInput.value = '';
    descriptionInput.value = '';
    imageInput.value = '';
    renderGlobalAnnouncements();
  };

  if (imageFile) {
    const reader = new FileReader();
    reader.onload = () => saveAnnouncement(reader.result);
    reader.readAsDataURL(imageFile);
  } else {
    saveAnnouncement();
  }
}

function removeGlobalAnnouncement(id) {
  fetch('/api/hr/announcements/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(() => loadAnnouncementsFromApi())
    .then(() => {
      logAdminAction('Delete Announcement', String(id), 'Announcement removed');
      renderGlobalAnnouncements();
    })
    .catch(() => {});
}

function toggleAnnouncementVisibility(id, visible) {
  apiSend('/api/hr/announcements/' + encodeURIComponent(id) + '/visibility', 'PUT', { visible })
    .then(() => loadAnnouncementsFromApi())
    .then(() => {
      logAdminAction('Toggle Announcement Visibility', String(id), visible ? 'Set to visible' : 'Set to hidden');
      renderGlobalAnnouncements();
    })
    .catch(() => {
      showNotification('Failed to update announcement visibility.', 'error', 2500);
    });
}

function renderGlobalAnnouncements() {
  const board = document.getElementById('adminAnnouncementBoard');
  if (!board) return;
  board.innerHTML = '';

  const items = getGlobalAnnouncements();
  if (!items.length) {
    board.innerHTML = '<p class="form-note">No announcements posted yet.</p>';
    return;
  }

  items.forEach(item => {
    const block = document.createElement('div');
    block.className = 'announcement-item';

    const contentWrapper = document.createElement('div');
    contentWrapper.style.display = 'grid';
    contentWrapper.style.gap = '10px';

    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.alignItems = 'flex-start';
    headerRow.style.gap = '10px';
    headerRow.style.flexWrap = 'wrap';

    const titleBlock = document.createElement('div');
    const titleEl = document.createElement('h4');
    titleEl.textContent = item.title;
    titleEl.style.margin = '0 0 6px';
    const descEl = document.createElement('p');
    descEl.textContent = item.description;
    descEl.style.margin = '0';
    descEl.style.color = '#475569';
    titleBlock.appendChild(titleEl);
    titleBlock.appendChild(descEl);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = () => removeGlobalAnnouncement(item.id);

    const actionsWrap = document.createElement('div');
    actionsWrap.style.display = 'flex';
    actionsWrap.style.gap = '8px';
    actionsWrap.style.flexWrap = 'wrap';
    actionsWrap.appendChild(deleteBtn);

    headerRow.appendChild(titleBlock);
    headerRow.appendChild(actionsWrap);
    contentWrapper.appendChild(headerRow);

    if (item.image) {
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = item.title;
      img.className = 'announcement-item-image';
      contentWrapper.appendChild(img);
    }

    const dateEl = document.createElement('p');
    dateEl.className = 'form-note';
    dateEl.style.margin = '0';
    dateEl.textContent = `Posted: ${item.date}`;
    contentWrapper.appendChild(dateEl);

    block.appendChild(contentWrapper);
    board.appendChild(block);
  });
}

// ============ All Leaves Dashboard Functions ============

function getAllEmployeesLeaves() {
  const usersByEmail = {};
  getUsers().forEach(user => {
    usersByEmail[String(user.email || '').toLowerCase()] = user;
  });

  return allLeavesCache
    .map(leave => {
      const user = usersByEmail[String(leave.employeeEmail || '').toLowerCase()] || {};
      return {
        ...leave,
        start: leave.start || leave.startDate,
        end: leave.end || leave.endDate,
        employeeName: user.name || leave.employeeEmail,
        employeeEmail: leave.employeeEmail,
      };
    })
    .sort((a, b) => new Date(b.start) - new Date(a.start));
}

function showAdminPage(pageName) {
  // Hide all pages
  document.getElementById('overviewPage').classList.add('hidden');
  document.getElementById('announcementPage').classList.add('hidden');
  document.getElementById('analyticsPage').classList.add('hidden');
  document.getElementById('leavesPage').classList.add('hidden');
  document.getElementById('employeesPage').classList.add('hidden');
  document.getElementById('civhrPage').classList.add('hidden');
  document.getElementById('trainingPage').classList.add('hidden');

  // Remove active class from all menu buttons
  document.getElementById('overviewBtn').classList.remove('active');
  document.getElementById('analyticsBtn').classList.remove('active');
  document.getElementById('announcementsBtn').classList.remove('active');
  document.getElementById('leavesBtn').classList.remove('active');
  document.getElementById('employeesBtn').classList.remove('active');
  document.getElementById('civhrBtn').classList.remove('active');
  document.getElementById('trainingBtn').classList.remove('active');

  // Show selected page and mark button as active
  if (pageName === 'overview') {
    document.getElementById('overviewPage').classList.remove('hidden');
    document.getElementById('overviewBtn').classList.add('active');
    renderAdminOverview();
  } else if (pageName === 'analytics') {
    document.getElementById('analyticsPage').classList.remove('hidden');
    document.getElementById('analyticsBtn').classList.add('active');
    renderAdminAnalytics();
  } else if (pageName === 'announcements') {
    document.getElementById('announcementPage').classList.remove('hidden');
    document.getElementById('announcementsBtn').classList.add('active');
    renderGlobalAnnouncements();
  } else if (pageName === 'leaves') {
    document.getElementById('leavesPage').classList.remove('hidden');
    document.getElementById('leavesBtn').classList.add('active');
    renderAllLeaves();
  } else if (pageName === 'employees') {
    document.getElementById('employeesPage').classList.remove('hidden');
    document.getElementById('employeesBtn').classList.add('active');
    hydrateEmployeeSelect();
    renderEmployeeDirectory();
    selectEmployee();
    showEmployeeManagementTab('overview');
  } else if (pageName === 'civhr') {
    document.getElementById('civhrPage').classList.remove('hidden');
    document.getElementById('civhrBtn').classList.add('active');
    hydrateEmployeeSelect();
    renderPersonalDataSheet();
  } else if (pageName === 'training') {
    document.getElementById('trainingPage').classList.remove('hidden');
    document.getElementById('trainingBtn').classList.add('active');
    hydrateEmployeeSelect();
    renderTrainingMonitoring();
  }
}

function populateOverviewDepartmentFilter() {
  const select = document.getElementById('overviewDepartmentFilter');
  if (!select) return;

  select.innerHTML = '<option value="CHR">CHR</option>';
  select.value = 'CHR';
}

function getOverviewFilterValues() {
  const days = Number(document.getElementById('overviewRangeFilter')?.value || 30) || 30;
  return { days, department: '' };
}

async function fetchOverviewSummary() {
  const { days, department } = getOverviewFilterValues();
  const query = new URLSearchParams({ days: String(days) });
  if (department) query.set('department', department);
  const data = await apiGet('/api/admin/reports/summary?' + query.toString());
  return data.summary || null;
}

async function refreshOverviewInsights() {
  await renderAdminOverview();
}

async function renderAdminOverview() {
  try {
    const summary = await fetchOverviewSummary();
    latestOverviewSummary = summary;

    const metrics = (summary && summary.metrics) || {};
    const totalEmployees = Number(metrics.totalEmployees || getUsers().length || 0);
    const pendingLeaves = Number(metrics.pendingLeaves || 0);
    const approvedLeaves = Number(metrics.approvedLeaves || 0);
    const rejectedLeaves = Number(metrics.rejectedLeaves || 0);
    const upcomingTrainings = Number(metrics.upcomingTrainings || 0);
    const attendanceTrend = Number(metrics.attendancePresentRate || 0);

    document.getElementById('totalEmployeesCount').textContent = totalEmployees;
    document.getElementById('pendingLeavesCount').textContent = pendingLeaves;
    document.getElementById('approvedLeavesCount').textContent = approvedLeaves;
    document.getElementById('upcomingTrainingsCount').textContent = upcomingTrainings;
    document.getElementById('attendanceTrendRate').textContent = attendanceTrend + '%';
    document.getElementById('attendanceTrendMeta').textContent =
      `Present ${metrics.presentCount || 0} | Late ${metrics.lateCount || 0} | Absent ${metrics.absentCount || 0}`;

    document.getElementById('statusPendingCount').textContent = pendingLeaves;
    document.getElementById('statusApprovedCount').textContent = approvedLeaves;
    document.getElementById('statusRejectedCount').textContent = rejectedLeaves;

    renderRecentLeavesTable((summary && summary.recentLeaves) || []);
  } catch (error) {
    const users = getUsers();
    const allLeaves = getAllEmployeesLeaves();
    const pendingLeaves = allLeaves.filter(l => l.status === 'Pending').length;
    const approvedLeaves = allLeaves.filter(l => l.status === 'Approved').length;
    const rejectedLeaves = allLeaves.filter(l => l.status === 'Rejected').length;

    document.getElementById('totalEmployeesCount').textContent = users.length;
    document.getElementById('pendingLeavesCount').textContent = pendingLeaves;
    document.getElementById('approvedLeavesCount').textContent = approvedLeaves;
    document.getElementById('statusPendingCount').textContent = pendingLeaves;
    document.getElementById('statusApprovedCount').textContent = approvedLeaves;
    document.getElementById('statusRejectedCount').textContent = rejectedLeaves;
    renderRecentLeavesTable();
  }

  renderSiteWideAnalytics();
  await loadAuditLogs();
  renderGlobalAnnouncements();
  updatePendingBadge();
}

async function ensureAnalyticsSnapshotData() {
  const users = getUsers().filter(user => String(user.role || '').toLowerCase() !== 'admin');
  const missingSnapshots = users
    .map(user => String(user.email || '').toLowerCase())
    .filter(email => email && (!hrCache.attendanceByEmail[email] || !hrCache.trainingsByEmail[email]));

  if (!missingSnapshots.length) return;

  await Promise.all(missingSnapshots.map(email => loadEmployeeSnapshot(email).catch(() => null)));
}

function getAnalyticsStatusCounts(items = [], fallbackStatus = 'Pending') {
  return items.reduce((counts, item) => {
    const status = String(item.status || fallbackStatus).trim().toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function renderBarChart(containerId, rows) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const validRows = rows.filter(row => Number(row.value || 0) > 0);
  if (!validRows.length) {
    container.innerHTML = '<div class="chart-empty">No activity recorded yet.</div>';
    return;
  }

  const maxValue = Math.max(...validRows.map(row => Number(row.value || 0)), 1);
  container.innerHTML = validRows.map(row => {
    const value = Number(row.value || 0);
    const width = Math.max(6, Math.round((value / maxValue) * 100));
    return `
      <div class="bar-chart-row">
        <span class="bar-chart-label">${escapeHtml(row.label)}</span>
        <span class="bar-chart-track">
          <span class="bar-chart-fill" style="width:${width}%; background:${escapeHtml(row.color || '#0f766e')};"></span>
        </span>
        <span class="bar-chart-value">${value}</span>
      </div>`;
  }).join('');
}

function computeSiteWideAnalytics() {
  const users = getUsers();
  const totalAccounts = users.length;
  const totalAdminAccounts = users.filter(u => String(u.role || '').toLowerCase() === 'admin').length;
  const employeeAccounts = Math.max(totalAccounts - totalAdminAccounts, 0);
  const totalAnnouncements = getGlobalAnnouncements().length;
  const totalLeaves = allLeavesCache.length;
  const totalTrainings = Object.values(hrCache.trainingsByEmail).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  const totalAttendance = Object.values(hrCache.attendanceByEmail).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  const leaveStatusCounts = getAnalyticsStatusCounts(allLeavesCache);
  const attendanceRecords = Object.values(hrCache.attendanceByEmail).flatMap(items => Array.isArray(items) ? items : []);
  const attendanceStatusCounts = getAnalyticsStatusCounts(attendanceRecords, 'Present');

  const activeEmails = new Set();
  allLeavesCache.forEach(item => {
    if (item.employeeEmail) activeEmails.add(String(item.employeeEmail).toLowerCase());
  });
  Object.keys(hrCache.attendanceByEmail).forEach(email => {
    if (email) activeEmails.add(String(email).toLowerCase());
  });
  Object.keys(hrCache.trainingsByEmail).forEach(email => {
    if (email) activeEmails.add(String(email).toLowerCase());
  });

  const activeEmployees = activeEmails.size;
  const websiteEngagementRate = employeeAccounts ? Math.round((Math.min(activeEmployees, employeeAccounts) / employeeAccounts) * 100) : 0;
  const totalWebsiteActivity = totalAnnouncements + totalLeaves + totalTrainings + totalAttendance;
  const presentCount = attendanceStatusCounts.present || 0;
  const lateCount = attendanceStatusCounts.late || 0;
  const absentCount = attendanceStatusCounts.absent || 0;
  const attendanceTotal = presentCount + lateCount + absentCount;
  const attendanceReliabilityRate = attendanceTotal ? Math.round((presentCount / attendanceTotal) * 100) : 0;

  return {
    totalAccounts,
    totalAdminAccounts,
    employeeAccounts,
    totalAnnouncements,
    totalLeaves,
    totalTrainings,
    totalAttendance,
    activeEmployees,
    websiteEngagementRate,
    totalWebsiteActivity,
    leaveStatusCounts,
    attendanceStatusCounts: {
      present: presentCount,
      late: lateCount,
      absent: absentCount,
    },
    attendanceReliabilityRate,
  };
}

function renderSiteWideAnalytics() {
  const analytics = computeSiteWideAnalytics();
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('totalAccountsCount', analytics.totalAccounts);
  setText('totalAdminAccountsCount', analytics.totalAdminAccounts);
  setText('activeEmployeesCount', analytics.activeEmployees);
  setText('totalAnnouncementsCount', analytics.totalAnnouncements);
  setText('totalLeavesCount', analytics.totalLeaves);
  setText('totalTrainingsCount', analytics.totalTrainings);
  setText('totalAttendanceCount', analytics.totalAttendance);
  setText('websiteEngagementRate', analytics.websiteEngagementRate + '%');
  setText('websiteEngagementMeta', `${Math.min(analytics.activeEmployees, analytics.employeeAccounts)} of ${analytics.employeeAccounts} employee accounts with activity`);
  setText('totalWebsiteActivityCount', analytics.totalWebsiteActivity);
  setText('leaveWorkflowTotal', analytics.totalLeaves);
  setText('attendanceReliabilityRate', analytics.attendanceReliabilityRate + '%');

  renderBarChart('featureActivityChart', [
    { label: 'Attendance', value: analytics.totalAttendance, color: '#0f766e' },
    { label: 'Leave', value: analytics.totalLeaves, color: '#2563eb' },
    { label: 'Training', value: analytics.totalTrainings, color: '#7c3aed' },
    { label: 'Announcements', value: analytics.totalAnnouncements, color: '#d97706' },
  ]);

  renderBarChart('leaveWorkflowChart', [
    { label: 'Pending', value: analytics.leaveStatusCounts.pending || 0, color: '#f59e0b' },
    { label: 'Approved', value: analytics.leaveStatusCounts.approved || 0, color: '#15803d' },
    { label: 'Rejected', value: analytics.leaveStatusCounts.rejected || 0, color: '#dc2626' },
  ]);

  renderBarChart('attendanceReliabilityChart', [
    { label: 'Present', value: analytics.attendanceStatusCounts.present || 0, color: '#15803d' },
    { label: 'Late', value: analytics.attendanceStatusCounts.late || 0, color: '#d97706' },
    { label: 'Absent', value: analytics.attendanceStatusCounts.absent || 0, color: '#dc2626' },
  ]);
}

async function renderAdminAnalytics() {
  await ensureAnalyticsSnapshotData().catch(() => {});
  renderSiteWideAnalytics();
}

function renderRecentLeavesTable(rows) {
  const tbody = document.querySelector('#recentLeavesTable tbody');
  tbody.innerHTML = '';

  let allLeaves = Array.isArray(rows) && rows.length ? rows.slice(0, 10) : getAllEmployeesLeaves().slice(0, 10);

  if (!allLeaves.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #999;">No leave requests yet.</td></tr>';
    return;
  }

  allLeaves.forEach(item => {
    const cssClass = (item.status || 'Pending').toLowerCase();
    const row = `
      <tr>
        <td><strong>${item.employeeName}</strong></td>
        <td>${item.type}</td>
        <td>${item.start}</td>
        <td>${item.end}</td>
        <td>${item.days}</td>
        <td><span class="status ${cssClass}">${item.status}</span></td>
        <td>
          <button class="btn btn-outline" onclick="openLeaveDetailsModal('${item.employeeEmail}', ${item.id})">View</button>
        </td>
      </tr>`;
    tbody.innerHTML += row;
  });
}

async function loadAuditLogs() {
  const tbody = document.querySelector('#adminAuditTable tbody');
  if (!tbody) return;

  try {
    const data = await apiGet('/api/admin/audit-logs?limit=25');
    const logs = data.items || [];
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="5">No audit logs yet.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(log => `
      <tr>
        <td>${escapeHtml(formatDateTime(log.timestamp))}</td>
        <td>${escapeHtml(log.adminEmail || '-')}</td>
        <td>${escapeHtml(log.action || '-')}</td>
        <td>${escapeHtml(log.target || '-')}</td>
        <td>${escapeHtml(log.details || '-')}</td>
      </tr>
    `).join('');
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5">Unable to load audit logs.</td></tr>';
  }
}

function logAdminAction(action, target, details) {
  const requesterEmail = getSessionEmail();
  if (!requesterEmail || !action) return;
  apiSend('/api/admin/audit-logs', 'POST', {
    action,
    target: target || '',
    details: details || '',
    timestamp: new Date().toISOString(),
  }).then(() => {
    if (!document.getElementById('overviewPage')?.classList.contains('hidden')) {
      loadAuditLogs();
    }
  }).catch(() => {});
}

function buildEmployeeReportHtml(user) {
  const leaves = (hrCache.leavesByEmail[selectedEmployeeEmail] || []).slice();
  const attendance = (hrCache.attendanceByEmail[selectedEmployeeEmail] || []).slice();
  const trainings = (hrCache.trainingsByEmail[selectedEmployeeEmail] || []).slice();

  const leaveRows = leaves.length
    ? leaves.map(item => `<tr><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.start)}</td><td>${escapeHtml(item.end)}</td><td>${escapeHtml(item.status)}</td></tr>`).join('')
    : '<tr><td colspan="4">No leave records</td></tr>';

  const attendanceRows = attendance.length
    ? attendance.map(item => `<tr><td>${escapeHtml(formatDateOnly(item.date) || '-')}</td><td>${escapeHtml(formatTimeDisplay(item.timeIn) || 'Not recorded')}</td><td>${escapeHtml(formatTimeDisplay(item.timeOut) || 'Not recorded')}</td><td>${escapeHtml(item.status)}</td></tr>`).join('')
    : '<tr><td colspan="4">No attendance records</td></tr>';

  const trainingRows = trainings.length
    ? trainings.map(item => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.start || '-')} - ${escapeHtml(item.end || '-')}</td><td>${escapeHtml(item.status || 'Assigned')}</td></tr>`).join('')
    : '<tr><td colspan="3">No training records</td></tr>';

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Employee Report - ${escapeHtml(user.name || user.email)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1, h2 { margin: 0 0 8px; }
    .meta { margin-bottom: 18px; color: #333; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 13px; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Employee Report</h1>
  <div class="meta">
    <div><strong>Name:</strong> ${escapeHtml(user.name || '-')}</div>
    <div><strong>Email:</strong> ${escapeHtml(user.email || '-')}</div>
    <div><strong>Department:</strong> CHR</div>
    <div><strong>Position:</strong> ${escapeHtml(user.position || '-')}</div>
    <div><strong>Generated:</strong> ${escapeHtml(new Date().toLocaleString())}</div>
  </div>
  <h2>Leave Records</h2>
  <table><thead><tr><th>Type</th><th>Start</th><th>End</th><th>Status</th></tr></thead><tbody>${leaveRows}</tbody></table>
  <h2>Attendance Records</h2>
  <table><thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead><tbody>${attendanceRows}</tbody></table>
  <h2>Training Records</h2>
  <table><thead><tr><th>Title</th><th>Period</th><th>Status</th></tr></thead><tbody>${trainingRows}</tbody></table>
</body>
</html>`;
}

function openPrintWindow(html) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    alert('Popup blocked. Please allow popups to print reports.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

function sanitizeFilePart(value) {
  return String(value || 'report').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
}

function downloadTextFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function buildEmployeeReportCsv(user) {
  const leaves = (hrCache.leavesByEmail[selectedEmployeeEmail] || []).slice();
  const attendance = (hrCache.attendanceByEmail[selectedEmployeeEmail] || []).slice();
  const trainings = (hrCache.trainingsByEmail[selectedEmployeeEmail] || []).slice();
  const rows = [
    csvRow(['Employee Report']),
    csvRow(['Name', user.name || '-']),
    csvRow(['Email', user.email || '-']),
    csvRow(['Department', 'CHR']),
    csvRow(['Position', user.position || '-']),
    csvRow(['Generated', new Date().toLocaleString()]),
    '',
    csvRow(['Leave Records']),
    csvRow(['Type', 'Start', 'End', 'Status']),
    ...(leaves.length ? leaves.map(item => csvRow([item.type || '-', item.start || '-', item.end || '-', item.status || '-'])) : [csvRow(['No leave records', '', '', ''])]),
    '',
    csvRow(['Attendance Records']),
    csvRow(['Date', 'Time In', 'Time Out', 'Status']),
    ...(attendance.length ? attendance.map(item => csvRow([formatDateOnly(item.date) || '-', formatTimeDisplay(item.timeIn) || 'Not recorded', formatTimeDisplay(item.timeOut) || 'Not recorded', item.status || '-'])) : [csvRow(['No attendance records', '', '', ''])]),
    '',
    csvRow(['Training Records']),
    csvRow(['Title', 'Period', 'Status']),
    ...(trainings.length ? trainings.map(item => csvRow([item.title || '-', `${item.start || '-'} - ${item.end || '-'}`, item.status || 'Assigned'])) : [csvRow(['No training records', '', ''])]),
  ];
  return rows.join('\r\n');
}

function printEmployeeReport() {
  if (!selectedEmployeeEmail) {
    alert('Please select an employee first.');
    return;
  }
  const user = getUsers().find(u => u.email === selectedEmployeeEmail);
  if (!user) {
    alert('Employee not found.');
    return;
  }
  openPrintWindow(buildEmployeeReportHtml(user));
  logAdminAction('Print Employee Report', selectedEmployeeEmail, 'Generated printable employee profile report');
}

function getSelectedEmployeeForReport() {
  if (!selectedEmployeeEmail) {
    alert('Please select an employee first.');
    return null;
  }
  const user = getUsers().find(u => u.email === selectedEmployeeEmail);
  if (!user) {
    alert('Employee not found.');
    return null;
  }
  return user;
}

function downloadEmployeeReportCsv() {
  const user = getSelectedEmployeeForReport();
  if (!user) return;
  downloadTextFile(`employee-report-${sanitizeFilePart(user.name || user.email)}.csv`, buildEmployeeReportCsv(user), 'text/csv;charset=utf-8');
  logAdminAction('Export Employee Report CSV', selectedEmployeeEmail, 'Downloaded employee report CSV');
}

function downloadEmployeeReportHtml() {
  const user = getSelectedEmployeeForReport();
  if (!user) return;
  downloadTextFile(`employee-report-${sanitizeFilePart(user.name || user.email)}.html`, buildEmployeeReportHtml(user), 'text/html;charset=utf-8');
  logAdminAction('Export Employee Report HTML', selectedEmployeeEmail, 'Downloaded employee report HTML');
}

function buildHrSummaryReportHtml() {
  const summary = latestOverviewSummary;
  if (!summary || !summary.metrics) {
    return '';
  }
  const metrics = summary.metrics;
  const filters = getOverviewFilterValues();
  const leavesRows = (summary.recentLeaves || []).map(item => `
    <tr>
      <td>${escapeHtml(item.employeeName || item.employeeEmail)}</td>
      <td>${escapeHtml(item.type || '-')}</td>
      <td>${escapeHtml(item.start || '-')}</td>
      <td>${escapeHtml(item.status || '-')}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">No leave requests in this range</td></tr>';

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>HR Summary Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1, h2 { margin: 0 0 8px; }
    .meta { margin-bottom: 18px; color: #333; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 13px; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>HR Summary Report</h1>
  <div class="meta">
    <div><strong>Range:</strong> Last ${escapeHtml(filters.days)} days</div>
    <div><strong>Department:</strong> CHR</div>
    <div><strong>Generated:</strong> ${escapeHtml(new Date().toLocaleString())}</div>
  </div>
  <div class="grid">
    <div class="card"><strong>Total Employees:</strong> ${escapeHtml(metrics.totalEmployees || 0)}</div>
    <div class="card"><strong>Pending Leaves:</strong> ${escapeHtml(metrics.pendingLeaves || 0)}</div>
    <div class="card"><strong>Approved Leaves:</strong> ${escapeHtml(metrics.approvedLeaves || 0)}</div>
    <div class="card"><strong>Upcoming Trainings:</strong> ${escapeHtml(metrics.upcomingTrainings || 0)}</div>
    <div class="card"><strong>Attendance Present Rate:</strong> ${escapeHtml(metrics.attendancePresentRate || 0)}%</div>
    <div class="card"><strong>Attendance Mix:</strong> P ${escapeHtml(metrics.presentCount || 0)} / L ${escapeHtml(metrics.lateCount || 0)} / A ${escapeHtml(metrics.absentCount || 0)}</div>
  </div>
  <h2>Recent Leave Requests</h2>
  <table>
    <thead><tr><th>Employee</th><th>Type</th><th>Start</th><th>Status</th></tr></thead>
    <tbody>${leavesRows}</tbody>
  </table>
</body>
</html>`;
}

function buildHrSummaryReportCsv() {
  const summary = latestOverviewSummary;
  if (!summary || !summary.metrics) return '';
  const metrics = summary.metrics;
  const filters = getOverviewFilterValues();
  const rows = [
    csvRow(['HR Summary Report']),
    csvRow(['Range', `Last ${filters.days} days`]),
    csvRow(['Department', 'CHR']),
    csvRow(['Generated', new Date().toLocaleString()]),
    '',
    csvRow(['Metric', 'Value']),
    csvRow(['Total Employees', metrics.totalEmployees || 0]),
    csvRow(['Pending Leaves', metrics.pendingLeaves || 0]),
    csvRow(['Approved Leaves', metrics.approvedLeaves || 0]),
    csvRow(['Rejected Leaves', metrics.rejectedLeaves || 0]),
    csvRow(['Upcoming Trainings', metrics.upcomingTrainings || 0]),
    csvRow(['Attendance Present Rate', `${metrics.attendancePresentRate || 0}%`]),
    csvRow(['Present Count', metrics.presentCount || 0]),
    csvRow(['Late Count', metrics.lateCount || 0]),
    csvRow(['Absent Count', metrics.absentCount || 0]),
    '',
    csvRow(['Recent Leave Requests']),
    csvRow(['Employee', 'Type', 'Start', 'Status']),
    ...((summary.recentLeaves || []).length
      ? summary.recentLeaves.map(item => csvRow([item.employeeName || item.employeeEmail || '-', item.type || '-', item.start || '-', item.status || '-']))
      : [csvRow(['No leave requests in this range', '', '', ''])]),
  ];
  return rows.join('\r\n');
}

function printHrSummaryReport() {
  const html = buildHrSummaryReportHtml();
  if (!html) {
    alert('Summary is not ready yet. Please try again.');
    return;
  }
  openPrintWindow(html);
  const filters = getOverviewFilterValues();
  logAdminAction('Print HR Summary', 'CHR', `Range: ${filters.days} days`);
}

function downloadHrSummaryCsv() {
  const csv = buildHrSummaryReportCsv();
  if (!csv) {
    alert('Summary is not ready yet. Please try again.');
    return;
  }
  downloadTextFile(`hr-summary-${getLocalDateString()}.csv`, csv, 'text/csv;charset=utf-8');
  logAdminAction('Export HR Summary CSV', 'CHR', 'Downloaded HR summary CSV');
}

function downloadHrSummaryHtml() {
  const html = buildHrSummaryReportHtml();
  if (!html) {
    alert('Summary is not ready yet. Please try again.');
    return;
  }
  downloadTextFile(`hr-summary-${getLocalDateString()}.html`, html, 'text/html;charset=utf-8');
  logAdminAction('Export HR Summary HTML', 'CHR', 'Downloaded HR summary HTML');
}

function showAdminView(view) {
  const allLeavesSection = document.getElementById('allLeavesSection');
  const employeeManagementSection = document.getElementById('employeeManagementSection');
  const allLeavesBtn = document.getElementById('allLeavesBtn');
  const employeeManagementBtn = document.getElementById('employeeManagementBtn');

  if (view === 'allLeaves') {
    allLeavesSection.classList.remove('hidden');
    employeeManagementSection.classList.add('hidden');
    allLeavesBtn.classList.add('btn-primary');
    allLeavesBtn.classList.remove('btn-outline');
    employeeManagementBtn.classList.remove('btn-primary');
    employeeManagementBtn.classList.add('btn-outline');
    renderAllLeaves();
  } else {
    allLeavesSection.classList.add('hidden');
    employeeManagementSection.classList.remove('hidden');
    employeeManagementBtn.classList.add('btn-primary');
    employeeManagementBtn.classList.remove('btn-outline');
    allLeavesBtn.classList.remove('btn-primary');
    allLeavesBtn.classList.add('btn-outline');
  }
}

function renderAllLeaves() {
  const tbody = document.querySelector('#allLeavesTable tbody');
  tbody.innerHTML = '';

  let allLeaves = getAllEmployeesLeaves();

  // Apply filters
  const statusFilter = document.getElementById('filterByStatus')?.value || '';
  const typeFilter = document.getElementById('filterByType')?.value || '';

  if (statusFilter) {
    allLeaves = allLeaves.filter(l => l.status === statusFilter);
  }
  if (typeFilter) {
    allLeaves = allLeaves.filter(l => l.type === typeFilter);
  }

  if (!allLeaves.length) {
    tbody.innerHTML = '<tr><td colspan="7">No leave requests found.</td></tr>';
    return;
  }

  allLeaves.forEach(item => {
    const cssClass = (item.status || 'Pending').toLowerCase();
    const row = `
      <tr>
        <td><strong>${item.employeeName}</strong><br><small style="color: #999;">${item.employeeEmail}</small></td>
        <td>${item.type}</td>
        <td>${item.start}</td>
        <td>${item.end}</td>
        <td>${item.days}</td>
        <td><span class="status ${cssClass}">${item.status}</span></td>
        <td>
          <div class="actions" style="display: flex; gap: 5px; flex-wrap: wrap;">
            <button class="btn btn-outline" onclick="openLeaveDetailsModal('${item.employeeEmail}', ${item.id})">Details</button>
            ${item.status === 'Pending' ? `
              <button class="btn btn-success" onclick="approveLeaveFromDashboard('${item.employeeEmail}', ${item.id})">Approve</button>
              <button class="btn btn-danger" onclick="rejectLeaveFromDashboard('${item.employeeEmail}', ${item.id})">Reject</button>
            ` : `
              <span style="color: #999;">-</span>
            `}
          </div>
        </td>
      </tr>`;
    tbody.innerHTML += row;
  });

  // Update badge count
  updatePendingBadge();
}

function filterAllLeaves() {
  renderAllLeaves();
}

function updatePendingBadge() {
  const badge = document.getElementById('pendingBadge');
  const allLeaves = getAllEmployeesLeaves();
  const pendingCount = allLeaves.filter(l => l.status === 'Pending').length;
  
  if (badge) {
    if (pendingCount > 0) {
      badge.textContent = pendingCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ============ Comment Management Functions ============

async function getLeaveComments(employeeEmail, leaveId) {
  const data = await apiGet('/api/hr/leave-comments?email=' + encodeURIComponent(employeeEmail) + '&leaveId=' + encodeURIComponent(leaveId));
  return data.items || [];
}

async function openLeaveDetailsModal(employeeEmail, leaveId) {
  // Find the leave request
  const users = getUsers();
  const user = users.find(u => u.email === employeeEmail);
  const leaves = hrCache.leavesByEmail[employeeEmail] || [];
  const leave = leaves.find(l => l.id === leaveId);

  if (!leave || !user) return;

  currentLeaveInModal = { employeeEmail, leaveId, leave, user };

  // Display leave details
  const modalContent = document.getElementById('leaveModalContent');
  const cssClass = (leave.status || 'Pending').toLowerCase();
  
  modalContent.innerHTML = `
    <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
      <p><strong>Employee:</strong> ${user.name} (${user.email})</p>
      <p><strong>Leave Type:</strong> ${leave.type}</p>
      <p><strong>Start Date:</strong> ${leave.start}</p>
      <p><strong>End Date:</strong> ${leave.end}</p>
      <p><strong>Number of Days:</strong> ${leave.days}</p>
      <p><strong>Status:</strong> <span class="status ${cssClass}">${leave.status}</span></p>
    </div>
  `;

  // Display comments
  await displayCommentsInModal(employeeEmail, leaveId);

  // Clear comment input
  document.getElementById('commentInput').value = '';

  // Show modal
  document.getElementById('leaveDetailsModal').style.display = 'block';
}

function closeLeaveModal() {
  document.getElementById('leaveDetailsModal').style.display = 'none';
  currentLeaveInModal = null;
}

async function displayCommentsInModal(employeeEmail, leaveId) {
  const commentsList = document.getElementById('commentsList');
  const comments = await getLeaveComments(employeeEmail, leaveId);

  if (!comments.length) {
    commentsList.innerHTML = '<p style="color: #999; margin: 0;">No comments yet. Add one below.</p>';
    return;
  }

  commentsList.innerHTML = '';
  comments.forEach(comment => {
    const commentEl = document.createElement('div');
    commentEl.style.cssText = `
      background: white;
      padding: 10px;
      margin-bottom: 8px;
      border-radius: 6px;
      border-left: 3px solid #0f766e;
    `;
    commentEl.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div>
          <p style="font-weight: 600; margin: 0 0 4px 0; color: #333;">Admin</p>
          <p style="margin: 0; color: #555; font-size: 0.9rem;">${comment.text}</p>
          <p style="margin: 4px 0 0 0; color: #999; font-size: 0.8rem;">${comment.date}</p>
        </div>
        <button onclick="deleteComment('${employeeEmail}', ${leaveId}, ${comment.id})" style="background: none; border: none; color: #dc2626; cursor: pointer; font-size: 18px;">×</button>
      </div>
    `;
    commentsList.appendChild(commentEl);
  });
}

async function addCommentToLeave() {
  if (!currentLeaveInModal) return;

  const commentInput = document.getElementById('commentInput');
  const text = commentInput.value.trim();

  if (!text) {
    alert('Please enter a comment');
    return;
  }

  const { employeeEmail, leaveId } = currentLeaveInModal;
  await apiSend('/api/hr/leave-comments', 'POST', {
    id: Date.now(),
    leaveId,
    employeeEmail,
    text,
    date: new Date().toLocaleString(),
    createdByEmail: getSessionEmail(),
    createdByRole: 'admin',
  });
  commentInput.value = '';
  logAdminAction('Add Leave Comment', employeeEmail, `Commented on leave #${leaveId}`);
  await displayCommentsInModal(employeeEmail, leaveId);
  showNotification('Comment added successfully!', 'success', 2000);
}

async function deleteComment(employeeEmail, leaveId, commentId) {
  await fetch('/api/hr/leave-comments/' + encodeURIComponent(commentId), { method: 'DELETE' });
  logAdminAction('Delete Leave Comment', employeeEmail, `Deleted comment #${commentId} for leave #${leaveId}`);
  await displayCommentsInModal(employeeEmail, leaveId);
  showNotification('Comment deleted', 'success', 2000);
}

// Close modal when clicking outside
document.addEventListener('click', function(event) {
  const modal = document.getElementById('leaveDetailsModal');
  if (event.target === modal) {
    closeLeaveModal();
  }
});

function approveLeaveFromDashboard(employeeEmail, leaveId) {
  const leaves = hrCache.leavesByEmail[employeeEmail] || [];
  const updatedLeaves = leaves.map(l => l.id === leaveId ? { ...l, status: 'Approved' } : l);
  hrCache.leavesByEmail[employeeEmail] = updatedLeaves;
  allLeavesCache = allLeavesCache.map(l => (l.id === leaveId ? { ...l, status: 'Approved' } : l));
  fetch('/api/hr/leaves/' + encodeURIComponent(leaveId) + '/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Approved' })
  }).catch(() => {});
  logAdminAction('Approve Leave', employeeEmail, `Approved leave #${leaveId}`);
  renderAllLeaves();
  renderLeaveMonitoring();
  showNotification(`Leave request approved for ${employeeEmail}`, 'success');
}

function rejectLeaveFromDashboard(employeeEmail, leaveId) {
  const leaves = hrCache.leavesByEmail[employeeEmail] || [];
  const updatedLeaves = leaves.map(l => l.id === leaveId ? { ...l, status: 'Rejected' } : l);
  hrCache.leavesByEmail[employeeEmail] = updatedLeaves;
  allLeavesCache = allLeavesCache.map(l => (l.id === leaveId ? { ...l, status: 'Rejected' } : l));
  fetch('/api/hr/leaves/' + encodeURIComponent(leaveId) + '/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Rejected' })
  }).catch(() => {});
  logAdminAction('Reject Leave', employeeEmail, `Rejected leave #${leaveId}`);
  renderAllLeaves();
  renderLeaveMonitoring();
  showNotification(`Leave request rejected for ${employeeEmail}`, 'error');
}

// ============ Notification System ============

let lastNotificationIds = JSON.parse(localStorage.getItem('admin_last_notification_ids') || '[]');

async function checkForNewLeaveNotifications() {
  await loadAllLeavesFromApi().catch(() => {});
  const users = getUsers();
  const currentNotificationIds = [];

  users.forEach(user => {
    const userLeaves = hrCache.leavesByEmail[user.email] || [];
    userLeaves.forEach(leave => {
      const leaveKey = `${user.email}_${leave.id}`;
      currentNotificationIds.push(leaveKey);

      if (!lastNotificationIds.includes(leaveKey) && leave.status === 'Pending') {
        showNotification(`📋 New leave request from ${user.name}! (${leave.type} - ${leave.start} to ${leave.end})`, 'info', 5000);
      }
    });
  });

  lastNotificationIds = currentNotificationIds;
  localStorage.setItem('admin_last_notification_ids', JSON.stringify(lastNotificationIds));
  
  // Update badge on dashboard
  updatePendingBadge();
}

function showNotification(message, type = 'info', duration = 4000) {
  const container = document.getElementById('notificationContainer');
  const notif = document.createElement('div');
  notif.className = `notification notification-${type}`;
  notif.style.cssText = `
    background: ${getNotificationColor(type)};
    color: white;
    padding: 14px 18px;
    border-radius: 8px;
    margin-bottom: 10px;
    animation: slideIn 0.3s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    word-wrap: break-word;
    max-width: 100%;
  `;
  notif.textContent = message;
  container.appendChild(notif);

  setTimeout(() => {
    notif.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notif.remove(), 300);
  }, duration);
}

function getNotificationColor(type) {
  switch(type) {
    case 'success': return '#15803d';
    case 'error': return '#dc2626';
    case 'info': return '#0f766e';
    default: return '#6b7280';
  }
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

function hydrateEmployeeEvaluation() {
  const evaluation = getEmployeeEvaluation();
  const ratingField = document.getElementById('adminEvaluationStatus');
  if (ratingField) ratingField.value = evaluation.status || 'Satisfactory';

  const statusElement = document.getElementById('evaluationSaveStatus');
  if (statusElement) {
    statusElement.textContent = evaluation.status ? 'Rating saved.' : '';
    statusElement.className = 'evaluation-save-text';
  }
}

function saveEmployeeEvaluation() {
  if (!selectedEmployeeEmail) return;

  const statusElement = document.getElementById('evaluationSaveStatus');
  const payload = {
    status: document.getElementById('adminEvaluationStatus')?.value || 'Satisfactory',
    updatedAt: new Date().toISOString(),
  };

  if (statusElement) {
    statusElement.textContent = 'Saving rating...';
    statusElement.className = 'evaluation-save-text is-saving';
  }

  hrCache.evaluationsByEmail[selectedEmployeeEmail] = payload;
  apiSend('/api/hr/evaluations', 'PUT', { email: selectedEmployeeEmail, status: payload.status })
    .then(data => {
      hrCache.evaluationsByEmail[selectedEmployeeEmail] = data.item || payload;
      if (statusElement) {
        statusElement.textContent = 'Rating saved.';
        statusElement.className = 'evaluation-save-text is-saved';
      }
      renderEmployeeManagementSummary();
      renderEmployeeContextHeaders();
    })
    .catch(error => {
      if (statusElement) {
        statusElement.textContent = error.message || 'Rating was not saved. Please try again.';
        statusElement.className = 'evaluation-save-text is-error';
      }
    });

  logAdminAction('Save Evaluation', selectedEmployeeEmail, `Rating set to ${payload.status}`);
}
