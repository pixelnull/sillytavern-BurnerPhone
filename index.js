import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    generateQuietPrompt,
    characters,
    chat,
    name1,
    this_chid,
    is_send_press,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { loadMovingUIState } from '../../../power-user.js';

// ==========================================================================
// Constants
// ==========================================================================

const MODULE_NAME = 'burner_phone';
const EXTENSION_PATH = 'third-party/sillytavern-BurnerPhone';

const defaultSettings = {
    enabled: true,
    pmSeesMainChat: false,
    mainChatSeesPm: false,
    pmScanDepth: 10,
    mainChatScanDepth: 10,
    injectionPosition: extension_prompt_types.IN_CHAT,
    injectionDepth: 4,
    injectionRole: extension_prompt_roles.SYSTEM,
    injectionMaxMessages: 20,
    debugMode: false,
    conversations: {},
    activeConversation: null,
    panelOpen: false,
};

// ==========================================================================
// State
// ==========================================================================

let isGenerating = false;
let saveDraftTimeout = null;

// ==========================================================================
// Settings helpers
// ==========================================================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    return Object.assign({}, defaultSettings, extension_settings[MODULE_NAME]);
}

function updateSetting(key, value) {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

function getConversations() {
    const settings = getSettings();
    if (!settings.conversations) {
        extension_settings[MODULE_NAME].conversations = {};
    }
    return extension_settings[MODULE_NAME].conversations;
}

function debug(...args) {
    if (getSettings().debugMode) {
        console.log('[BurnerPhone]', ...args);
    }
}

// ==========================================================================
// Conversation management
// ==========================================================================

function getConversationKey(characterName, characterType, characterAvatar) {
    if (characterType === 'card' && characterAvatar) {
        return characterAvatar;
    }
    return `typed::${characterName.toLowerCase().trim()}`;
}

function getOrCreateConversation(characterName, characterType, characterAvatar) {
    const key = getConversationKey(characterName, characterType, characterAvatar);
    const conversations = getConversations();
    if (!conversations[key]) {
        const settings = getSettings();
        conversations[key] = {
            characterName,
            characterType,
            characterAvatar: characterAvatar || null,
            messages: [],
            pmSeesMainChat: settings.pmSeesMainChat,
            mainChatSeesPm: settings.mainChatSeesPm,
            draftText: '',
        };
        saveSettingsDebounced();
    }
    return { key, conversation: conversations[key] };
}

function getActiveConversation() {
    const settings = getSettings();
    if (!settings.activeConversation) return null;
    const conversations = getConversations();
    return conversations[settings.activeConversation] || null;
}

function getActiveKey() {
    return getSettings().activeConversation;
}

// ==========================================================================
// Character lookup
// ==========================================================================

function findCharacterCard(nameOrAvatar) {
    if (!characters || !characters.length) return null;

    // By avatar (exact)
    const byAvatar = characters.find(c => c.avatar === nameOrAvatar);
    if (byAvatar) return byAvatar;

    // By name (case-insensitive)
    const lower = nameOrAvatar.toLowerCase().trim();
    return characters.find(c => c.name && c.name.toLowerCase().trim() === lower) || null;
}

function getCharacterDescription(char) {
    if (!char) return '';
    const parts = [];
    if (char.description) parts.push(char.description);
    if (char.personality) parts.push(`Personality: ${char.personality}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario}`);
    return parts.join('\n\n');
}

// ==========================================================================
// Main chat context
// ==========================================================================

function getMainChatContext(depth) {
    if (!chat || !chat.length) return '';
    const recent = chat.slice(-depth);
    const lines = [];
    for (const msg of recent) {
        if (msg.is_system) continue;
        const name = msg.is_user ? (name1 || '{{user}}') : (msg.name || '{{char}}');
        lines.push(`${name}: ${msg.mes}`);
    }
    return lines.join('\n');
}

// ==========================================================================
// Prompt building
// ==========================================================================

function buildPmPrompt(conversation) {
    const settings = getSettings();
    const parts = [];
    const charName = conversation.characterName;

    // Identity and framing
    parts.push(`[Private Message Conversation with ${charName}]`);
    parts.push(`You are ${charName}. You are having a private text message conversation with {{user}}. Respond in character as ${charName}. This is a separate, private conversation — not the main roleplay.`);

    // Character context
    if (conversation.characterType === 'card' && conversation.characterAvatar) {
        const char = findCharacterCard(conversation.characterAvatar);
        const desc = getCharacterDescription(char);
        if (desc) {
            parts.push(`\n[Character Context]\n${desc}`);
        }
    } else {
        // Typed name — rely on WI keyword matching. Include name prominently.
        parts.push(`\n[You are responding as the character "${charName}". Use any available world information about ${charName} to inform your responses.]`);
    }

    // Main chat context (if toggle is on)
    if (conversation.pmSeesMainChat) {
        const mainContext = getMainChatContext(settings.mainChatScanDepth);
        if (mainContext) {
            parts.push(`\n[Recent Story Context — the main roleplay these characters are part of]\n${mainContext}`);
        }
    }

    // PM conversation history
    const recentMessages = conversation.messages.slice(-settings.pmScanDepth);
    if (recentMessages.length > 0) {
        parts.push('\n[Private Message History]');
        for (const msg of recentMessages) {
            const name = msg.role === 'user' ? '{{user}}' : charName;
            parts.push(`${name}: ${msg.content}`);
        }
    }

    // Final instruction
    parts.push(`\nRespond as ${charName} in the private message conversation. Keep responses conversational and in-character.`);

    return parts.join('\n');
}

// ==========================================================================
// PM generation
// ==========================================================================

async function sendPmMessage(text) {
    if (!text || !text.trim()) return;
    if (isGenerating) return;

    const convo = getActiveConversation();
    if (!convo) return;

    const trimmed = text.trim();

    // Save user message
    convo.messages.push({
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
    });

    // Clear draft
    convo.draftText = '';
    $('#bp_input').val('');
    saveSettingsDebounced();

    // Render the user message immediately
    renderConversation();
    scrollChatToBottom();

    // Generate response
    isGenerating = true;
    setStatus('Generating...', true);
    setSendEnabled(false);

    try {
        const prompt = buildPmPrompt(convo);
        debug('PM prompt:', prompt);

        const response = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: false,
            quietName: convo.characterName,
        });

        if (response && response.trim()) {
            convo.messages.push({
                role: 'character',
                content: response.trim(),
                timestamp: Date.now(),
            });
            saveSettingsDebounced();
            renderConversation();
            scrollChatToBottom();
            setStatus('');
        } else {
            setStatus('Empty response received');
        }
    } catch (err) {
        console.error('[BurnerPhone] Generation error:', err);
        setStatus(`Error: ${err.message || 'Generation failed'}`);
    } finally {
        isGenerating = false;
        setSendEnabled(true);
    }
}

