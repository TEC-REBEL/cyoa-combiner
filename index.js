/**
 * CYOA Multi-Choice Combiner — SillyTavern Extension
 *
 * Intercepts CYOA choice buttons (.menu-msg-button) in AI messages,
 * allows selecting multiple choices, mixing in custom text, editing
 * individual items, and sending them as a single combined message.
 */

import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

/* ═══════════════════════════════════════════════════════════
   Constants & State
   ═══════════════════════════════════════════════════════════ */

const moduleUrl = new URL(import.meta.url);
const pathSegments = moduleUrl.pathname.split('/');
const extIndex = pathSegments.indexOf('extensions');
const EXT_NAME = pathSegments.slice(extIndex + 1, pathSegments.length - 1).join('/');

const LOG = '[CYOA-Combiner]';

const DEFAULT_SETTINGS = {
    enabled: true,
    sendFormat: 'I choose:\n{choices}',
    showNumbers: true,
    joinSeparator: '\n',
};

/**
 * Ordered queue of items to send. Each item is either a clicked choice
 * or user-written custom text.
 *
 * @typedef  {Object} QueueItem
 * @property {string}          id         Unique ID for DOM tracking
 * @property {'choice'|'custom'} type     Item type
 * @property {string}          text       Display/send text (editable)
 * @property {string}          [mesId]    Message ID (choices only)
 * @property {number}          [btnIndex] Button index in the OL (choices only)
 *
 * @type {QueueItem[]}
 */
const queue = [];

let nextItemId = 1;

/** Reference to the floating composition panel element */
let panel = null;

/** Flag to temporarily bypass our interception (when we're the ones sending) */
let isSending = false;

/* ═══════════════════════════════════════════════════════════
   Settings helpers
   ═══════════════════════════════════════════════════════════ */

function settings() {
    return extension_settings[EXT_NAME];
}

/* ═══════════════════════════════════════════════════════════
   Queue Management
   ═══════════════════════════════════════════════════════════ */

/**
 * Generate a unique item ID.
 */
function uid() {
    return 'cyoa-item-' + (nextItemId++);
}

/**
 * Add a choice from a button click.
 * @param {HTMLElement} buttonEl
 */
function addChoice(buttonEl) {
    const mesEl = buttonEl.closest('.mes');
    if (!mesEl) return;

    const mesId = mesEl.getAttribute('mesid') || '';
    const liEl = buttonEl.closest('li');
    const olEl = liEl?.closest('ol');
    let btnIndex = 0;
    if (olEl && liEl) {
        btnIndex = Array.from(olEl.querySelectorAll(':scope > li')).indexOf(liEl);
    }

    const choiceText = buttonEl.textContent.trim();

    // Check if already in queue
    const existing = queue.find(
        q => q.type === 'choice' && q.mesId === mesId && q.btnIndex === btnIndex,
    );
    if (existing) {
        // Deselect — remove from queue
        removeItem(existing.id);
        return;
    }

    queue.push({
        id: uid(),
        type: 'choice',
        text: choiceText,
        mesId,
        btnIndex,
    });

    buttonEl.classList.add('cyoa-selected');
    refreshButtonBadges();
    renderPanel();
}

/**
 * Add a custom text item to the queue.
 * @param {string} text
 */
function addCustomText(text) {
    if (!text.trim()) return;
    queue.push({
        id: uid(),
        type: 'custom',
        text: text.trim(),
    });
    renderPanel();
}

/**
 * Remove an item from the queue by ID.
 * @param {string} itemId
 */
function removeItem(itemId) {
    const idx = queue.findIndex(q => q.id === itemId);
    if (idx < 0) return;

    const item = queue[idx];

    // If it's a choice, un-highlight the button
    if (item.type === 'choice') {
        const btn = findButton(item.mesId, item.btnIndex);
        if (btn) {
            btn.classList.remove('cyoa-selected');
            const badge = btn.querySelector('.cyoa-select-number');
            if (badge) badge.remove();
        }
    }

    queue.splice(idx, 1);
    refreshButtonBadges();
    renderPanel();
}

/**
 * Move an item up or down in the queue.
 * @param {string} itemId
 * @param {'up'|'down'} direction
 */
function moveItem(itemId, direction) {
    const idx = queue.findIndex(q => q.id === itemId);
    if (idx < 0) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= queue.length) return;

    [queue[idx], queue[swapIdx]] = [queue[swapIdx], queue[idx]];
    refreshButtonBadges();
    renderPanel();
}

