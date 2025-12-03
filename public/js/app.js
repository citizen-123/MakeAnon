// MakeAnon - Frontend Application
const API_BASE = '/api/v1';

// State
let state = {
    user: null,
    token: localStorage.getItem('token'),
    domains: [],
    aliases: [],
    currentSection: 'create'
};

// DOM Elements
const elements = {
    // Navigation
    mainNav: document.getElementById('mainNav'),
    mobileMenuBtn: document.getElementById('mobileMenuBtn'),
    navLinks: document.querySelectorAll('.nav-link'),

    // Sections
    heroSection: document.getElementById('heroSection'),
    createSection: document.getElementById('createSection'),
    manageSection: document.getElementById('manageSection'),
    accountSection: document.getElementById('accountSection'),

    // Auth
    loginBtn: document.getElementById('loginBtn'),
    signupBtn: document.getElementById('signupBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    userMenu: document.getElementById('userMenu'),
    userEmail: document.getElementById('userEmail'),

    // Forms
    createAliasForm: document.getElementById('createAliasForm'),
    loginForm: document.getElementById('loginForm'),
    signupForm: document.getElementById('signupForm'),
    tokenManageForm: document.getElementById('tokenManageForm'),

    // Modals
    loginModal: document.getElementById('loginModal'),
    signupModal: document.getElementById('signupModal'),
    aliasModal: document.getElementById('aliasModal'),
    successModal: document.getElementById('successModal'),

    // Create alias
    destinationEmail: document.getElementById('destinationEmail'),
    customAlias: document.getElementById('customAlias'),
    domainSelect: document.getElementById('domainSelect'),
    aliasLabel: document.getElementById('aliasLabel'),
    previewAddress: document.getElementById('previewAddress'),

    // Content areas
    tokenAliasDetails: document.getElementById('tokenAliasDetails'),
    aliasesList: document.getElementById('aliasesList'),
    loginPrompt: document.getElementById('loginPrompt'),
    profileContent: document.getElementById('profileContent'),
    statsContent: document.getElementById('statsContent'),
    logsContent: document.getElementById('logsContent'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// API Helper
async function api(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    if (state.token) {
        headers['Authorization'] = `Bearer ${state.token}`;
    }

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'An error occurred');
        }

        return data;
    } catch (error) {
        throw error;
    }
}

