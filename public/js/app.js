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
                <span class="detail-value">
                    <span class="alias-status ${alias.isActive ? 'status-active' : 'status-inactive'}">
                        ${alias.isActive ? 'Active' : 'Pending Verification'}
                    </span>
                </span>
            </div>

            <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <p style="margin: 0 0 8px 0; font-weight: 600; color: #92400e;">Save Your Management Token</p>
                <p style="margin: 0 0 12px 0; font-size: 0.75rem; color: #a16207;">You'll need this token to manage, disable, or delete your alias.</p>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="text" readonly value="${alias.managementToken}" id="successTokenInput"
                        style="flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-family: monospace; font-size: 0.875rem; background: white;">
                    <button type="button" class="btn btn-outline" id="copyTokenBtn" style="white-space: nowrap;">
                        Copy
                    </button>
                </div>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 16px;">
                <button type="button" class="btn btn-primary" id="manageNowBtn" style="flex: 1;">
                    Manage Alias
                </button>
                <button type="button" class="btn btn-outline" onclick="closeAllModals()" style="flex: 1;">
                    Done
                </button>
            </div>

            <p class="text-muted mt-3" style="font-size: 0.75rem; color: #f59e0b; text-align: center;">
                Verify your email within 72 hours or your alias will be deleted.
            </p>
        `;

        // Add event listeners for the new buttons
        document.getElementById('copyTokenBtn').addEventListener('click', () => {
            const input = document.getElementById('successTokenInput');
            input.select();
            navigator.clipboard.writeText(input.value).then(() => {
                document.getElementById('copyTokenBtn').textContent = 'Copied!';
                setTimeout(() => {
                    document.getElementById('copyTokenBtn').textContent = 'Copy';
                }, 2000);
            });
        });

        document.getElementById('manageNowBtn').addEventListener('click', () => {
            closeAllModals();
            showSection('manage');
            document.getElementById('managementToken').value = alias.managementToken;
            document.getElementById('tokenManageForm').dispatchEvent(new Event('submit'));
        });

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

// Format date for display
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
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

        // Build deletion warning if scheduled
        let deletionWarning = '';
        if (alias.scheduledDeletion) {
            const deletionDate = formatDate(alias.scheduledDeletion.date);
            deletionWarning = `
                <div class="deletion-warning" style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;">
                    <div style="color: #dc2626; font-weight: 600; margin-bottom: 4px;">Scheduled for Deletion</div>
                    <div style="color: #7f1d1d; font-size: 0.875rem;">${alias.scheduledDeletion.reason}</div>
                    <div style="color: #991b1b; font-size: 0.875rem; margin-top: 4px;">Will be deleted on: <strong>${deletionDate}</strong></div>
                </div>
            `;
        }

        elements.tokenAliasDetails.classList.remove('hidden');
        elements.tokenAliasDetails.innerHTML = `
            ${deletionWarning}
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
            <div class="detail-row">
                <span class="detail-label">Emails Forwarded</span>
                <span class="detail-value" style="font-weight: 600; color: #4F46E5;">${alias.forwardCount || 0}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Created</span>
                <span class="detail-value">${formatDate(alias.createdAt)}</span>
            </div>
            ${alias.lastForwardAt ? `
            <div class="detail-row">
                <span class="detail-label">Last Forward</span>
                <span class="detail-value">${formatDate(alias.lastForwardAt)}</span>
            </div>
            ` : ''}

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