// ==========================================================================
// Main chat injection (generate_interceptor)
// ==========================================================================

function formatPmForInjection(conversation, maxMessages) {
    const recent = conversation.messages.slice(-maxMessages);
    if (recent.length === 0) return '';

    const charName = conversation.characterName;
    const lines = recent.map(msg => {
        const name = msg.role === 'user' ? '{{user}}' : charName;
        return `${name}: ${msg.content}`;
    });

    return `<private_messages character="${charName}">\n[Private message exchange between {{user}} and ${charName}, happening outside the main story:]\n${lines.join('\n')}\n</private_messages>`;
}

function onGenerate(chatMessages, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled) return;

    // CRITICAL: Skip quiet generations to prevent recursion.
    // When we call generateQuietPrompt() for PM responses, this interceptor
    // would fire again — we must not inject PM context into PM generations.
    if (type === 'quiet') return;

    const conversations = settings.conversations || {};
    let injected = false;

    for (const [key, convo] of Object.entries(conversations)) {
        if (!convo.mainChatSeesPm || convo.messages.length === 0) continue;

        const formatted = formatPmForInjection(convo, settings.injectionMaxMessages);
        if (formatted) {
            setExtensionPrompt(
                `burner_pm_${key}`,
                formatted,
                settings.injectionPosition,
                settings.injectionDepth,
                false,
                settings.injectionRole,
            );
            injected = true;
            debug(`Injected PM transcript for ${convo.characterName} (${convo.messages.length} messages)`);
        }
    }

    // Clear injection tags for conversations that no longer have mainChatSeesPm
    for (const [key, convo] of Object.entries(conversations)) {
        if (convo.mainChatSeesPm) continue;
        setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);
    }

    if (injected) {
        debug('PM transcripts injected into main generation');
    }
}