// Toast notifications
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
        <span class="toast-message">${message}</span>
    `;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Modal functions
function openModal(modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
    modal.classList.remove('active');
    document.body.style.overflow = '';
}

function closeAllModals() {
    document.querySelectorAll('.modal').forEach(modal => closeModal(modal));
}

// Navigation
function showSection(sectionName) {
    state.currentSection = sectionName;

    // Update nav links
    elements.navLinks.forEach(link => {
        link.classList.toggle('active', link.dataset.section === sectionName);
    });

    // Show/hide sections
    elements.createSection.classList.toggle('hidden', sectionName !== 'create');
    elements.manageSection.classList.toggle('hidden', sectionName !== 'manage');
    elements.accountSection.classList.toggle('hidden', sectionName !== 'account');

    // Load section data
    if (sectionName === 'manage' && state.user) {
        loadUserAliases();
    } else if (sectionName === 'account' && state.user) {
        loadProfile();
        loadStats();
        loadLogs();
    }
}

// Update UI based on auth state
function updateAuthUI() {
    const isLoggedIn = !!state.user;

    elements.loginBtn.style.display = isLoggedIn ? 'none' : '';
    elements.signupBtn.style.display = isLoggedIn ? 'none' : '';
    elements.userMenu.style.display = isLoggedIn ? 'flex' : 'none';

    if (isLoggedIn) {
        elements.userEmail.textContent = state.user.email;
        elements.loginPrompt.classList.add('hidden');
        elements.aliasesList.classList.remove('hidden');
    } else {
        elements.loginPrompt.classList.remove('hidden');
        elements.aliasesList.classList.add('hidden');
    }
}

// Load domains
async function loadDomains() {
    try {
        const response = await api('/domains');
        state.domains = response.data;

        elements.domainSelect.innerHTML = state.domains
            .map(d => `<option value="${d.id}" ${d.isDefault ? 'selected' : ''}>@${d.domain}</option>`)
            .join('');

        updateAliasPreview();
    } catch (error) {
        console.error('Failed to load domains:', error);
    }
}

// Update alias preview
function updateAliasPreview() {
    const customAlias = elements.customAlias.value.trim();
    const selectedDomain = state.domains.find(d => d.id === elements.domainSelect.value);
    const domain = selectedDomain ? selectedDomain.domain : 'makeanon.info';
    const alias = customAlias || '********';
    elements.previewAddress.textContent = `${alias}@${domain}`;
}

// Create alias
async function createAlias(e) {
    e.preventDefault();

    const btn = e.target.querySelector('button[type="submit"]');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');

    btn.disabled = true;
    btnText.style.display = 'none';
    btnLoading.style.display = '';

    try {
        const payload = {
            destinationEmail: elements.destinationEmail.value.trim()
        };

        const customAlias = elements.customAlias.value.trim();
        if (customAlias) {
            payload.customAlias = customAlias;
        }

        const domainId = elements.domainSelect.value;
        if (domainId) {
            payload.domainId = domainId;
        }

        const label = elements.aliasLabel.value.trim();
        if (label) {
            payload.label = label;
        }

        // Use private endpoint if logged in, public otherwise
        const endpoint = state.user ? '/aliases' : '/public/alias';
        const response = await api(endpoint, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        // Show success modal
        const alias = response.data;
        document.getElementById('successDetails').innerHTML = `
            <div class="detail-row">
                <span class="detail-label">Alias Address</span>
                <span class="detail-value">${alias.fullAddress || `${alias.alias}@${getDomainName(alias.domainId)}`}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Forwards To</span>
                <span class="detail-value">${alias.destinationEmail}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status</span>
                <span class="detail-value">${alias.emailVerified ? 'Active' : 'Pending Verification'}</span>
            </div>
            ${!alias.emailVerified ? `
            <p class="text-muted mt-3" style="font-size: 0.875rem;">
                Please check your email to verify your address. The alias won't forward emails until verified.
            </p>
            ` : ''}
            ${alias.managementToken ? `
            <p class="text-muted mt-3" style="font-size: 0.875rem;">
                A management link has been sent to your email for future management of this alias.
            </p>
            ` : ''}
        `;
        openModal(elements.successModal);

        // Reset form
        elements.createAliasForm.reset();
        updateAliasPreview();

    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        btn.disabled = false;
        btnText.style.display = '';
        btnLoading.style.display = 'none';
    }
}

// Get domain name by ID
function getDomainName(domainId) {
    const domain = state.domains.find(d => d.id === domainId);
    return domain ? domain.domain : 'makeanon.info';
}

// Login
async function login(e) {
    e.preventDefault();

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    try {
        errorEl.textContent = '';
        const response = await api('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });

        state.token = response.data.token;
        state.user = response.data.user;
        localStorage.setItem('token', state.token);

        closeModal(elements.loginModal);
        updateAuthUI();
        showToast('Logged in successfully');

        // Reload current section
        showSection(state.currentSection);

    } catch (error) {
        errorEl.textContent = error.message;
    }
}

// Signup
async function signup(e) {
    e.preventDefault();

    const name = document.getElementById('signupName').value;
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const errorEl = document.getElementById('signupError');

    try {
        errorEl.textContent = '';
        const response = await api('/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ name, email, password })
        });

        state.token = response.data.token;
        state.user = response.data.user;
        localStorage.setItem('token', state.token);

        closeModal(elements.signupModal);
        updateAuthUI();
        showToast('Account created successfully');

    } catch (error) {
        errorEl.textContent = error.message;
    }
}

// Logout
function logout() {
    state.token = null;
    state.user = null;
    state.aliases = [];
    localStorage.removeItem('token');
    updateAuthUI();
    showSection('create');
    showToast('Logged out');
}

// Load user profile
async function loadProfile() {
    if (!state.user) return;

    try {
        const response = await api('/auth/profile');
        state.user = response.data;

        elements.profileContent.innerHTML = `
            <div class="detail-row">
                <span class="detail-label">Email</span>
                <span class="detail-value">${state.user.email}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Name</span>
                <span class="detail-value">${state.user.name || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Role</span>
                <span class="detail-value">${state.user.role}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Member Since</span>
                <span class="detail-value">${new Date(state.user.createdAt).toLocaleDateString()}</span>
            </div>
        `;
    } catch (error) {
        elements.profileContent.innerHTML = `<p class="text-muted text-center">Failed to load profile</p>`;
    }
}

// Load stats
async function loadStats() {
    if (!state.user) return;

    try {
        const response = await api('/aliases/stats');
        const stats = response.data;

        elements.statsContent.innerHTML = `
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-value">${stats.totalAliases || 0}</div>
                    <div class="stat-label">Total Aliases</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${stats.activeAliases || 0}</div>
                    <div class="stat-label">Active</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${stats.emailsForwarded || 0}</div>
                    <div class="stat-label">Emails Forwarded</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${stats.emailsBlocked || 0}</div>
                    <div class="stat-label">Blocked</div>
                </div>
            </div>
        `;
    } catch (error) {
        elements.statsContent.innerHTML = `<p class="text-muted text-center">Failed to load statistics</p>`;
    }
}

// Load email logs
async function loadLogs() {
    if (!state.user) return;

    try {
        const response = await api('/aliases/logs?limit=20');
        const logs = response.data || [];

        if (logs.length === 0) {
            elements.logsContent.innerHTML = `<p class="text-muted text-center">No email activity yet</p>`;
            return;
        }

        elements.logsContent.innerHTML = `
            <table class="logs-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Alias</th>
                        <th>From</th>
                        <th>Subject</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map(log => `
                        <tr>
                            <td>${new Date(log.createdAt).toLocaleString()}</td>
                            <td>${log.alias?.alias || '-'}</td>
                            <td>${log.fromAddress || '-'}</td>
                            <td>${log.subject || '-'}</td>
                            <td><span class="alias-status status-${log.status === 'forwarded' ? 'active' : 'inactive'}">${log.status}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        elements.logsContent.innerHTML = `<p class="text-muted text-center">Failed to load logs</p>`;
    }
}

// Load user aliases
async function loadUserAliases() {
    if (!state.user) return;

    try {
        const response = await api('/aliases');
        state.aliases = response.data || [];
        renderAliasesList();
    } catch (error) {
        elements.aliasesList.innerHTML = `<p class="text-muted text-center">Failed to load aliases</p>`;
    }
}

// Render aliases list
function renderAliasesList() {
    if (state.aliases.length === 0) {
        elements.aliasesList.innerHTML = `
            <p class="text-muted text-center">No aliases yet. Create your first alias!</p>
        `;
        return;
    }

    elements.aliasesList.innerHTML = state.aliases.map(alias => `
        <div class="alias-item" data-id="${alias.id}">
            <div class="alias-info">
                <div class="alias-address">${alias.alias}@${getDomainName(alias.domainId)}</div>
                ${alias.label ? `<div class="alias-label">${alias.label}</div>` : ''}
                <div class="alias-meta">
                    <span class="alias-status ${alias.isActive ? 'status-active' : 'status-inactive'}">
                        ${alias.isActive ? 'Active' : 'Inactive'}
                    </span>
                    ${!alias.emailVerified ? '<span class="alias-status status-pending">Unverified</span>' : ''}
                    <span>Forwarded: ${alias._count?.emailLogs || 0}</span>
                </div>
            </div>
            <div class="alias-actions">
                <button class="btn btn-outline btn-sm" onclick="toggleAlias('${alias.id}', ${!alias.isActive})">
                    ${alias.isActive ? 'Disable' : 'Enable'}
                </button>
                <button class="btn btn-outline btn-sm" onclick="showAliasDetails('${alias.id}')">Details</button>
                <button class="btn btn-danger btn-sm" onclick="deleteAlias('${alias.id}')">Delete</button>
            </div>
        </div>
    `).join('');
}

// Toggle alias active state
async function toggleAlias(id, activate) {
    try {
        await api(`/aliases/${id}/toggle`, { method: 'POST' });
        showToast(`Alias ${activate ? 'enabled' : 'disabled'}`);
        loadUserAliases();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Delete alias
async function deleteAlias(id) {
    if (!confirm('Are you sure you want to delete this alias? This cannot be undone.')) {
        return;
    }

    try {
        await api(`/aliases/${id}`, { method: 'DELETE' });
        showToast('Alias deleted');
        loadUserAliases();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Show alias details modal
async function showAliasDetails(id) {
    try {
        const response = await api(`/aliases/${id}`);
        const alias = response.data;

        document.getElementById('aliasModalContent').innerHTML = `
            <div class="detail-row">
                <span class="detail-label">Alias Address</span>
                <span class="detail-value">${alias.alias}@${getDomainName(alias.domainId)}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Forwards To</span>
                <span class="detail-value">${alias.destinationEmail}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Label</span>
                <span class="detail-value">${alias.label || '-'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status</span>
                <span class="detail-value">
                    <span class="alias-status ${alias.isActive ? 'status-active' : 'status-inactive'}">
                        ${alias.isActive ? 'Active' : 'Inactive'}
                    </span>
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Email Verified</span>
                <span class="detail-value">${alias.emailVerified ? 'Yes' : 'No'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Created</span>
                <span class="detail-value">${new Date(alias.createdAt).toLocaleString()}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Emails Forwarded</span>
                <span class="detail-value">${alias._count?.emailLogs || 0}</span>
            </div>

            <h3 class="mt-4">Blocked Senders</h3>
            <div class="blocked-list" id="blockedList">
                ${(alias.blockedSenders || []).length === 0
                    ? '<p class="text-muted">No blocked senders</p>'
                    : alias.blockedSenders.map(b => `
                        <div class="blocked-item">
                            <span class="blocked-email">${b.email}</span>
                            <button class="btn btn-danger btn-sm" onclick="unblockSender('${alias.id}', '${b.id}')">Remove</button>
                        </div>
                    `).join('')
                }
            </div>

            <form class="form mt-3" onsubmit="blockSender(event, '${alias.id}')">
                <div class="form-row">
                    <div class="form-group flex-1">
                        <input type="email" class="input" placeholder="email@example.com" id="blockEmail" required>
                    </div>
                    <button type="submit" class="btn btn-outline">Block Sender</button>
                </div>
            </form>

            <div class="mt-4" style="display: flex; gap: 0.5rem;">
                <button class="btn btn-outline flex-1" onclick="toggleAlias('${alias.id}', ${!alias.isActive}); closeAllModals();">
                    ${alias.isActive ? 'Disable Alias' : 'Enable Alias'}
                </button>
                <button class="btn btn-danger flex-1" onclick="deleteAlias('${alias.id}'); closeAllModals();">
                    Delete Alias
                </button>
            </div>
        `;

        openModal(elements.aliasModal);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Block sender
async function blockSender(e, aliasId) {
    e.preventDefault();
    const email = document.getElementById('blockEmail').value;

    try {
        await api(`/aliases/${aliasId}/block`, {
            method: 'POST',
            body: JSON.stringify({ email })
        });
        showToast('Sender blocked');
        showAliasDetails(aliasId);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Unblock sender
async function unblockSender(aliasId, blockId) {
    try {
        await api(`/aliases/${aliasId}/block/${blockId}`, { method: 'DELETE' });
        showToast('Sender unblocked');
        showAliasDetails(aliasId);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Manage alias with token
async function manageWithToken(e) {
    e.preventDefault();

    const token = document.getElementById('managementToken').value.trim();
    if (!token) return;

    try {
        const response = await api(`/public/manage/${token}`);
        const alias = response.data;

        elements.tokenAliasDetails.classList.remove('hidden');
        elements.tokenAliasDetails.innerHTML = `
            <div class="detail-row">
                <span class="detail-label">Alias Address</span>
                <span class="detail-value">${alias.fullAddress || alias.alias}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Forwards To</span>
                <span class="detail-value">${alias.destinationEmail}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status</span>
                <span class="detail-value">
                    <span class="alias-status ${alias.isActive ? 'status-active' : 'status-inactive'}">
                        ${alias.isActive ? 'Active' : 'Inactive'}
                    </span>
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Verified</span>
                <span class="detail-value">${alias.emailVerified ? 'Yes' : 'No'}</span>
            </div>

            <div class="mt-4" style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <button class="btn btn-outline" onclick="togglePublicAlias('${token}', ${!alias.isActive})">
                    ${alias.isActive ? 'Disable' : 'Enable'}
                </button>
                <button class="btn btn-danger" onclick="deletePublicAlias('${token}')">
                    Delete Alias
                </button>
            </div>

            <h3 class="mt-4">Block a Sender</h3>
            <form class="form" onsubmit="blockPublicSender(event, '${token}')">
                <div class="form-row">
                    <div class="form-group flex-1">
                        <input type="email" class="input" placeholder="spammer@example.com" id="publicBlockEmail" required>
                    </div>
                    <button type="submit" class="btn btn-outline">Block</button>
                </div>
            </form>
        `;
    } catch (error) {
        showToast(error.message, 'error');
        elements.tokenAliasDetails.classList.add('hidden');
    }
}

// Toggle public alias
async function togglePublicAlias(token, activate) {
    try {
        await api(`/public/manage/${token}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: activate })
        });
        showToast(`Alias ${activate ? 'enabled' : 'disabled'}`);
        // Reload
        document.getElementById('tokenManageForm').dispatchEvent(new Event('submit'));
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Delete public alias
async function deletePublicAlias(token) {
    if (!confirm('Are you sure you want to delete this alias?')) return;

    try {
        await api(`/public/manage/${token}`, { method: 'DELETE' });
        showToast('Alias deleted');
        elements.tokenAliasDetails.classList.add('hidden');
        document.getElementById('managementToken').value = '';
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Block sender for public alias
async function blockPublicSender(e, token) {
    e.preventDefault();
    const email = document.getElementById('publicBlockEmail').value;

    try {
        await api(`/public/manage/${token}/block`, {
            method: 'POST',
            body: JSON.stringify({ email })
        });
        showToast('Sender blocked');
        document.getElementById('publicBlockEmail').value = '';
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Check auth on load
async function checkAuth() {
    if (!state.token) return;

    try {
        const response = await api('/auth/profile');
        state.user = response.data;
        updateAuthUI();
    } catch (error) {
        // Token invalid
        state.token = null;
        state.user = null;
        localStorage.removeItem('token');
    }
}

// Tab switching
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;

            // Update buttons
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update content
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`${tabId}Tab`).classList.add('active');
        });
    });
}

