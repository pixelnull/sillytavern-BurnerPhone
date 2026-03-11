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
    doNavbarIconClick,
    messageFormatting,
    user_avatar,
    default_avatar,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';

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
let lastFullContext = null;

// ==========================================================================
// Helpers
// ==========================================================================

function stripNamePrefix(response, name) {
    if (!response || !name) return response;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return response.replace(new RegExp(`^${escaped}\\s*:\\s*`, 'i'), '');
}

function getUserAvatarUrl() {
    return user_avatar ? `/User Avatars/${user_avatar}` : '/img/user-default.png';
}

function getCharAvatarUrl(charName) {
    const char = characters.find(c => c.name === charName);
    return char?.avatar ? `/characters/${char.avatar}` : default_avatar;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatFullContext(ctx) {
    if (!ctx) return '(no context captured yet — send a message first)';
    if (typeof ctx === 'string') return ctx;
    if (Array.isArray(ctx)) {
        return ctx.map(msg => {
            const role = (msg.role || 'unknown').toUpperCase();
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
            return `--- ${role} ---\n${content}`;
        }).join('\n\n');
    }
    return JSON.stringify(ctx, null, 2);
}

function showPromptPopup() {
    const contextText = formatFullContext(lastFullContext);
    let html = '<div style="text-align:left;">';
    html += '<h3>BurnerPhone Prompt</h3>';
    html += '<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">';
    html += '<div class="menu_button" id="bp_copy_prompt">Copy</div></div>';
    html += `<pre class="bp-prompt-text">${escapeHtml(lastSentPrompt || '(no prompt sent yet)')}</pre>`;
    html += '<h3>Full Context Sent to API</h3>';
    html += '<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">';
    html += '<div class="menu_button" id="bp_copy_context">Copy</div></div>';
    html += `<pre class="bp-prompt-text">${escapeHtml(contextText)}</pre>`;
    html += '</div>';

    const popup = new Popup(html, POPUP_TYPE.TEXT, null, {
        large: true,
        allowVerticalScrolling: true,
    });
    popup.show();

    $('#bp_copy_prompt').on('click', () => {
        navigator.clipboard.writeText(lastSentPrompt || '');
        toastr.info('Copied BurnerPhone prompt');
    });
    $('#bp_copy_context').on('click', () => {
        navigator.clipboard.writeText(contextText);
        toastr.info('Copied full context');
    });
}

function getBpIndex(el) {
    return parseInt($(el).closest('.bp-mes').attr('data-bp-idx'));
}

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
    const convo = conversations[settings.activeConversation] || null;
    if (convo) migrateConversation(convo, settings.activeConversation);
    return convo;
}

/**
 * Ensure a conversation object has from/to identity objects.
 * Handles data from older versions that may have stored them differently.
 */
function migrateConversation(convo, key) {
    if (convo.from?.name && convo.to?.name) return; // Already valid
    // Reconstruct from the key (format: "fromname::toname")
    const parts = key.split('::');
    if (!convo.from || !convo.from.name) {
        convo.from = { name: parts[0] || 'Unknown', type: 'typed', avatar: null };
    }
    if (!convo.to || !convo.to.name) {
        convo.to = { name: parts[1] || 'Unknown', type: 'typed', avatar: null };
    }
    console.log('[BurnerPhone] Migrated conversation data for key:', key);
    saveSettingsDebounced();
}

function getActiveKey() {
    return getSettings().activeConversation;
}

// ==========================================================================
// Main chat context
// ==========================================================================