// Register on globalThis for ST to find via manifest
globalThis.burnerPhone_onGenerate = onGenerate;

// ==========================================================================
// UI rendering
// ==========================================================================

function renderConversation() {
    const convo = getActiveConversation();
    const $messages = $('#bp_chat_messages');
    $messages.empty();

    if (!convo || convo.messages.length === 0) {
        $messages.html('<div class="bp-empty-state">No messages yet. Say something!</div>');
        return;
    }

    for (const msg of convo.messages) {
        const isUser = msg.role === 'user';
        const bubbleClass = isUser ? 'bp-message-user' : 'bp-message-character';
        const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

        const $bubble = $(`
            <div class="bp-message ${bubbleClass}">
                <div class="bp-message-text"></div>
                <div class="bp-message-timestamp">${timeStr}</div>
            </div>
        `);
        // Set text content safely (no HTML injection)
        $bubble.find('.bp-message-text').text(msg.content);
        $messages.append($bubble);
    }
}

function renderConversationList() {
    const conversations = getConversations();
    const activeKey = getActiveKey();
    const $list = $('#bp_convo_list');

    if (!$list.length) {
        // Create conversation list if it doesn't exist
        const $header = $('#bp_active_header');
        $('<div id="bp_convo_list" class="bp-convo-list"></div>').insertBefore($header);
    }

    const $target = $('#bp_convo_list');
    $target.empty();

    const keys = Object.keys(conversations);
    if (keys.length === 0) {
        $target.hide();
        return;
    }

    $target.show();
    for (const key of keys) {
        const convo = conversations[key];
        const isActive = key === activeKey;
        const $item = $(`
            <div class="bp-convo-item ${isActive ? 'active' : ''}" data-key="${key}">
                <span>${convo.characterName} (${convo.messages.length})</span>
                <span class="bp-convo-delete fa-solid fa-xmark" data-key="${key}" title="Delete conversation"></span>
            </div>
        `);
        $target.append($item);
    }
}

function scrollChatToBottom() {
    const $area = $('#bp_chat_area');
    $area.scrollTop($area[0]?.scrollHeight || 0);
}

function setStatus(text, generating = false) {
    const $status = $('#bp_status');
    $status.text(text);
    $status.toggleClass('generating', generating);
}

function setSendEnabled(enabled) {
    $('#bp_send').toggleClass('disabled', !enabled);
}

// ==========================================================================
// Conversation switching
// ==========================================================================

function switchToConversation(key) {
    // Save current draft
    saveDraftImmediate();

    const conversations = getConversations();
    const convo = conversations[key];
    if (!convo) return;

    updateSetting('activeConversation', key);

    // Show active header and input
    $('#bp_active_header').show();
    $('#bp_input_area').show();
    $('#bp_active_name').text(convo.characterName);

    // Set per-conversation toggles
    $('#bp_toggle_sees_chat').prop('checked', convo.pmSeesMainChat);
    $('#bp_toggle_chat_sees').prop('checked', convo.mainChatSeesPm);

    // Restore draft
    $('#bp_input').val(convo.draftText || '');

    // Render messages
    renderConversation();
    renderConversationList();
    scrollChatToBottom();

    // Hide character selector when in conversation
    // (user can still access it to start a new convo)

    debug(`Switched to conversation: ${convo.characterName} (${key})`);
}

function startConversation(characterName, characterType, characterAvatar) {
    if (!characterName || !characterName.trim()) return;

    const { key } = getOrCreateConversation(characterName.trim(), characterType, characterAvatar);
    switchToConversation(key);
}

function deleteConversation(key) {
    const conversations = getConversations();
    if (!conversations[key]) return;

    const name = conversations[key].characterName;
    delete conversations[key];

    // Clear injection for this conversation
    setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);

    // If we deleted the active one, clear UI
    if (getActiveKey() === key) {
        updateSetting('activeConversation', null);
        $('#bp_active_header').hide();
        $('#bp_input_area').hide();
        $('#bp_chat_messages').html('<div class="bp-empty-state">Select a character or type a name to start a conversation.</div>');
    }

    saveSettingsDebounced();
    renderConversationList();
    debug(`Deleted conversation with ${name}`);
}

// ==========================================================================
// Draft saving
// ==========================================================================

function saveDraftImmediate() {
    const convo = getActiveConversation();
    if (!convo) return;
    convo.draftText = $('#bp_input').val() || '';
    saveSettingsDebounced();
}