/**
 * Update the text of a queue item.
 * @param {string} itemId
 * @param {string} newText
 */
function editItemText(itemId, newText) {
    const item = queue.find(q => q.id === itemId);
    if (item) {
        item.text = newText;
    }
}

/**
 * Clear the entire queue.
 */
function clearQueue() {
    // Un-highlight all buttons
    document.querySelectorAll('.custom-menu-msg-button.cyoa-selected').forEach(btn => {
        btn.classList.remove('cyoa-selected');
        const badge = btn.querySelector('.cyoa-select-number');
        if (badge) badge.remove();
    });
    queue.length = 0;
    renderPanel();
}

/**
 * Find a button element by message ID and button index.
 * @param {string} mesId
 * @param {number} btnIndex
 * @returns {HTMLElement|null}
 */
function findButton(mesId, btnIndex) {
    const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
    if (!mesEl) return null;
    const buttons = mesEl.querySelectorAll('.custom-menu-msg-button');
    return buttons[btnIndex] || null;
}

/**
 * Refresh the numbered badges on all selected choice buttons.
 */
function refreshButtonBadges() {
    // Clear all existing badges first
    document.querySelectorAll('.cyoa-select-number').forEach(b => b.remove());
    document.querySelectorAll('.custom-menu-msg-button.cyoa-selected').forEach(b => {
        b.classList.remove('cyoa-selected');
    });

    // Re-apply in queue order (only choices)
    let counter = 0;
    for (const item of queue) {
        if (item.type !== 'choice') continue;
        counter++;
        const btn = findButton(item.mesId, item.btnIndex);
        if (!btn) continue;
        btn.classList.add('cyoa-selected');
        const badge = document.createElement('span');
        badge.className = 'cyoa-select-number';
        badge.textContent = String(counter);
        btn.prepend(badge);
    }
}

/* ═══════════════════════════════════════════════════════════
   Composition Panel
   ═══════════════════════════════════════════════════════════ */

function createPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'cyoa-panel';
    panel.className = 'cyoa-panel';
    document.body.appendChild(panel);
}

/**
 * Render (or re-render) the entire composition panel.
 */
