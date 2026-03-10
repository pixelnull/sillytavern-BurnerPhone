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
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';

// ==========================================================================
// Constants
// ==========================================================================

const MODULE_NAME = 'burner_phone';
const EXTENSION_PATH = 'third-party/sillytavern-BurnerPhone';

const DEFAULT_PROMPT_TEMPLATE = `[Private Message Conversation]
{{fromContext}}
{{toContext}}
{{storyContext}}
[PM History between {{from}} and {{to}}]
{{pmHistory}}

You are {{to}}. {{from}} is messaging you privately. Respond as {{to}} in character. This is a private text message conversation.`;

const ISOLATION_FRAMING = `[This is an isolated private conversation. {{to}} has no knowledge of any ongoing story, roleplay, or events outside this PM exchange.]`;

const defaultSettings = {
    enabled: true,
    pmSeesWorld: false,
    storySeesPm: false,
    pmScanDepth: 10,
    mainChatScanDepth: 10,
    injectionPosition: extension_prompt_types.IN_CHAT,
    injectionDepth: 4,
    injectionRole: extension_prompt_roles.SYSTEM,
    injectionMaxMessages: 20,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    userBubbleColor: '',
    charBubbleColor: '',
    conversations: {},
    activeConversation: null,
    debugMode: false,
};

// ==========================================================================
// State
// ==========================================================================