// Event Listeners
function initEventListeners() {
    // Mobile menu
    elements.mobileMenuBtn.addEventListener('click', () => {
        elements.mainNav.classList.toggle('active');
    });

    // Navigation
    elements.navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            showSection(link.dataset.section);
            elements.mainNav.classList.remove('active');
        });
    });

    // Auth buttons
    elements.loginBtn.addEventListener('click', () => openModal(elements.loginModal));
    elements.signupBtn.addEventListener('click', () => openModal(elements.signupModal));
    elements.logoutBtn.addEventListener('click', logout);
    document.getElementById('loginPromptBtn').addEventListener('click', () => openModal(elements.loginModal));
    document.getElementById('switchToSignup').addEventListener('click', (e) => {
        e.preventDefault();
        closeModal(elements.loginModal);
        openModal(elements.signupModal);
    });
    document.getElementById('switchToLogin').addEventListener('click', (e) => {
        e.preventDefault();
        closeModal(elements.signupModal);
        openModal(elements.loginModal);
    });

    // Forms
    elements.createAliasForm.addEventListener('submit', createAlias);
    elements.loginForm.addEventListener('submit', login);
    elements.signupForm.addEventListener('submit', signup);
    elements.tokenManageForm.addEventListener('submit', manageWithToken);

    // Alias preview
    elements.customAlias.addEventListener('input', updateAliasPreview);
    elements.domainSelect.addEventListener('change', updateAliasPreview);

    // Modal close
    document.querySelectorAll('.modal-backdrop, [data-close]').forEach(el => {
        el.addEventListener('click', closeAllModals);
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllModals();
    });

    // Prevent modal content clicks from closing
    document.querySelectorAll('.modal-content').forEach(el => {
        el.addEventListener('click', (e) => e.stopPropagation());
    });
}

// Initialize
async function init() {
    initEventListeners();
    initTabs();
    await loadDomains();
    await checkAuth();

    // Handle hash navigation
    const hash = window.location.hash.slice(1);
    if (['create', 'manage', 'account'].includes(hash)) {
        showSection(hash);
    }
}

// Start app
document.addEventListener('DOMContentLoaded', init);

// Make functions available globally for onclick handlers
window.toggleAlias = toggleAlias;
window.deleteAlias = deleteAlias;
window.showAliasDetails = showAliasDetails;
window.blockSender = blockSender;
window.unblockSender = unblockSender;
window.togglePublicAlias = togglePublicAlias;
window.deletePublicAlias = deletePublicAlias;
window.blockPublicSender = blockPublicSender;
window.closeAllModals = closeAllModals;