function getMainChatContext(depth) {
    if (!chat || !chat.length || !depth || depth <= 0) return '';
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
    const recentMessages = settings.pmScanDepth > 0 ? conversation.messages.slice(-settings.pmScanDepth) : [];
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
        .replace(/\{\{from\}\}/g, () => fromName)
        .replace(/\{\{to\}\}/g, () => toName)
        .replace(/\{\{user\}\}/g, () => name1 || 'User')
        .replace(/\{\{fromContext\}\}/g, () => fromContext)
        .replace(/\{\{toContext\}\}/g, () => toContext)
        .replace(/\{\{storyContext\}\}/g, () => storyContext)
        .replace(/\{\{pmHistory\}\}/g, () => pmHistory);

    // Clean up empty lines from missing sections
    prompt = prompt.replace(/\n{3,}/g, '\n\n').trim();

    // Add isolation framing if PM doesn't see world
    if (!conversation.pmSeesWorld) {
        const framing = ISOLATION_FRAMING.replace(/\{\{to\}\}/g, () => toName);
        prompt = framing + '\n\n' + prompt;
    }

    return prompt;
}

// ==========================================================================
// PM generation
// ==========================================================================

async function sendPmMessage(text) {
    console.log('[BurnerPhone] sendPmMessage called, text:', text ? text.substring(0, 50) : '(empty)');
    if (!getSettings().enabled) {
        setStatus('BurnerPhone is disabled');
        return;
    }
    if (!text || !text.trim()) {
        setStatus('Type a message first');
        return;
    }
    if (isGenerating) {
        setStatus('Already generating...');
        return;
    }

    const convo = getActiveConversation();
    if (!convo) {
        setStatus('No active conversation — start one first');
        return;
    }
    console.log('[BurnerPhone] Active convo:', JSON.stringify({ from: convo.from, to: convo.to, msgs: convo.messages?.length }));

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

    // Capture full context for debugging
    const contextHandler = (data) => {
        lastFullContext = data.prompt || data;
    };

    // Wrap everything in try/catch — errors before the old try block were silently dying
    try {
        renderConversation();
        scrollChatToBottom();

        isGenerating = true;
        setStatus('Generating...', true);
        setSendEnabled(false);

        const prompt = buildPromptFromTemplate(convo);
        lastSentPrompt = prompt;
        debug('Built prompt, length:', prompt.length);

        eventSource.once(event_types.GENERATE_AFTER_DATA, contextHandler);

        const response = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: !convo.pmSeesWorld,
            quietName: convo.to.name,
        });

        debug('Got response, length:', response ? response.length : 'null/empty');

        if (response && response.trim()) {
            const cleaned = stripNamePrefix(response.trim(), convo.to.name);
            convo.messages.push({
                sender: 'to',
                content: cleaned,
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
        console.error('[BurnerPhone] GENERATION ERROR:', err);
        console.error('[BurnerPhone] Stack:', err?.stack);
        setStatus(`Error: ${err?.message || 'Generation failed'}`);
    } finally {
        isGenerating = false;
        setSendEnabled(true);
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, contextHandler);
        debug('Generation complete');
    }
}

// ==========================================================================
// Main chat injection (generate_interceptor)
// ==========================================================================