function renderPanel() {
    if (!panel) createPanel();

    const count = queue.length;

    // Build the queue items list
    let itemsHtml = '';
    queue.forEach((item, i) => {
        const isFirst = i === 0;
        const isLast = i === queue.length - 1;
        const typeIcon = item.type === 'choice'
            ? `<svg class="cyoa-item-type-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`
            : `<svg class="cyoa-item-type-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;

        const escapedText = escapeHtml(item.text);
        const truncText = item.text.length > 80 ? escapeHtml(item.text.substring(0, 77)) + '…' : escapedText;

        itemsHtml += `
            <div class="cyoa-queue-item" data-item-id="${item.id}">
                <div class="cyoa-item-order">${i + 1}</div>
                <div class="cyoa-item-type ${item.type === 'custom' ? 'cyoa-type-custom' : 'cyoa-type-choice'}">${typeIcon}</div>
                <div class="cyoa-item-text" data-item-id="${item.id}" title="${escapedText}">${truncText}</div>
                <div class="cyoa-item-actions">
                    <button class="cyoa-item-btn cyoa-item-edit" data-item-id="${item.id}" title="Edit text">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button class="cyoa-item-btn cyoa-item-up" data-item-id="${item.id}" title="Move up" ${isFirst ? 'disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
                    </button>
                    <button class="cyoa-item-btn cyoa-item-down" data-item-id="${item.id}" title="Move down" ${isLast ? 'disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                    <button class="cyoa-item-btn cyoa-item-remove" data-item-id="${item.id}" title="Remove">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>`;
    });

    panel.innerHTML = `
        <div class="cyoa-panel-inner">
            <div class="cyoa-panel-header">
                <div class="cyoa-panel-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9 11l3 3L22 4"/>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                    </svg>
                    <span>Compose Response</span>
                    <span class="cyoa-count-badge">${count}</span>
                </div>
                <div class="cyoa-panel-header-actions">
                    <button class="cyoa-header-btn" id="cyoa-collapse-btn" title="Minimize">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                </div>
            </div>

            <div class="cyoa-queue-list" id="cyoa-queue-list">
                ${itemsHtml || '<div class="cyoa-empty-hint">Click choice buttons to add them here, or add custom text below.</div>'}
            </div>

            <div class="cyoa-add-custom">
                <input type="text" class="cyoa-custom-input" id="cyoa-custom-input"
                       placeholder="✍ Type custom text to add…"
                       autocomplete="off" />
                <button class="cyoa-add-btn" id="cyoa-add-custom-btn" title="Add custom text">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add
                </button>
            </div>

            <div class="cyoa-panel-footer">
                <button class="cyoa-btn cyoa-btn-clear" id="cyoa-clear-btn" title="Clear everything">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    Clear All
                </button>
                <button class="cyoa-btn cyoa-btn-send" id="cyoa-send-btn" ${count === 0 ? 'disabled' : ''}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                    Send Combined
                </button>
            </div>
        </div>
    `;

    // Show / hide
    if (count > 0) {
        panel.classList.add('cyoa-visible');
    } else {
        panel.classList.remove('cyoa-visible');
        panel.classList.remove('cyoa-collapsed');
    }

    bindPanelEvents();
}

/**
 * Bind event listeners inside the panel after a re-render.
 */
function bindPanelEvents() {
    if (!panel) return;

    // Clear
    panel.querySelector('#cyoa-clear-btn')?.addEventListener('click', clearQueue);

    // Send
    panel.querySelector('#cyoa-send-btn')?.addEventListener('click', sendCombinedChoices);

    // Collapse / expand
    panel.querySelector('#cyoa-collapse-btn')?.addEventListener('click', () => {
        panel.classList.toggle('cyoa-collapsed');
    });

    // Add custom text
    const input = panel.querySelector('#cyoa-custom-input');
    const addBtn = panel.querySelector('#cyoa-add-custom-btn');

    function handleAddCustom() {
        if (!input) return;
        const text = input.value.trim();
        if (text) {
            addCustomText(text);
            input.value = '';
        }
        input.focus();
    }

    addBtn?.addEventListener('click', handleAddCustom);
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddCustom();
        }
    });

    // Item actions (using event delegation on the queue list)
    const queueList = panel.querySelector('#cyoa-queue-list');
    if (queueList) {
        queueList.addEventListener('click', (e) => {
            const target = e.target.closest('[data-item-id]');
            if (!target) return;
            const itemId = target.dataset.itemId;

            if (target.classList.contains('cyoa-item-remove')) {
                removeItem(itemId);
            } else if (target.classList.contains('cyoa-item-up')) {
                moveItem(itemId, 'up');
            } else if (target.classList.contains('cyoa-item-down')) {
                moveItem(itemId, 'down');
            } else if (target.classList.contains('cyoa-item-edit')) {
                startEditingItem(itemId);
            }
        });
    }
}

/**
 * Start inline editing a queue item.
 * @param {string} itemId
 */
function startEditingItem(itemId) {
    const item = queue.find(q => q.id === itemId);
    if (!item) return;

    const itemEl = panel.querySelector(`.cyoa-queue-item[data-item-id="${itemId}"]`);
    if (!itemEl) return;

    const textEl = itemEl.querySelector('.cyoa-item-text');
    if (!textEl) return;

    // Already editing?
    if (textEl.querySelector('.cyoa-edit-input')) return;

    const currentText = item.text;

    // Replace text with input
    textEl.innerHTML = '';
    const editInput = document.createElement('input');
    editInput.type = 'text';
    editInput.className = 'cyoa-edit-input';
    editInput.value = currentText;
    textEl.appendChild(editInput);

    // Add save/cancel buttons
    const saveBtn = document.createElement('button');
    saveBtn.className = 'cyoa-edit-save';
    saveBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
    saveBtn.title = 'Save';
    textEl.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cyoa-edit-cancel';
    cancelBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    cancelBtn.title = 'Cancel';
    textEl.appendChild(cancelBtn);

    editInput.focus();
    editInput.select();

    function save() {
        const newText = editInput.value.trim();
        if (newText) {
            editItemText(itemId, newText);
        }
        renderPanel();
    }

    function cancel() {
        renderPanel();
    }

    saveBtn.addEventListener('click', (e) => { e.stopPropagation(); save(); });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
    editInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    // Prevent clicks on the input from triggering other handlers
    editInput.addEventListener('click', (e) => e.stopPropagation());
}

/* ═══════════════════════════════════════════════════════════
   Message Sending
   ═══════════════════════════════════════════════════════════ */

/**
 * Format and send the combined queue.
 */
