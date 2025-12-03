// MakeAnon - Frontend Application
const API_BASE = '/api/v1';

// State
let state = {
    domains: [],
    currentSection: 'create',
    currentManagementToken: null
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

    // Forms
    createAliasForm: document.getElementById('createAliasForm'),
    tokenManageForm: document.getElementById('tokenManageForm'),

    // Modals
    successModal: document.getElementById('successModal'),

    // Create alias
    destinationEmail: document.getElementById('destinationEmail'),
    customAlias: document.getElementById('customAlias'),
    domainSelect: document.getElementById('domainSelect'),
    aliasLabel: document.getElementById('aliasLabel'),
    previewAddress: document.getElementById('previewAddress'),

    // Content areas
    tokenAliasDetails: document.getElementById('tokenAliasDetails'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// API Helper
async function api(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

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

        const response = await api('/alias', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        // Show success modal
        const alias = response.data;
        document.getElementById('successDetails').innerHTML = `
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
                <span class="detail-value">${alias.emailVerified ? 'Active' : 'Pending Verification'}</span>
            </div>
            <p class="text-muted mt-3" style="font-size: 0.875rem;">
                Please check your email to verify your address and get your management token.
            </p>
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

// Manage alias with token
async function manageWithToken(e) {
    e.preventDefault();

    const token = document.getElementById('managementToken').value.trim();
    if (!token) return;

    // Store the token for later use
    state.currentManagementToken = token;

    try {
        const response = await api(`/manage/${token}`);
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
                <button class="btn ${alias.isActive ? 'btn-outline' : 'btn-success'}" id="toggleAliasBtn">
                    ${alias.isActive ? 'Disable Alias' : 'Enable Alias'}
                </button>
                <button class="btn btn-danger" id="deleteAliasBtn">
                    Delete Alias
                </button>
            </div>

            <h3 class="mt-4">Block a Sender</h3>
            <form class="form" id="blockSenderForm">
                <div class="form-row">
                    <div class="form-group flex-1">
                        <input type="email" class="input" placeholder="spammer@example.com" id="publicBlockEmail" required>
                    </div>
                    <button type="submit" class="btn btn-outline">Block</button>
                </div>
            </form>
        `;

        // Attach event listeners to the buttons
        document.getElementById('toggleAliasBtn').addEventListener('click', () => {
            togglePublicAlias(!alias.isActive);
        });

        document.getElementById('deleteAliasBtn').addEventListener('click', deletePublicAlias);

        document.getElementById('blockSenderForm').addEventListener('submit', blockPublicSender);

    } catch (error) {
        showToast(error.message, 'error');
        elements.tokenAliasDetails.classList.add('hidden');
    }
}

// Toggle public alias
async function togglePublicAlias(activate) {
    if (!state.currentManagementToken) return;

    try {
        await api(`/manage/${state.currentManagementToken}`, {
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
async function deletePublicAlias() {
    if (!state.currentManagementToken) return;
    if (!confirm('Are you sure you want to delete this alias? This cannot be undone.')) return;

    try {
        await api(`/manage/${state.currentManagementToken}`, { method: 'DELETE' });
        showToast('Alias deleted');
        elements.tokenAliasDetails.classList.add('hidden');
        document.getElementById('managementToken').value = '';
        state.currentManagementToken = null;
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Block sender for public alias
async function blockPublicSender(e) {
    e.preventDefault();
    if (!state.currentManagementToken) return;

    const email = document.getElementById('publicBlockEmail').value;

    try {
        await api(`/manage/${state.currentManagementToken}/block`, {
            method: 'POST',
            body: JSON.stringify({ email })
        });
        showToast('Sender blocked');
        document.getElementById('publicBlockEmail').value = '';
    } catch (error) {
        showToast(error.message, 'error');
    }
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

    // Forms
    elements.createAliasForm.addEventListener('submit', createAlias);
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
    await loadDomains();

    // Handle hash navigation with query params (e.g., #manage?token=xxx&verified=true)
    const hashParts = window.location.hash.slice(1).split('?');
    const section = hashParts[0];
    const params = new URLSearchParams(hashParts[1] || '');

    if (['create', 'manage'].includes(section)) {
        showSection(section);

        // If on manage section with a token, auto-load the alias
        if (section === 'manage' && params.get('token')) {
            const token = params.get('token');
            const verified = params.get('verified') === 'true';

            // Fill in the token
            document.getElementById('managementToken').value = token;

            // Show success message if just verified
            if (verified) {
                showToast('Email verified successfully! Your alias is now active.', 'success');
            }

            // Auto-load the alias
            setTimeout(() => {
                document.getElementById('tokenManageForm').dispatchEvent(new Event('submit'));
            }, 100);
        }
    }
}

// Start app
document.addEventListener('DOMContentLoaded', init);

// Make functions available globally
window.closeAllModals = closeAllModals;