function formatPmForInjection(conversation, maxMessages) {
    if (!conversation.from || !conversation.to) return '';
    if (!maxMessages || maxMessages <= 0) return '';
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
        // Ensure conversation has valid identity objects
        migrateConversation(convo, key);
        if (!convo.from || !convo.to) {
            setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
            continue;
        }

        if (!convo.storySeesPm || !convo.messages.length) {
            // Clear any stale injection
            setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
            continue;
        }

        // GROUP CHAT TARGETING: only inject when generating for the To character
        if (is_group_generating && selected_group) {
            const toCard = findCharacterCard(convo.to.name);
            if (toCard) {
                const toIndex = characters.indexOf(toCard);
                if (String(toIndex) !== String(this_chid)) {
                    // Not this character's turn — clear injection for this key
                    setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
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

function getDisplayContent(msg) {
    return (msg.swipes && msg.swipes.length > 0) ? msg.swipes[msg.swipe_id || 0] : msg.content;
}

function renderConversation() {
    const convo = getActiveConversation();
    const $messages = $('#bp_chat_messages');
    $messages.empty();

    if (!convo || convo.messages.length === 0) {
        $messages.html('<div class="bp-empty-state">No messages yet. Say something!</div>');
        return;
    }

    convo.messages.forEach((msg, index) => {
        const isFrom = msg.sender === 'from';
        const senderName = isFrom ? convo.from.name : convo.to.name;
        const displayContent = getDisplayContent(msg);
        const timeStr = msg.timestamp
            ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        // Clone ST's message template
        const $mes = $('#message_template .mes').clone();
        $mes.addClass('bp-mes');
        $mes.attr('data-bp-idx', index);
        $mes.removeAttr('mesid');
        $mes.attr('is_user', isFrom);
        $mes.attr('is_system', false);
        $mes.attr('ch_name', senderName);

        // Name + timestamp
        $mes.find('.name_text').text(senderName);
        $mes.find('.timestamp').text(timeStr);

        // Avatar
        const avatarUrl = isFrom ? getUserAvatarUrl() : getCharAvatarUrl(convo.to.name);
        $mes.find('.avatar img').attr('src', avatarUrl);

        // Strip leftover name prefix from old messages on display
        const cleanContent = !isFrom ? stripNamePrefix(displayContent, convo.to.name) : displayContent;

        // Message text — rich formatting via ST's messageFormatting
        const formattedHtml = messageFormatting(cleanContent, senderName, false, isFrom, -1);
        $mes.find('.mes_text').html(formattedHtml);

        // Hide irrelevant ST buttons
        $mes.find('.mes_translate, .sd_message_gen, .mes_create_bookmark, .mes_create_branch, .mes_embed, .mes_hide, .mes_unhide, .mes_media_gallery, .mes_media_list, .mes_bookmark').hide();
        $mes.find('.mesIDDisplay, .mes_timer, .tokenCounterDisplay, .mes_ghost, .mes_bias, .for_checkbox, .del_checkbox, .mes_reasoning_details, .mes_media_wrapper, .mes_file_wrapper').hide();

        // Always show prompt button (popup handles empty state)
        $mes.find('.mes_prompt').show();

        // Add regenerate button for last AI message
        if (!isFrom && index === convo.messages.length - 1) {
            $mes.find('.extraMesButtons').append(
                '<div title="Regenerate" class="mes_button bp-regenerate fa-solid fa-arrows-rotate"></div>',
            );
        }

        // Swipes — use ST template's built-in elements
        if (!isFrom && msg.swipes && msg.swipes.length > 1) {
            const swipeId = msg.swipe_id || 0;
            $mes.find('.swipe_left').show().toggleClass('disabled', swipeId === 0);
            $mes.find('.swipe_right').show().toggleClass('disabled', swipeId === msg.swipes.length - 1);
            $mes.find('.swipes-counter').text(`${swipeId + 1}/${msg.swipes.length}`).show();
        } else {
            $mes.find('.swipe_left, .swipe_right, .swipes-counter').hide();
        }

        $messages.append($mes);
    });
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
        migrateConversation(convo, key);
        const isActive = key === activeKey;
        const label = `${convo.from.name} → ${convo.to.name}`;
        const $item = $('<div class="bp-convo-item"></div>')
            .toggleClass('active', isActive)
            .attr('data-key', key);
        $item.append($('<span></span>').text(`${label} (${convo.messages.length})`));
        $item.append($('<span class="bp-convo-delete fa-solid fa-xmark"></span>')
            .attr('data-key', key).attr('title', 'Delete'));
        $target.append($item);
    }
}

// ==========================================================================
// Message actions
// ==========================================================================

function handleCopy(msg) {
    const text = getDisplayContent(msg);
    navigator.clipboard.writeText(text).then(() => {
        setStatus('Copied to clipboard');
        setTimeout(() => setStatus(''), 2000);
    }).catch(() => {
        setStatus('Failed to copy');
    });
}

function handleEditStart(index, msg) {
    const $mes = $(`.bp-mes[data-bp-idx="${index}"]`);
    const $textEl = $mes.find('.mes_text');
    const currentText = getDisplayContent(msg);

    // Replace formatted text with textarea
    $textEl.html(`<textarea class="bp-edit-textarea text_pole">${escapeHtml(currentText)}</textarea>`);

    // Show ST's edit buttons, hide normal buttons
    $mes.find('.mes_buttons').hide();
    $mes.find('.mes_edit_buttons').show();
    $mes.find('.bp-edit-textarea').focus();
}

function handleEditSave(index) {
    const convo = getActiveConversation();
    if (!convo || index < 0 || index >= convo.messages.length) return;
    const msg = convo.messages[index];

    const $mes = $(`.bp-mes[data-bp-idx="${index}"]`);
    const newText = $mes.find('.bp-edit-textarea').val();

    if (newText !== undefined && newText.trim()) {
        msg.content = newText.trim();
        if (msg.swipes && msg.swipes.length > 0) {
            msg.swipes[msg.swipe_id || 0] = msg.content;
        }
        saveSettingsDebounced();
    }

    renderConversation();
}

function handleEditCancel() {
    renderConversation();
}

function handleDelete(convo, index) {
    if (!confirm('Delete this message?')) return;
    convo.messages.splice(index, 1);
    saveSettingsDebounced();
    renderConversation();
}

async function handleRegenerate(convo, index) {
    if (isGenerating) {
        setStatus('Already generating...');
        return;
    }

    const msg = convo.messages[index];
    if (msg.sender !== 'to') return;

    // Initialize swipes if not present
    if (!msg.swipes) {
        msg.swipes = [msg.content];
        msg.swipe_id = 0;
    }

    isGenerating = true;
    setStatus('Regenerating...', true);
    setSendEnabled(false);

    // Capture full context
    const contextHandler = (data) => {
        lastFullContext = data.prompt || data;
    };
    eventSource.once(event_types.GENERATE_AFTER_DATA, contextHandler);

    try {
        // Build prompt without the message being regenerated
        const originalMessages = convo.messages;
        convo.messages = originalMessages.slice(0, index);
        const prompt = buildPromptFromTemplate(convo);
        convo.messages = originalMessages;

        lastSentPrompt = prompt;

        const response = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: !convo.pmSeesWorld,
            quietName: convo.to.name,
        });

        if (response && response.trim()) {
            const cleaned = stripNamePrefix(response.trim(), convo.to.name);
            msg.swipes.push(cleaned);
            msg.swipe_id = msg.swipes.length - 1;
            msg.content = cleaned;
            msg.timestamp = Date.now();
            saveSettingsDebounced();
            renderConversation();
            scrollChatToBottom();
            setStatus('');
        } else {
            setStatus('Empty response received');
        }
    } catch (err) {
        console.error('[BurnerPhone] REGENERATE ERROR:', err);
        setStatus(`Error: ${err?.message || 'Regeneration failed'}`);
    } finally {
        isGenerating = false;
        setSendEnabled(true);
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, contextHandler);
    }
}