async function sendCombinedChoices() {
    const s = settings();

    if (queue.length === 0) return;

    // Build the lines
    const lines = queue.map((item, i) => {
        if (s.showNumbers) {
            return `${i + 1}. ${item.text}`;
        }
        return item.text;
    });

    const choicesText = lines.join(s.joinSeparator || '\n');

    // Apply send format template
    let messageText = (s.sendFormat || '{choices}').replace('{choices}', choicesText);

    console.log(LOG, 'Sending combined:', messageText);

    // Clear queue
    clearQueue();

    // Set sending flag
    isSending = true;

    // Use SillyTavern's normal send flow
    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        $(textarea).val(messageText);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        $('#send_but').trigger('click');
    }

    setTimeout(() => { isSending = false; }, 500);
}

/* ═══════════════════════════════════════════════════════════
   Click Interception
   ═══════════════════════════════════════════════════════════ */

/**
 * Capture-phase click interceptor for .custom-menu-msg-button elements.
 * @param {MouseEvent} e
 */
function onButtonClick(e) {
    if (isSending) return;

    const s = settings();
    if (!s || !s.enabled) return;

    const button = e.target.closest('.custom-menu-msg-button');
    if (!button) return;

    const mesEl = button.closest('.mes');
    if (!mesEl) return;

    // Don't intercept clicks when we're inside an edit input
    if (e.target.closest('.cyoa-edit-input')) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    addChoice(button);
}

/* ═══════════════════════════════════════════════════════════
   Event Handlers
   ═══════════════════════════════════════════════════════════ */

function onChatChanged() { clearQueue(); }
function onMessageSwiped() { clearQueue(); }
function onGenerationStarted() { clearQueue(); }

/**
 * Enhance choice buttons in newly rendered messages.
 * @param {number} mesId
 */
function onCharacterMessageRendered(mesId) {
    const s = settings();
    if (!s || !s.enabled) return;

    const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
    if (!mesEl) return;

    const buttons = mesEl.querySelectorAll('.custom-menu-msg-button');
    if (buttons.length === 0) return;

    console.log(LOG, `Found ${buttons.length} choice buttons in message ${mesId}`);

    buttons.forEach(btn => {
        if (!btn.classList.contains('cyoa-enhanced')) {
            btn.classList.add('cyoa-enhanced');
            const hint = document.createElement('span');
            hint.className = 'cyoa-multi-hint';
            hint.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
            btn.appendChild(hint);
        }
    });
}

/* ═══════════════════════════════════════════════════════════
   Utility
   ═══════════════════════════════════════════════════════════ */

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/* ═══════════════════════════════════════════════════════════
   Settings UI
   ═══════════════════════════════════════════════════════════ */

async function setupUI() {
    const html = await renderExtensionTemplateAsync(EXT_NAME, 'settings');
    document.getElementById('extensions_settings').append(
        ...new DOMParser().parseFromString(html, 'text/html').body.childNodes,
    );

    const s = settings();

    const enabledCb = document.getElementById('cyoa_enabled');
    if (enabledCb) {
        enabledCb.checked = s.enabled;
        enabledCb.addEventListener('change', () => {
            s.enabled = enabledCb.checked;
            saveSettingsDebounced();
            if (!s.enabled) clearQueue();
        });
    }

    const showNumCb = document.getElementById('cyoa_show_numbers');
    if (showNumCb) {
        showNumCb.checked = s.showNumbers;
        showNumCb.addEventListener('change', () => {
            s.showNumbers = showNumCb.checked;
            saveSettingsDebounced();
        });
    }

    const formatInput = document.getElementById('cyoa_send_format');
    if (formatInput) {
        formatInput.value = s.sendFormat;
        let saveTimer = null;
        formatInput.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                s.sendFormat = formatInput.value;
                saveSettingsDebounced();
            }, 500);
        });
    }

    document.getElementById('cyoa_reset_format')?.addEventListener('click', () => {
        s.sendFormat = DEFAULT_SETTINGS.sendFormat;
        if (formatInput) formatInput.value = s.sendFormat;
        saveSettingsDebounced();
    });
}

/* ═══════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════ */

(async function init() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = {};
    }
    const s = extension_settings[EXT_NAME];
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) {
            s[key] = typeof val === 'object' && !Array.isArray(val) ? { ...val } : val;
        }
    }

    await setupUI();
    createPanel();

    // Capture-phase listener — fires before any other click handler
    document.addEventListener('click', onButtonClick, true);

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

    console.log(LOG, 'Extension loaded — multi-choice + compose mode active');
})();