function saveDraftDebounced() {
    if (saveDraftTimeout) clearTimeout(saveDraftTimeout);
    saveDraftTimeout = setTimeout(saveDraftImmediate, 500);
}

// ==========================================================================
// Panel open/close
// ==========================================================================

function openPanel() {
    $('#bpChatPanel').show();
    updateSetting('panelOpen', true);
    populateCharacterDropdown();
    renderConversationList();

    const activeKey = getActiveKey();
    if (activeKey) {
        switchToConversation(activeKey);
    }
}

function closePanel() {
    saveDraftImmediate();
    $('#bpChatPanel').hide();
    updateSetting('panelOpen', false);
}

function togglePanel() {
    if ($('#bpChatPanel').is(':visible')) {
        closePanel();
    } else {
        openPanel();
    }
}

// ==========================================================================
// Character dropdown
// ==========================================================================

function populateCharacterDropdown() {
    const $select = $('#bp_char_select');
    $select.empty().append('<option value="">-- Character Card --</option>');

    if (!characters || !characters.length) return;

    for (let i = 0; i < characters.length; i++) {
        const char = characters[i];
        if (!char || !char.name) continue;
        const $option = $('<option></option>').val(char.avatar || '').text(char.name);
        $select.append($option);
    }
}

// ==========================================================================
// Settings UI binding
// ==========================================================================

function loadSettingsUI() {
    const settings = getSettings();
    $('#bp_enabled').prop('checked', settings.enabled);
    $('#bp_default_pm_sees_chat').prop('checked', settings.pmSeesMainChat);
    $('#bp_default_chat_sees_pm').prop('checked', settings.mainChatSeesPm);
    $('#bp_pm_scan_depth').val(settings.pmScanDepth);
    $('#bp_main_chat_scan_depth').val(settings.mainChatScanDepth);
    $('#bp_injection_position').val(settings.injectionPosition);
    $('#bp_injection_depth').val(settings.injectionDepth);
    $('#bp_injection_role').val(settings.injectionRole);
    $('#bp_injection_max_messages').val(settings.injectionMaxMessages);
    $('#bp_debug_mode').prop('checked', settings.debugMode);
}

function bindSettingsEvents() {
    $('#bp_enabled').off('change').on('change', function () {
        updateSetting('enabled', $(this).prop('checked'));
    });
    $('#bp_default_pm_sees_chat').off('change').on('change', function () {
        updateSetting('pmSeesMainChat', $(this).prop('checked'));
    });
    $('#bp_default_chat_sees_pm').off('change').on('change', function () {
        updateSetting('mainChatSeesPm', $(this).prop('checked'));
    });
    $('#bp_pm_scan_depth').off('change input').on('change input', function () {
        updateSetting('pmScanDepth', parseInt($(this).val()) || 10);
    });
    $('#bp_main_chat_scan_depth').off('change input').on('change input', function () {
        updateSetting('mainChatScanDepth', parseInt($(this).val()) || 10);
    });
    $('#bp_injection_position').off('change').on('change', function () {
        updateSetting('injectionPosition', parseInt($(this).val()));
    });
    $('#bp_injection_depth').off('change input').on('change input', function () {
        updateSetting('injectionDepth', parseInt($(this).val()) || 4);
    });
    $('#bp_injection_role').off('change').on('change', function () {
        updateSetting('injectionRole', parseInt($(this).val()));
    });
    $('#bp_injection_max_messages').off('change input').on('change input', function () {
        updateSetting('injectionMaxMessages', parseInt($(this).val()) || 20);
    });
    $('#bp_debug_mode').off('change').on('change', function () {
        updateSetting('debugMode', $(this).prop('checked'));
    });
}

// ==========================================================================
// Chat panel event binding
// ==========================================================================