async function handleTts(convo, msg) {
    const text = getDisplayContent(msg);
    const voiceName = msg.sender === 'to' ? convo.to.name : convo.from.name;
    try {
        await executeSlashCommandsWithOptions(`/narrate voice="${voiceName}" ${text}`);
    } catch (err) {
        console.error('[BurnerPhone] TTS error:', err);
        setStatus('TTS failed — is the TTS extension enabled?');
    }
}

function handleSwipe(convo, index, direction) {
    const msg = convo.messages[index];
    if (!msg.swipes || msg.swipes.length <= 1) return;

    const newId = (msg.swipe_id || 0) + direction;
    if (newId < 0 || newId >= msg.swipes.length) return;

    msg.swipe_id = newId;
    msg.content = msg.swipes[newId];
    saveSettingsDebounced();
    renderConversation();
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

// ==========================================================================
// Bubble colors
// ==========================================================================

function applyBubbleColors() {
    const settings = getSettings();
    const panel = document.getElementById('burnerphone-panel');
    if (!panel) return;
    if (settings.userBubbleColor) {
        panel.style.setProperty('--bp-from-bubble', settings.userBubbleColor);
    } else {
        panel.style.removeProperty('--bp-from-bubble');
    }
    if (settings.charBubbleColor) {
        panel.style.setProperty('--bp-to-bubble', settings.charBubbleColor);
    } else {
        panel.style.removeProperty('--bp-to-bubble');
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
    setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);

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
// Panel open hook — refresh UI when drawer is opened
// ==========================================================================

function onDrawerOpened() {
    populateDatalists();
    renderConversationList();
    const activeKey = getActiveKey();
    if (activeKey) switchToConversation(activeKey);
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
            $dl.append($('<option>').attr('value', `Me (${name1 || 'User'})`));
        }
        for (const n of names) {
            $dl.append($('<option>').attr('value', n));
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
        $('#bp_user_bubble_color').val('#4a4a6a');
        applyBubbleColors();
    });
    $('#bp_reset_char_color').off('click').on('click', function () {
        updateSetting('charBubbleColor', '');
        $('#bp_char_bubble_color').val('#3a5a3a');
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
    // Start conversation from From/To inputs — delegated
    $(document).off('click.bp_start', '#bp_start_convo').on('click.bp_start', '#bp_start_convo', function () {
        console.log('[BurnerPhone] Start conversation clicked');
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

    // Enter key on To input starts conversation — delegated
    $(document).off('keydown.bp_to', '#bp_to').on('keydown.bp_to', '#bp_to', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#bp_start_convo').trigger('click');
        }
    });

    // Send message (use delegation on the drawer panel for reliability)
    $(document).off('click.bp_send', '#bp_send').on('click.bp_send', '#bp_send', function () {
        console.log('[BurnerPhone] Send button clicked');
        sendPmMessage($('#bp_input').val());
    });

    // Enter to send (shift+enter for newline) — delegated
    $(document).off('keydown.bp_input', '#bp_input').on('keydown.bp_input', '#bp_input', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            console.log('[BurnerPhone] Enter pressed in input');
            e.preventDefault();
            sendPmMessage($(this).val());
        }
    });

    // Draft auto-save — delegated
    $(document).off('input.bp_draft', '#bp_input').on('input.bp_draft', '#bp_input', saveDraftDebounced);

    // Per-conversation toggles — delegated
    $(document).off('change.bp_world', '#bp_toggle_sees_world').on('change.bp_world', '#bp_toggle_sees_world', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.pmSeesWorld = $(this).prop('checked');
            saveSettingsDebounced();
            debug(`pmSeesWorld = ${convo.pmSeesWorld}`);
        }
    });

    $(document).off('change.bp_story', '#bp_toggle_story_sees').on('change.bp_story', '#bp_toggle_story_sees', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.storySeesPm = $(this).prop('checked');
            saveSettingsDebounced();
            debug(`storySeesPm = ${convo.storySeesPm}`);
            if (!convo.storySeesPm) {
                const key = getActiveKey();
                setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
            }
        }
    });

    // Clear conversation — delegated
    $(document).off('click.bp_clear', '#bpClearChat').on('click.bp_clear', '#bpClearChat', function () {
        const convo = getActiveConversation();
        if (!convo) return;
        if (!confirm(`Clear all messages in this conversation?`)) return;
        convo.messages = [];
        saveSettingsDebounced();
        renderConversation();
        setStatus('Conversation cleared');
    });

    // Prompt viewer — open ST Popup
    $(document).off('click.bp_viewprompt', '#bpViewPrompt').on('click.bp_viewprompt', '#bpViewPrompt', function () {
        showPromptPopup();
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

    // ---- ST-template message handlers (scoped to BP panel, stopPropagation) ----
    const $panel = $('#burnerphone-panel');

    // Catch-all: prevent any ST global handlers from firing on BP messages
    $panel.on('click', '.bp-mes .mes_button', function (e) { e.stopPropagation(); });
    $panel.on('click', '.bp-mes .swipe_left, .bp-mes .swipe_right', function (e) { e.stopPropagation(); });

    // Copy
    $panel.on('pointerup', '.bp-mes .mes_copy', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleCopy(convo.messages[idx]);
    });

    // Edit
    $panel.on('click', '.bp-mes .mes_edit', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleEditStart(idx, convo.messages[idx]);
    });

    // Edit confirm (ST's built-in edit done button)
    $panel.on('click', '.bp-mes .mes_edit_done', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        if (!isNaN(idx)) handleEditSave(idx);
    });

    // Edit cancel
    $panel.on('click', '.bp-mes .mes_edit_cancel', function (e) {
        e.stopPropagation();
        handleEditCancel();
    });

    // Delete (in edit mode)
    $panel.on('click', '.bp-mes .mes_edit_delete', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleDelete(convo, idx);
    });

    // Narrate / TTS
    $panel.on('click', '.bp-mes .mes_narrate', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleTts(convo, convo.messages[idx]);
    });

    // Prompt viewer
    $panel.on('click', '.bp-mes .mes_prompt', function (e) {
        e.stopPropagation();
        showPromptPopup();
    });

    // Regenerate (custom BP button)
    $panel.on('click', '.bp-mes .bp-regenerate', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleRegenerate(convo, idx);
    });

    // Swipe left
    $panel.on('click', '.bp-mes .swipe_left', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleSwipe(convo, idx, -1);
    });

    // Swipe right
    $panel.on('click', '.bp-mes .swipe_right', function (e) {
        e.stopPropagation();
        const idx = getBpIndex(this);
        const convo = getActiveConversation();
        if (convo && !isNaN(idx)) handleSwipe(convo, idx, 1);
    });

    // Extra buttons toggle (ST's ellipsis expand)
    $panel.on('click', '.bp-mes .extraMesButtonsHint', function (e) {
        e.stopPropagation();
        const $extra = $(this).siblings('.extraMesButtons');
        $extra.toggle();
    });
}