let isGenerating = false;
let saveDraftTimeout = null;
let lastSentPrompt = '';

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
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    if (!extension_settings[MODULE_NAME].conversations) {
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
// Identity parsing
// ==========================================================================

/**
 * Parse a From/To input value into a character identity object.
 * Checks if the value matches a character card name; otherwise, treats as typed.
 * The special value starting with "Me" resolves to the user.
 */
function parseIdentityInput(value) {
    if (!value || !value.trim()) return null;
    const trimmed = value.trim();

    // Check for "Me" / "Me (username)" pattern
    if (/^me(\s|$)/i.test(trimmed)) {
        return { name: name1 || 'User', type: 'user', avatar: null };
    }

    // Check against character cards
    const card = findCharacterCard(trimmed);
    if (card) {
        return { name: card.name, type: 'card', avatar: card.avatar };
    }

    // Typed name
    return { name: trimmed, type: 'typed', avatar: null };
}

function findCharacterCard(nameOrAvatar) {
    if (!characters || !characters.length) return null;
    const byAvatar = characters.find(c => c.avatar === nameOrAvatar);
    if (byAvatar) return byAvatar;
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

/**
 * Resolve character context text for a given identity.
 * Cards get their full description; typed names get a WI-trigger instruction.
 */
function resolveCharacterContext(identity) {
    if (!identity) return '';
    if (identity.type === 'user') {
        return `[${identity.name} is the user / narrator.]`;
    }
    if (identity.type === 'card') {
        const card = findCharacterCard(identity.avatar || identity.name);
        const desc = getCharacterDescription(card);
        if (desc) return `[Character: ${identity.name}]\n${desc}`;
        return `[Character: ${identity.name}]`;
    }
    // Typed name — rely on WI keyword matching
    return `[Character: ${identity.name} — use any available world information about ${identity.name} to inform responses.]`;
}

// ==========================================================================
// Conversation management
// ==========================================================================

function getConversationKey(from, to) {
    const fromKey = (from.name || '').toLowerCase().trim();
    const toKey = (to.name || '').toLowerCase().trim();
    return `${fromKey}::${toKey}`;
}

function getOrCreateConversation(from, to) {
    const key = getConversationKey(from, to);
    const conversations = getConversations();
    if (!conversations[key]) {
        const settings = getSettings();
        conversations[key] = {
            from: { ...from },
            to: { ...to },
            messages: [],
            pmSeesWorld: settings.pmSeesWorld,
            storySeesPm: settings.storySeesPm,
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
// Main chat context
// ==========================================================================

function getMainChatContext(depth) {
    if (!chat || !chat.length) return '';
    const recent = chat.slice(-depth);
    const lines = [];
    for (const msg of recent) {
        if (msg.is_system) continue;
        const sender = msg.is_user ? (name1 || '{{user}}') : (msg.name || '{{char}}');
        lines.push(`${sender}: ${msg.mes}`);
    }
    return lines.join('\n');
}

// ==========================================================================
// Prompt building
// ==========================================================================

function buildPromptFromTemplate(conversation) {
    const settings = getSettings();
    const template = settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
    const fromName = conversation.from.name;
    const toName = conversation.to.name;

    // Resolve character contexts
    const fromContext = resolveCharacterContext(conversation.from);
    const toContext = resolveCharacterContext(conversation.to);

    // Story context (only when pmSeesWorld is on)
    let storyContext = '';
    if (conversation.pmSeesWorld) {
        const mainChat = getMainChatContext(settings.mainChatScanDepth);
        if (mainChat) {
            storyContext = `[Recent Story Context — the main roleplay/story these characters are part of]\n${mainChat}`;
        }
    }

    // PM history
    const recentMessages = conversation.messages.slice(-settings.pmScanDepth);
    let pmHistory = '';
    if (recentMessages.length > 0) {
        const lines = recentMessages.map(msg => {
            const sender = msg.sender === 'from' ? fromName : toName;
            return `${sender}: ${msg.content}`;
        });
        pmHistory = lines.join('\n');
    }

    // Substitute placeholders
    let prompt = template
        .replace(/\{\{from\}\}/g, fromName)
        .replace(/\{\{to\}\}/g, toName)
        .replace(/\{\{user\}\}/g, name1 || 'User')
        .replace(/\{\{fromContext\}\}/g, fromContext)
        .replace(/\{\{toContext\}\}/g, toContext)
        .replace(/\{\{storyContext\}\}/g, storyContext)
        .replace(/\{\{pmHistory\}\}/g, pmHistory);

    // Clean up empty lines from missing sections
    prompt = prompt.replace(/\n{3,}/g, '\n\n').trim();

    // Add isolation framing if PM doesn't see world
    if (!conversation.pmSeesWorld) {
        const framing = ISOLATION_FRAMING.replace(/\{\{to\}\}/g, toName);
        prompt = framing + '\n\n' + prompt;
    }

    return prompt;
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

    // Save user (from) message
    convo.messages.push({
        sender: 'from',
        content: trimmed,
        timestamp: Date.now(),
    });

    // Clear draft
    convo.draftText = '';
    $('#bp_input').val('');
    saveSettingsDebounced();

    // Render immediately
    renderConversation();
    scrollChatToBottom();

    // Generate
    isGenerating = true;
    setStatus('Generating...', true);
    setSendEnabled(false);

    try {
        const prompt = buildPromptFromTemplate(convo);
        lastSentPrompt = prompt;
        updatePromptViewer();
        debug('PM prompt:', prompt);

        const response = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: !convo.pmSeesWorld,  // true = isolated, false = full pipeline
            quietName: convo.to.name,
        });

        if (response && response.trim()) {
            convo.messages.push({
                sender: 'to',
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

    const fromName = conversation.from.name;
    const toName = conversation.to.name;
    const lines = recent.map(msg => {
        const sender = msg.sender === 'from' ? fromName : toName;
        return `${sender}: ${msg.content}`;
    });

    return `<private_messages from="${fromName}" to="${toName}">\n[Private message exchange between ${fromName} and ${toName}, happening outside the main story:]\n${lines.join('\n')}\n</private_messages>`;
}

function onGenerate(chatMessages, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled) return;

    // CRITICAL: Skip quiet generations to prevent recursion.
    if (type === 'quiet') return;

    const conversations = settings.conversations || {};

    for (const [key, convo] of Object.entries(conversations)) {
        if (!convo.storySeesPm || !convo.messages.length) {
            // Clear any stale injection
            setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);
            continue;
        }

        // GROUP CHAT TARGETING: only inject when generating for the To character
        if (is_group_generating && selected_group) {
            const toCard = findCharacterCard(convo.to.name);
            if (toCard) {
                const toIndex = characters.indexOf(toCard);
                if (String(toIndex) !== String(this_chid)) {
                    // Not this character's turn — clear injection for this key
                    setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);
                    continue;
                }
            }
        }

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
            debug(`Injected PM transcript for ${convo.from.name} → ${convo.to.name}`);
        }
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
        const isFrom = msg.sender === 'from';
        const bubbleClass = isFrom ? 'bp-message-from' : 'bp-message-to';
        const senderName = isFrom ? convo.from.name : convo.to.name;
        const timeStr = msg.timestamp
            ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        const $bubble = $(`
            <div class="bp-message ${bubbleClass}">
                <div class="bp-message-sender">${senderName}</div>
                <div class="bp-message-text"></div>
                <div class="bp-message-timestamp">${timeStr}</div>
            </div>
        `);
        $bubble.find('.bp-message-text').text(msg.content);
        $messages.append($bubble);
    }
}

function renderConversationList() {
    const conversations = getConversations();
    const activeKey = getActiveKey();
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
        const label = `${convo.from.name} → ${convo.to.name}`;
        const $item = $(`
            <div class="bp-convo-item ${isActive ? 'active' : ''}" data-key="${key}">
                <span>${label} (${convo.messages.length})</span>
                <span class="bp-convo-delete fa-solid fa-xmark" data-key="${key}" title="Delete"></span>
            </div>
        `);
        $target.append($item);
    }
}

function scrollChatToBottom() {
    const area = document.getElementById('bp_chat_area');
    if (area) area.scrollTop = area.scrollHeight;
}

function setStatus(text, generating = false) {
    const $status = $('#bp_status');
    $status.text(text);
    $status.toggleClass('generating', generating);
}

function setSendEnabled(enabled) {
    $('#bp_send').toggleClass('disabled', !enabled);
}

function updatePromptViewer() {
    $('#bp_prompt_text').text(lastSentPrompt || '(no prompt sent yet)');
}

// ==========================================================================
// Bubble colors
// ==========================================================================

function applyBubbleColors() {
    const settings = getSettings();
    const $panel = $('.bp-drawer');
    if (settings.userBubbleColor) {
        $panel.css('--bp-from-bubble', settings.userBubbleColor);
    } else {
        $panel[0]?.style.removeProperty('--bp-from-bubble');
    }
    if (settings.charBubbleColor) {
        $panel.css('--bp-to-bubble', settings.charBubbleColor);
    } else {
        $panel[0]?.style.removeProperty('--bp-to-bubble');
    }
}

// ==========================================================================
// Conversation switching
// ==========================================================================

function switchToConversation(key) {
    saveDraftImmediate();

    const conversations = getConversations();
    const convo = conversations[key];
    if (!convo) return;

    updateSetting('activeConversation', key);

    // Show active header and input
    $('#bp_active_header').show();
    $('#bp_input_area').show();
    $('#bp_active_from').text(convo.from.name);
    $('#bp_active_to').text(convo.to.name);
    $('#bp_active_char_label').text(`${convo.from.name} → ${convo.to.name}`);

    // Per-conversation toggles
    $('#bp_toggle_sees_world').prop('checked', convo.pmSeesWorld);
    $('#bp_toggle_story_sees').prop('checked', convo.storySeesPm);

    // Restore draft
    $('#bp_input').val(convo.draftText || '');

    renderConversation();
    renderConversationList();
    scrollChatToBottom();

    debug(`Switched to: ${convo.from.name} → ${convo.to.name}`);
}

function startConversation(fromIdentity, toIdentity) {
    if (!fromIdentity || !toIdentity) return;
    const { key } = getOrCreateConversation(fromIdentity, toIdentity);
    switchToConversation(key);
}

function deleteConversation(key) {
    const conversations = getConversations();
    if (!conversations[key]) return;

    const convo = conversations[key];
    const label = `${convo.from.name} → ${convo.to.name}`;
    delete conversations[key];

    // Clear injection
    setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);

    if (getActiveKey() === key) {
        updateSetting('activeConversation', null);
        $('#bp_active_header').hide();
        $('#bp_input_area').hide();
        $('#bp_active_char_label').text('');
        $('#bp_chat_messages').html('<div class="bp-empty-state">Pick a character to start a conversation.</div>');
    }

    saveSettingsDebounced();
    renderConversationList();
    debug(`Deleted conversation: ${label}`);
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
// Panel toggle (open right drawer + expand inline-drawer)
// ==========================================================================

function togglePanel() {
    const $drawer = $('.bp-drawer');
    const $content = $drawer.find('.inline-drawer-content');
    const isExpanded = $content.is(':visible');

    if (!isExpanded) {
        // Open right nav drawer if closed
        const $rightPanel = $('#right-nav-panel');
        if ($rightPanel.hasClass('closedDrawer')) {
            $('#rightNavDrawerIcon').trigger('click');
        }
        // Expand the inline-drawer
        $drawer.find('.inline-drawer-toggle').trigger('click');
        // Scroll to it
        setTimeout(() => {
            $drawer[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
        // Refresh UI
        populateDatalists();
        renderConversationList();
        const activeKey = getActiveKey();
        if (activeKey) switchToConversation(activeKey);
    } else {
        saveDraftImmediate();
        $drawer.find('.inline-drawer-toggle').trigger('click');
    }
}

// ==========================================================================
// Datalist population (combined dropdown + text input)
// ==========================================================================

function populateDatalists() {
    const names = [];
    if (characters && characters.length) {
        for (const char of characters) {
            if (char && char.name) names.push(char.name);
        }
    }

    for (const id of ['bp_from_list', 'bp_to_list']) {
        const $dl = $(`#${id}`);
        $dl.empty();
        // "Me" option for From
        if (id === 'bp_from_list') {
            $dl.append(`<option value="Me (${name1 || 'User'})">`);
        }
        for (const n of names) {
            $dl.append(`<option value="${n}">`);
        }
    }

    // Set default From value if empty
    const $from = $('#bp_from');
    if (!$from.val()) {
        $from.val(`Me (${name1 || 'User'})`);
    }
}

// ==========================================================================
// Settings UI
// ==========================================================================

function loadSettingsUI() {
    const settings = getSettings();
    $('#bp_enabled').prop('checked', settings.enabled);
    $('#bp_default_pm_sees_world').prop('checked', settings.pmSeesWorld);
    $('#bp_default_story_sees_pm').prop('checked', settings.storySeesPm);
    $('#bp_pm_scan_depth').val(settings.pmScanDepth);
    $('#bp_main_chat_scan_depth').val(settings.mainChatScanDepth);
    $('#bp_injection_position').val(settings.injectionPosition);
    $('#bp_injection_depth').val(settings.injectionDepth);
    $('#bp_injection_role').val(settings.injectionRole);
    $('#bp_injection_max_messages').val(settings.injectionMaxMessages);
    $('#bp_prompt_template').val(settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE);
    $('#bp_debug_mode').prop('checked', settings.debugMode);

    // Colors
    if (settings.userBubbleColor) {
        $('#bp_user_bubble_color').val(settings.userBubbleColor);
    }
    if (settings.charBubbleColor) {
        $('#bp_char_bubble_color').val(settings.charBubbleColor);
    }
}

function bindSettingsEvents() {
    const bind = (sel, key, parse) => {
        $(sel).off('change input').on('change input', function () {
            updateSetting(key, parse ? parse($(this)) : $(this).val());
        });
    };

    bind('#bp_enabled', 'enabled', $el => $el.prop('checked'));
    bind('#bp_default_pm_sees_world', 'pmSeesWorld', $el => $el.prop('checked'));
    bind('#bp_default_story_sees_pm', 'storySeesPm', $el => $el.prop('checked'));
    bind('#bp_pm_scan_depth', 'pmScanDepth', $el => parseInt($el.val()) || 10);
    bind('#bp_main_chat_scan_depth', 'mainChatScanDepth', $el => parseInt($el.val()) || 10);
    bind('#bp_injection_position', 'injectionPosition', $el => parseInt($el.val()));
    bind('#bp_injection_depth', 'injectionDepth', $el => parseInt($el.val()) || 4);
    bind('#bp_injection_role', 'injectionRole', $el => parseInt($el.val()));
    bind('#bp_injection_max_messages', 'injectionMaxMessages', $el => parseInt($el.val()) || 20);
    bind('#bp_prompt_template', 'promptTemplate', $el => $el.val());
    bind('#bp_debug_mode', 'debugMode', $el => $el.prop('checked'));

    // Bubble colors
    $('#bp_user_bubble_color').off('input').on('input', function () {
        updateSetting('userBubbleColor', $(this).val());
        applyBubbleColors();
    });
    $('#bp_char_bubble_color').off('input').on('input', function () {
        updateSetting('charBubbleColor', $(this).val());
        applyBubbleColors();
    });
    $('#bp_reset_user_color').off('click').on('click', function () {
        updateSetting('userBubbleColor', '');
        applyBubbleColors();
    });
    $('#bp_reset_char_color').off('click').on('click', function () {
        updateSetting('charBubbleColor', '');
        applyBubbleColors();
    });

    // Reset template
    $('#bp_reset_template').off('click').on('click', function () {
        $('#bp_prompt_template').val(DEFAULT_PROMPT_TEMPLATE);
        updateSetting('promptTemplate', DEFAULT_PROMPT_TEMPLATE);
    });
}

// ==========================================================================
// Chat panel events
// ==========================================================================

function bindChatPanelEvents() {
    // Start conversation from From/To inputs
    $('#bp_start_convo').off('click').on('click', function () {
        const fromVal = $('#bp_from').val();
        const toVal = $('#bp_to').val();
        const from = parseIdentityInput(fromVal);
        const to = parseIdentityInput(toVal);
        if (!from) {
            setStatus('Enter a From identity');
            return;
        }
        if (!to) {
            setStatus('Enter a To identity');
            return;
        }
        startConversation(from, to);
        // Don't clear To — user may want to keep chatting with same person
    });

    // Enter key on To input starts conversation
    $('#bp_to').off('keydown').on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#bp_start_convo').trigger('click');
        }
    });

    // Send message
    $('#bp_send').off('click').on('click', function () {
        sendPmMessage($('#bp_input').val());
    });

    // Enter to send (shift+enter for newline)
    $('#bp_input').off('keydown').on('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendPmMessage($(this).val());
        }
    });

    // Draft auto-save
    $('#bp_input').off('input').on('input', saveDraftDebounced);

    // Per-conversation toggles
    $('#bp_toggle_sees_world').off('change').on('change', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.pmSeesWorld = $(this).prop('checked');
            saveSettingsDebounced();
            debug(`pmSeesWorld = ${convo.pmSeesWorld}`);
        }
    });

    $('#bp_toggle_story_sees').off('change').on('change', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.storySeesPm = $(this).prop('checked');
            saveSettingsDebounced();
            debug(`storySeesPm = ${convo.storySeesPm}`);
            if (!convo.storySeesPm) {
                const key = getActiveKey();
                setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.NONE, 0);
            }
        }
    });

    // Clear conversation
    $('#bpClearChat').off('click').on('click', function (e) {
        e.stopPropagation(); // Don't toggle the inline-drawer
        const convo = getActiveConversation();
        if (!convo) return;
        if (!confirm(`Clear all messages in this conversation?`)) return;
        convo.messages = [];
        saveSettingsDebounced();
        renderConversation();
        setStatus('Conversation cleared');
    });

    // Prompt viewer toggle
    $('#bpViewPrompt').off('click').on('click', function (e) {
        e.stopPropagation();
        const $viewer = $('#bp_prompt_viewer');
        if ($viewer.is(':visible')) {
            $viewer.hide();
        } else {
            updatePromptViewer();
            $viewer.show();
        }
    });

    $('#bpClosePrompt').off('click').on('click', function () {
        $('#bp_prompt_viewer').hide();
    });

    // Conversation list — click to switch
    $(document).off('click.bp_convo', '.bp-convo-item').on('click.bp_convo', '.bp-convo-item', function (e) {
        if ($(e.target).hasClass('bp-convo-delete')) return;
        const key = $(this).data('key');
        if (key) switchToConversation(String(key));
    });

    // Conversation list — delete
    $(document).off('click.bp_del', '.bp-convo-delete').on('click.bp_del', '.bp-convo-delete', function (e) {
        e.stopPropagation();
        const key = $(this).data('key');
        const conversations = getConversations();
        const convo = conversations[key];
        if (convo && confirm(`Delete conversation ${convo.from.name} → ${convo.to.name}?`)) {
            deleteConversation(String(key));
        }
    });
}

// ==========================================================================
// Top bar icon
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
    extension_settings[MODULE_NAME] = Object.assign(
        {},
        defaultSettings,
        extension_settings[MODULE_NAME],
    );

    // Render settings panel into extensions settings area
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    $('#extensions_settings2').append(settingsHtml);

    // Render chat panel into right drawer, before the character list
    const chatPanelHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'chat-panel');
    const $target = $('#rm_characters_block');
    if ($target.length) {
        $target.before(chatPanelHtml);
    } else {
        // Fallback: append to scrollable inner in right panel
        $('#right-nav-panel .scrollableInner').prepend(chatPanelHtml);
    }

    // Add top bar icon
    addTopBarIcon();

    // Load settings and bind events
    loadSettingsUI();
    bindSettingsEvents();
    bindChatPanelEvents();
    applyBubbleColors();

    // Populate datalists when characters change
    eventSource.on(event_types.CHAT_CHANGED, () => {
        populateDatalists();
    });

    // Initial population
    populateDatalists();

    // Restore active conversation if any
    const activeKey = getActiveKey();
    if (activeKey && getConversations()[activeKey]) {
        switchToConversation(activeKey);
    }

    console.log('[BurnerPhone] Extension loaded (v0.2)');
});