function bindChatPanelEvents() {
    // Close panel
    $('#bpPanelClose').off('click').on('click', closePanel);

    // Character card dropdown selection
    $('#bp_char_select').off('change').on('change', function () {
        const avatar = $(this).val();
        if (!avatar) return;
        const char = findCharacterCard(avatar);
        if (char) {
            startConversation(char.name, 'card', char.avatar);
            $(this).val(''); // Reset dropdown
        }
    });

    // Typed name — go button
    $('#bp_char_go').off('click').on('click', function () {
        const name = $('#bp_char_typed').val();
        if (name && name.trim()) {
            // Check if it matches a character card first
            const card = findCharacterCard(name.trim());
            if (card) {
                startConversation(card.name, 'card', card.avatar);
            } else {
                startConversation(name.trim(), 'typed', null);
            }
            $('#bp_char_typed').val('');
        }
    });

    // Typed name — enter key
    $('#bp_char_typed').off('keydown').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#bp_char_go').trigger('click');
        }
    });

    // Send message — button
    $('#bp_send').off('click').on('click', function () {
        const text = $('#bp_input').val();
        sendPmMessage(text);
    });

    // Send message — enter key (shift+enter for newline)
    $('#bp_input').off('keydown').on('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = $(this).val();
            sendPmMessage(text);
        }
    });

    // Draft auto-save on input
    $('#bp_input').off('input').on('input', saveDraftDebounced);

    // Per-conversation toggles
    $('#bp_toggle_sees_chat').off('change').on('change', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.pmSeesMainChat = $(this).prop('checked');
            saveSettingsDebounced();
            debug(`${convo.characterName}: pmSeesMainChat = ${convo.pmSeesMainChat}`);
        }
    });

    $('#bp_toggle_chat_sees').off('change').on('change', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.mainChatSeesPm = $(this).prop('checked');
            saveSettingsDebounced();
            debug(`${convo.characterName}: mainChatSeesPm = ${convo.mainChatSeesPm}`);

            // If turning off, clear the injection immediately
            if (!convo.mainChatSeesPm) {
                const key = getActiveKey();
                setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);
            }
        }
    });

    // Clear conversation
    $('#bpClearChat').off('click').on('click', function () {
        const convo = getActiveConversation();
        if (!convo) return;
        if (!confirm(`Clear all messages with ${convo.characterName}?`)) return;
        convo.messages = [];
        saveSettingsDebounced();
        renderConversation();
        setStatus('Conversation cleared');
    });

    // Conversation list — click to switch
    $(document).off('click', '.bp-convo-item').on('click', '.bp-convo-item', function (e) {
        if ($(e.target).hasClass('bp-convo-delete')) return;
        const key = $(this).data('key');
        if (key) switchToConversation(key);
    });

    // Conversation list — delete
    $(document).off('click', '.bp-convo-delete').on('click', '.bp-convo-delete', function (e) {
        e.stopPropagation();
        const key = $(this).data('key');
        const conversations = getConversations();
        const convo = conversations[key];
        if (convo && confirm(`Delete conversation with ${convo.characterName}?`)) {
            deleteConversation(key);
        }
    });
}

// ==========================================================================
// Top bar button
// ==========================================================================

function addTopBarIcon() {
    if ($('#bp-toggle-button').length) return;

    const $button = $(`
        <div id="bp-toggle-button" class="drawer">
            <div class="drawer-toggle">
                <div id="bp-toggle-icon" class="drawer-icon fa-solid fa-mobile-screen-button fa-fw closedIcon"
                     title="BurnerPhone"></div>
            </div>
        </div>
    `);

    $('#top-settings-holder').append($button);
    $('#bp-toggle-icon').off('click').on('click', togglePanel);
}

// ==========================================================================
// Initialization
// ==========================================================================

jQuery(async function () {
    // Initialize settings
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings, conversations: {} };
    }
    // Merge with defaults for any new fields
    extension_settings[MODULE_NAME] = Object.assign(
        {},
        defaultSettings,
        extension_settings[MODULE_NAME],
    );

    // Render settings panel
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    $('#extensions_settings2').append(settingsHtml);

    // Render chat panel into movingDivs
    const chatPanelHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'chat-panel');
    $('#movingDivs').append(chatPanelHtml);

    // Make panel draggable
    dragElement($('#bpChatPanel'));
    loadMovingUIState();

    // Add top bar icon
    addTopBarIcon();

    // Load settings UI and bind events
    loadSettingsUI();
    bindSettingsEvents();
    bindChatPanelEvents();

    // Listen for character list changes
    eventSource.on(event_types.CHAT_CHANGED, () => {
        populateCharacterDropdown();
    });

    // Initial character dropdown population
    populateCharacterDropdown();

    // Restore panel state
    if (getSettings().panelOpen) {
        openPanel();
    }

    console.log('[BurnerPhone] Extension loaded');
});