// ==========================================================================
// Drawer panel creation
// ==========================================================================

function createDrawerPanel(chatPanelHtml) {
    if ($('#burnerphone-drawer').length) return;

    // Build the full drawer structure matching ST's native pattern
    const $drawer = $(`
        <div id="burnerphone-drawer" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="burnerphoneIcon" class="drawer-icon fa-solid fa-mobile-screen-button fa-fw closedIcon drawerPinnedOpen"
                     title="BurnerPhone"></div>
            </div>
            <div id="burnerphone-panel" class="drawer-content closedDrawer fillRight pinnedOpen">
                <div id="burnerphone-panelheader" class="fa-solid fa-grip drag-grabber"></div>
                <div class="scrollableInner bp-panel-inner">
                </div>
            </div>
        </div>
    `);

    // Inject chat panel HTML into the scrollable inner area
    $drawer.find('.bp-panel-inner').append(chatPanelHtml);

    // Add to top-settings-holder (after the last existing drawer)
    $('#top-settings-holder').append($drawer);

    // CRITICAL: Bind the drawer toggle — ST's initial binding already ran at page load,
    // so dynamically-added drawers need explicit binding to doNavbarIconClick
    $drawer.find('.drawer-toggle').on('click', doNavbarIconClick);
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

    // Render chat panel and create the independent drawer panel
    const chatPanelHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'chat-panel');
    createDrawerPanel(chatPanelHtml);

    // Watch for drawer open to refresh UI (detect class change on drawer-content)
    const panelEl = document.getElementById('burnerphone-panel');
    if (panelEl) {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'class' && panelEl.classList.contains('openDrawer')) {
                    onDrawerOpened();
                    break;
                }
            }
        });
        observer.observe(panelEl, { attributes: true, attributeFilter: ['class'] });
    }

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

    console.log('[BurnerPhone] Extension loaded (v0.5.0)');
});
