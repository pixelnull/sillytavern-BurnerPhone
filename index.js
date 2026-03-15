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
{{loreContext}}
{{storyContext}}
[PM History between {{from}} and {{to}}]
{{pmHistory}}

<think>This is a quick text message reply. Keep it brief and natural. Only write the words {{to}} sends — no narration, no emoting, no actions, no asterisks.</think>

You are {{to}}. {{from}} is messaging you privately. Respond ONLY with {{to}}'s spoken/typed words. No narration, no actions, no emotes — just the text message reply. Keep it natural and concise like a real text conversation.

Example — if {{from}} says "hey where are you?", respond like:
"At the bar on 5th. Why, what's up?"`;

const ISOLATION_FRAMING = `[This is an isolated private conversation. {{to}} has no knowledge of any ongoing story, roleplay, or events outside this PM exchange.]`;
const LORE_ONLY_FRAMING = `[This PM conversation is separate from the main story. {{to}} has general world knowledge and lore but is not aware of current story events or the main chat.]`;
const LORE_CONTEXT_FRAMING = `[This PM conversation takes place alongside the main story. {{to}} has world knowledge and is aware of the ongoing story context.]`;

const defaultSettings = {
    enabled: true,
    pmContextMode: 'isolated',
    pmScanDepth: 10,
    mainChatScanDepth: 10,
    injectionPosition: extension_prompt_types.IN_CHAT,
    injectionDepth: 4,
    injectionRole: extension_prompt_roles.SYSTEM,
    injectionMaxMessages: 20,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    userBubbleColor: '',
    charBubbleColor: '',
    showDateSeparators: true,
    conversations: {},
    activeConversation: null,
    debugMode: false,
};

// ==========================================================================
// State
// ==========================================================================

let isGenerating = false;
let cancelRequested = false;
let generationTimeout = null;
let saveDraftTimeout = null;
let lastSentPrompt = '';
let lastFullContext = null;

const GENERATION_TIMEOUT_MS = 120_000; // 2 minutes safety timeout
const KEY_SEPARATOR = '\x1F'; // Unit separator — can't appear in names

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

function getCharAvatarUrl(nameOrIdentity) {
    // Accept either a string name or an identity object {name, avatar}
    const lookupKey = (typeof nameOrIdentity === 'object')
        ? (nameOrIdentity.avatar || nameOrIdentity.name)
        : nameOrIdentity;
    const char = findCharacterCard(lookupKey);
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
    return `${fromKey}${KEY_SEPARATOR}${toKey}`;
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
            pmContextMode: settings.pmContextMode,
            lastReadCount: 0,
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
    // Reconstruct from the key — handle both old '::' and new '\x1F' separators
    const sep = key.includes(KEY_SEPARATOR) ? KEY_SEPARATOR : '::';
    const sepIdx = key.indexOf(sep);
    const fromName = sepIdx >= 0 ? key.substring(0, sepIdx) : key;
    const toName = sepIdx >= 0 ? key.substring(sepIdx + sep.length) : 'Unknown';
    if (!convo.from || !convo.from.name) {
        convo.from = { name: fromName || 'Unknown', type: 'typed', avatar: null };
    }
    if (!convo.to || !convo.to.name) {
        convo.to = { name: toName || 'Unknown', type: 'typed', avatar: null };
    }
    debug('Migrated conversation data for key:', key);
    saveSettingsDebounced();
}

/**
 * Migrate old '::' conversation keys to '\x1F' separator.
 * Also updates activeConversation if it used the old format.
 */
function migrateConversationKeys() {
    const conversations = getConversations();
    const settings = getSettings();
    let changed = false;

    for (const key of Object.keys(conversations)) {
        if (key.includes('::') && !key.includes(KEY_SEPARATOR)) {
            // Build new key from conversation's from/to (most reliable)
            const convo = conversations[key];
            migrateConversation(convo, key);
            const newKey = getConversationKey(convo.from, convo.to);
            if (newKey !== key) {
                conversations[newKey] = convo;
                delete conversations[key];
                if (settings.activeConversation === key) {
                    extension_settings[MODULE_NAME].activeConversation = newKey;
                }
                debug('Migrated key:', key, '→', newKey);
                changed = true;
            }
        }
    }

    if (changed) saveSettingsDebounced();
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

async function fetchDeepLoreEntries(conversation, scanDepth, mainChatText = '', namesOnly = false) {
    if (!globalThis.deepLoreEnhanced_matchText) return '';

    // Character names are ALWAYS included in scan text (baseline for all modes)
    const namePreamble = `${conversation.from.name} ${conversation.to.name}`;

    if (namesOnly) {
        // Isolated mode: scan only character names
        try {
            const result = await globalThis.deepLoreEnhanced_matchText(namePreamble);
            if (result.text) {
                debug(`DeepLore matched ${result.count} entries (~${result.tokens} tokens) [names-only]`);
                return result.text;
            }
        } catch (err) {
            console.error('[BurnerPhone] DeepLore matchText error:', err);
            toastr.warning('Lore context unavailable — DeepLore error', 'BurnerPhone', { timeOut: 4000 });
        }
        return '';
    }

    const recent = scanDepth > 0 ? conversation.messages.slice(-scanDepth) : [];
    if (recent.length === 0) return '';

    const messageLines = recent.map(msg => {
        const sender = msg.sender === 'from' ? conversation.from.name : conversation.to.name;
        return `${sender}: ${msg.content}`;
    }).join('\n');

    // Build scan text: character names + PM messages + optional main chat
    let scanText = `${namePreamble}\n${messageLines}`;
    if (mainChatText) {
        scanText += `\n${mainChatText}`;
    }

    try {
        const result = await globalThis.deepLoreEnhanced_matchText(scanText);
        if (result.text) {
            debug(`DeepLore matched ${result.count} entries (~${result.tokens} tokens)`);
            return result.text;
        }
    } catch (err) {
        console.error('[BurnerPhone] DeepLore matchText error:', err);
        toastr.warning('Lore context unavailable — DeepLore error', 'BurnerPhone', { timeOut: 4000 });
    }
    return '';
}

function buildPromptFromTemplate(conversation, loreContext = '') {
    const settings = getSettings();
    const template = settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
    const fromName = conversation.from.name;
    const toName = conversation.to.name;

    // Resolve character contexts
    const fromContext = resolveCharacterContext(conversation.from);
    const toContext = resolveCharacterContext(conversation.to);

    // Story context (lore-context and full modes)
    let storyContext = '';
    const contextMode = conversation.pmContextMode || 'isolated';
    if (contextMode === 'lore-context' || contextMode === 'full') {
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
        .replace(/\{\{loreContext\}\}/g, () => loreContext)
        .replace(/\{\{storyContext\}\}/g, () => storyContext)
        .replace(/\{\{pmHistory\}\}/g, () => pmHistory);

    // Clean up empty lines from missing sections
    prompt = prompt.replace(/\n{3,}/g, '\n\n').trim();

    // Add context framing based on mode
    if (contextMode === 'isolated') {
        const framing = ISOLATION_FRAMING.replace(/\{\{to\}\}/g, () => toName);
        prompt = framing + '\n\n' + prompt;
    } else if (contextMode === 'lore') {
        const framing = LORE_ONLY_FRAMING.replace(/\{\{to\}\}/g, () => toName);
        prompt = framing + '\n\n' + prompt;
    } else if (contextMode === 'lore-context' || contextMode === 'full') {
        const framing = LORE_CONTEXT_FRAMING.replace(/\{\{to\}\}/g, () => toName);
        prompt = framing + '\n\n' + prompt;
    }

    return prompt;
}

// ==========================================================================
// PM generation (shared core)
// ==========================================================================

/**
 * Shared generation core. Builds prompt from the given conversation+messages,
 * calls generateQuietPrompt, and returns the cleaned response text (or null).
 * Manages isGenerating, status, cancel, timeout, and context capture.
 *
 * @param {object} convo - The conversation object (not mutated)
 * @param {Array} messagesForPrompt - Messages to include in prompt context
 * @param {string} statusLabel - Status text shown during generation
 * @returns {Promise<string|null>} Cleaned response text, or null if empty/cancelled
 */
async function generateResponse(convo, messagesForPrompt, statusLabel = 'Generating...') {
    if (isGenerating) {
        setStatus('Already generating...');
        return null;
    }

    isGenerating = true;
    cancelRequested = false;
    setStatus(statusLabel, true);
    setSendEnabled(false);
    showCancelButton(true);

    // Safety timeout — auto-reset if generation hangs
    generationTimeout = setTimeout(() => {
        if (isGenerating) {
            console.error('[BurnerPhone] Generation timed out after', GENERATION_TIMEOUT_MS, 'ms');
            resetGenerationState();
            setStatus('Generation timed out');
        }
    }, GENERATION_TIMEOUT_MS);

    const contextHandler = (data) => {
        lastFullContext = data.prompt || data;
    };
    eventSource.once(event_types.GENERATE_AFTER_DATA, contextHandler);

    try {
        const contextMode = convo.pmContextMode || 'isolated';
        const settings = getSettings();

        // Fetch lore context — all modes scan for character names at minimum
        let loreContext = '';
        if (contextMode === 'isolated') {
            // Names-only scan: find lorebook entries keyed to character names
            loreContext = await fetchDeepLoreEntries(convo, settings.pmScanDepth, '', true);
        } else if (contextMode === 'lore') {
            // PM messages + character names
            loreContext = await fetchDeepLoreEntries(convo, settings.pmScanDepth);
        } else {
            // lore-context / full: PM messages + main chat + character names
            const mainChatText = getMainChatContext(settings.mainChatScanDepth);
            loreContext = await fetchDeepLoreEntries(convo, settings.pmScanDepth, mainChatText);
        }

        // Build prompt using a temporary convo with the specified messages (no mutation)
        const tempConvo = { ...convo, messages: messagesForPrompt };
        const prompt = buildPromptFromTemplate(tempConvo, loreContext);
        lastSentPrompt = prompt;
        debug('Built prompt, length:', prompt.length);

        if (cancelRequested) {
            setStatus('Generation cancelled');
            return null;
        }

        const response = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: false,
            quietName: convo.to.name,
        });

        if (cancelRequested) {
            setStatus('Generation cancelled');
            return null;
        }

        debug('Got response, length:', response ? response.length : 'null/empty');

        if (response && response.trim()) {
            return stripNamePrefix(response.trim(), convo.to.name);
        } else {
            setStatus('Empty response received');
            return null;
        }
    } catch (err) {
        console.error('[BurnerPhone] GENERATION ERROR:', err);
        setStatus(`Error: ${err?.message || 'Generation failed'}`);
        return null;
    } finally {
        clearTimeout(generationTimeout);
        generationTimeout = null;
        resetGenerationState();
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, contextHandler);
        debug('Generation complete');
    }
}

function resetGenerationState() {
    isGenerating = false;
    cancelRequested = false;
    setSendEnabled(true);
    showCancelButton(false);
}

function cancelGeneration() {
    if (isGenerating) {
        cancelRequested = true;
        setStatus('Cancelling...');
    }
}

function showCancelButton(show) {
    $('#bp_send').toggle(!show);
    $('#bp_cancel').toggle(show);
}

// ==========================================================================
// PM generation (send + regenerate)
// ==========================================================================

async function sendPmMessage(text) {
    debug('sendPmMessage called, text:', text ? text.substring(0, 50) : '(empty)');
    if (isGenerating) {
        setStatus('Already generating...');
        return;
    }
    if (!getSettings().enabled) {
        setStatus('BurnerPhone is disabled');
        return;
    }
    if (!text || !text.trim()) {
        setStatus('Type a message first');
        return;
    }

    const convo = getActiveConversation();
    if (!convo) {
        setStatus('No active conversation — start one first');
        return;
    }
    debug('Active convo:', convo.from.name, '→', convo.to.name, 'msgs:', convo.messages?.length);

    const trimmed = text.trim();

    // Push user message with pending flag (uncommitted until AI responds)
    convo.messages.push({
        sender: 'from',
        content: trimmed,
        timestamp: Date.now(),
        pending: true,
    });

    // Clear draft
    convo.draftText = '';
    $('#bp_input').val('');
    saveSettingsDebounced();
    renderConversation();
    scrollChatToBottom();

    const cleaned = await generateResponse(convo, convo.messages, 'Generating...');

    if (cleaned) {
        // Commit the user message (remove pending flag)
        const userMsg = convo.messages[convo.messages.length - 1];
        if (userMsg && userMsg.pending) delete userMsg.pending;

        convo.messages.push({
            sender: 'to',
            content: cleaned,
            timestamp: Date.now(),
            swipes: [cleaned],
            swipe_id: 0,
        });
        saveSettingsDebounced();
        renderConversation();
        scrollChatToBottom();
        setStatus('');
        markActiveConversationRead();
    } else {
        // Generation failed or was cancelled — mark user message for retry
        const userMsg = convo.messages[convo.messages.length - 1];
        if (userMsg && userMsg.pending) {
            renderConversation();
            scrollChatToBottom();
        }
    }
}

/**
 * Retry generation for a conversation that already has the user message in place.
 * Used by the retry button on pending messages.
 */
async function sendPmRetry(convo) {
    const cleaned = await generateResponse(convo, convo.messages, 'Retrying...');
    if (cleaned) {
        // Commit the pending user message
        const lastMsg = convo.messages[convo.messages.length - 1];
        if (lastMsg && lastMsg.pending) delete lastMsg.pending;

        convo.messages.push({
            sender: 'to',
            content: cleaned,
            timestamp: Date.now(),
            swipes: [cleaned],
            swipe_id: 0,
        });
        saveSettingsDebounced();
        renderConversation();
        scrollChatToBottom();
        setStatus('');
        markActiveConversationRead();
    } else {
        // Keep pending flag so retry bar remains visible
        renderConversation();
        scrollChatToBottom();
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
        // Escape closing tags to prevent XML breakout in prompt
        const safeContent = msg.content.replace(/<\//g, '&lt;/');
        return `${sender}: ${safeContent}`;
    });

    const safeFrom = fromName.replace(/"/g, '&quot;');
    const safeTo = toName.replace(/"/g, '&quot;');
    return `<private_messages from="${safeFrom}" to="${safeTo}">\n[Private message exchange between ${fromName} and ${toName}, happening outside the main story:]\n${lines.join('\n')}\n</private_messages>`;
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

        if (convo.pmContextMode !== 'full' || !convo.messages.length) {
            // Clear any stale injection — only 'full' mode injects PMs into story
            setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
            continue;
        }

        // GROUP CHAT TARGETING: only inject when generating for the To character
        if (is_group_generating && selected_group) {
            const toCard = findCharacterCard(convo.to.avatar || convo.to.name);
            if (!toCard) {
                // Character not found (deleted?) — don't inject
                setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
                continue;
            }
            const toIndex = characters.indexOf(toCard);
            if (String(toIndex) !== String(this_chid)) {
                // Not this character's turn — clear injection for this key
                setExtensionPrompt(`burner_pm_${key}`, '', extension_prompt_types.IN_PROMPT, 0);
                continue;
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

    const settings = getSettings();
    let lastDateStr = '';

    convo.messages.forEach((msg, index) => {
        // Date separator (optional, UI-only)
        if (settings.showDateSeparators && msg.timestamp) {
            const dateStr = new Date(msg.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
            if (dateStr !== lastDateStr) {
                lastDateStr = dateStr;
                $messages.append($('<div class="bp-date-separator"></div>').text(dateStr));
            }
        }

        const isFrom = msg.sender === 'from';
        const senderName = isFrom ? convo.from.name : convo.to.name;
        const displayContent = getDisplayContent(msg);
        const timeStr = msg.timestamp
            ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

        // Clone ST's message template
        const $mes = $('#message_template .mes').clone();
        $mes.addClass('bp-mes');
        if (msg.pending) $mes.addClass('bp-pending');
        $mes.attr('data-bp-idx', index);
        $mes.removeAttr('mesid');
        $mes.attr('is_user', isFrom);
        $mes.attr('is_system', false);
        $mes.attr('ch_name', senderName);

        // Name + timestamp
        $mes.find('.name_text').text(senderName);
        $mes.find('.timestamp').text(timeStr);

        // Avatar
        const avatarUrl = isFrom
            ? (convo.from.type === 'user' ? getUserAvatarUrl() : getCharAvatarUrl(convo.from))
            : getCharAvatarUrl(convo.to);
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

        // Add regenerate button for ALL AI messages (F2)
        if (!isFrom) {
            $mes.find('.extraMesButtons').append(
                '<div title="Regenerate" class="mes_button bp-regenerate fa-solid fa-arrows-rotate"></div>',
            );
        }

        // Pending message retry UI
        if (msg.pending && isFrom && index === convo.messages.length - 1) {
            $mes.find('.mes_block').append(
                `<div class="bp-retry-bar">
                    <span>Failed to get response</span>
                    <div class="menu_button bp-retry" title="Retry">Retry</div>
                    <div class="menu_button bp-delete-pending" title="Delete">Delete</div>
                </div>`,
            );
        }

        // Swipes — use ST template's built-in elements
        if (!isFrom && msg.swipes && msg.swipes.length > 1) {
            const swipeId = msg.swipe_id || 0;
            $mes.find('.swipe_left').show().toggleClass('disabled', swipeId === 0);
            // Don't disable swipe_right on last swipe of last message — allow swipe-to-regen (F4)
            const isLastMsg = index === convo.messages.length - 1;
            $mes.find('.swipe_right').show().toggleClass('disabled', !isLastMsg && swipeId === msg.swipes.length - 1);
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

        // Check if characters still exist (ghost detection)
        const toOrphaned = convo.to.type === 'card' && !findCharacterCard(convo.to.avatar || convo.to.name);
        const fromOrphaned = convo.from.type === 'card' && !findCharacterCard(convo.from.avatar || convo.from.name);
        const isOrphaned = toOrphaned || fromOrphaned;

        const $item = $('<div class="bp-convo-item"></div>')
            .toggleClass('active', isActive)
            .toggleClass('bp-orphaned', isOrphaned)
            .attr('data-key', key);
        if (isOrphaned) {
            $item.attr('title', 'Character no longer found');
            $item.append($('<i class="fa-solid fa-triangle-exclamation" style="opacity:0.6;margin-right:4px;font-size:0.8em;"></i>'));
        }
        const unread = Math.max(0, (convo.messages?.length || 0) - (convo.lastReadCount || 0));
        const countLabel = unread > 0 ? `${label} (${unread} new)` : `${label} (${convo.messages.length})`;
        $item.append($('<span></span>').text(countLabel));
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
    updateDrawerBadge();
}

async function handleRegenerate(convo, index) {
    const msg = convo.messages[index];
    if (msg.sender !== 'to') return;

    // If regenerating a non-last message, warn about truncation
    if (index < convo.messages.length - 1) {
        const removeCount = convo.messages.length - 1 - index;
        if (!confirm(`This will remove ${removeCount} message${removeCount > 1 ? 's' : ''} after this point. Continue?`)) return;
        convo.messages.splice(index + 1);
        saveSettingsDebounced();
        renderConversation();
    }

    // Initialize swipes if not present
    if (!msg.swipes) {
        msg.swipes = [msg.content];
        msg.swipe_id = 0;
    }

    // Build prompt from messages up to (not including) the message being regenerated
    const messagesForPrompt = convo.messages.slice(0, index);
    const cleaned = await generateResponse(convo, messagesForPrompt, 'Regenerating...');

    if (cleaned) {
        msg.swipes.push(cleaned);
        msg.swipe_id = msg.swipes.length - 1;
        msg.content = cleaned;
        msg.timestamp = Date.now();
        saveSettingsDebounced();
        renderConversation();
        scrollChatToBottom();
        setStatus('');
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
    if (!msg.swipes || msg.swipes.length === 0) return;

    const currentId = msg.swipe_id || 0;
    const newId = currentId + direction;

    // Swipe-right past last swipe on last AI message → trigger regeneration (F4)
    if (direction === 1 && newId >= msg.swipes.length && index === convo.messages.length - 1 && msg.sender === 'to') {
        handleRegenerate(convo, index);
        return;
    }

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
    $('#bp_toggle_context_mode').val(convo.pmContextMode || 'isolated');

    // Mark as read
    markActiveConversationRead();

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
    updateDrawerBadge();
    debug(`Deleted conversation: ${label}`);
}

// ==========================================================================
// Draft saving
// ==========================================================================

function saveDraftImmediate() {
    if (saveDraftTimeout) {
        clearTimeout(saveDraftTimeout);
        saveDraftTimeout = null;
    }
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
    autoPopulateTo();
    renderConversationList();
    const activeKey = getActiveKey();
    if (activeKey) switchToConversation(activeKey);
    markActiveConversationRead();
}

// ==========================================================================
// Character Picker (dropdown with avatars)
// ==========================================================================

function buildPickerItems(isFromField, filterText) {
    const items = [];
    const filter = (filterText || '').toLowerCase().trim();

    // For "From" field: add persona / "Me" option first
    if (isFromField) {
        const personaName = name1 || 'User';
        if (!filter || `me ${personaName}`.toLowerCase().includes(filter)) {
            items.push({
                label: `Me (${personaName})`,
                avatarUrl: getUserAvatarUrl(),
                section: 'Persona',
            });
        }
    }

    // Characters
    if (characters && characters.length) {
        for (const char of characters) {
            if (!char || !char.name) continue;
            if (filter && !char.name.toLowerCase().includes(filter)) continue;
            items.push({
                label: char.name,
                avatarUrl: char.avatar ? `/characters/${char.avatar}` : default_avatar,
                section: 'Characters',
            });
        }
    }

    return items;
}

function renderPickerDropdown($dropdown, items) {
    $dropdown.empty();
    if (items.length === 0) {
        $dropdown.hide();
        return;
    }

    let currentSection = '';
    for (const item of items) {
        if (item.section !== currentSection) {
            currentSection = item.section;
            $dropdown.append($(`<div class="bp-picker-section-label"></div>`).text(currentSection));
        }
        const $item = $(`<div class="bp-picker-item"></div>`)
            .attr('data-value', item.label);
        $item.append($(`<img class="bp-picker-avatar">`).attr('src', item.avatarUrl));
        $item.append($(`<span class="bp-picker-name"></span>`).text(item.label));
        $dropdown.append($item);
    }
    $dropdown.show();
}

function setupPickerField(inputId, dropdownId, isFromField) {
    const $input = $(`#${inputId}`);
    const $dropdown = $(`#${dropdownId}`);

    // Show dropdown on focus
    $input.on('focus', () => {
        const items = buildPickerItems(isFromField, $input.val());
        renderPickerDropdown($dropdown, items);
    });

    // Filter on input
    $input.on('input', () => {
        const items = buildPickerItems(isFromField, $input.val());
        renderPickerDropdown($dropdown, items);
    });

    // Click item to select
    $dropdown.on('mousedown', '.bp-picker-item', function (e) {
        e.preventDefault(); // Prevent blur
        const value = $(this).attr('data-value');
        $input.val(value);
        $dropdown.hide();
    });

    // Hide on blur (with delay for click registration)
    $input.on('blur', () => {
        setTimeout(() => $dropdown.hide(), 150);
    });
}

function initPickers() {
    setupPickerField('bp_from', 'bp_from_dropdown', true);
    setupPickerField('bp_to', 'bp_to_dropdown', false);

    // Set default From value if empty
    const $from = $('#bp_from');
    if (!$from.val()) {
        $from.val(`Me (${name1 || 'User'})`);
    }

    // Auto-populate To with active character if no active conversation
    autoPopulateTo();
}

function autoPopulateTo() {
    const $to = $('#bp_to');
    if ($to.val()) return; // Don't overwrite existing value
    if (getActiveKey()) return; // Active conversation exists

    // Use currently active character
    if (this_chid !== undefined && characters && characters[this_chid]) {
        $to.val(characters[this_chid].name);
    }
}

// ==========================================================================
// Export / Import
// ==========================================================================

function exportConversation() {
    const convo = getActiveConversation();
    if (!convo) {
        setStatus('No active conversation to export');
        return;
    }

    const data = {
        version: 1,
        from: { ...convo.from },
        to: { ...convo.to },
        messages: convo.messages.map(m => ({ ...m })),
        pmContextMode: convo.pmContextMode,
        exportedAt: new Date().toISOString(),
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const datePart = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `bp-${convo.from.name}-${convo.to.name}-${datePart}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Exported conversation');
}

function importConversation(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.from || !data.to || !Array.isArray(data.messages)) {
                setStatus('Invalid BurnerPhone export file');
                return;
            }

            const from = data.from;
            const to = data.to;
            const { key, conversation } = getOrCreateConversation(from, to);

            // Append imported messages (don't overwrite existing)
            if (conversation.messages.length > 0) {
                if (!confirm(`Conversation ${from.name} → ${to.name} already has ${conversation.messages.length} messages. Append ${data.messages.length} imported messages?`)) return;
            }
            conversation.messages.push(...data.messages);
            if (data.pmContextMode) conversation.pmContextMode = data.pmContextMode;

            saveSettingsDebounced();
            switchToConversation(key);
            setStatus(`Imported ${data.messages.length} messages`);
        } catch (err) {
            console.error('[BurnerPhone] Import error:', err);
            setStatus('Failed to import — invalid JSON');
        }
    };
    reader.readAsText(file);
}

// ==========================================================================
// Drawer Badge
// ==========================================================================

function updateDrawerBadge() {
    const conversations = getConversations();
    const totalUnread = Object.values(conversations).reduce((sum, c) => {
        const unread = (c.messages?.length || 0) - (c.lastReadCount || 0);
        return sum + Math.max(0, unread);
    }, 0);
    const $icon = $('#burnerphoneIcon');
    $icon.find('.bp-badge').remove();
    if (totalUnread > 0) {
        $icon.append($(`<span class="bp-badge"></span>`).text(totalUnread));
    }
}

function markActiveConversationRead() {
    const convo = getActiveConversation();
    if (!convo) return;
    convo.lastReadCount = convo.messages.length;
    saveSettingsDebounced();
    updateDrawerBadge();
}

// ==========================================================================
// Settings UI
// ==========================================================================

function loadSettingsUI() {
    const settings = getSettings();
    $('#bp_enabled').prop('checked', settings.enabled);
    $('#bp_default_pm_context_mode').val(settings.pmContextMode);
    $('#bp_pm_scan_depth').val(settings.pmScanDepth);
    $('#bp_main_chat_scan_depth').val(settings.mainChatScanDepth);
    $('#bp_injection_position').val(settings.injectionPosition);
    $('#bp_injection_depth').val(settings.injectionDepth);
    $('#bp_injection_role').val(settings.injectionRole);
    $('#bp_injection_max_messages').val(settings.injectionMaxMessages);
    $('#bp_prompt_template').val(settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE);
    $('#bp_show_date_separators').prop('checked', settings.showDateSeparators);
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
    bind('#bp_default_pm_context_mode', 'pmContextMode', $el => $el.val());
    bind('#bp_pm_scan_depth', 'pmScanDepth', $el => parseInt($el.val()) || 10);
    bind('#bp_main_chat_scan_depth', 'mainChatScanDepth', $el => parseInt($el.val()) || 10);
    bind('#bp_injection_position', 'injectionPosition', $el => parseInt($el.val()));
    bind('#bp_injection_depth', 'injectionDepth', $el => parseInt($el.val()) || 4);
    bind('#bp_injection_role', 'injectionRole', $el => parseInt($el.val()));
    bind('#bp_injection_max_messages', 'injectionMaxMessages', $el => parseInt($el.val()) || 20);
    bind('#bp_prompt_template', 'promptTemplate', $el => $el.val());
    bind('#bp_show_date_separators', 'showDateSeparators', $el => $el.prop('checked'));
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
        debug('Start conversation clicked');
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
        debug('Send button clicked');
        sendPmMessage($('#bp_input').val());
    });

    // Enter to send (shift+enter for newline) — delegated
    $(document).off('keydown.bp_input', '#bp_input').on('keydown.bp_input', '#bp_input', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            debug('Enter pressed in input');
            e.preventDefault();
            sendPmMessage($(this).val());
        }
    });

    // Draft auto-save — delegated
    $(document).off('input.bp_draft', '#bp_input').on('input.bp_draft', '#bp_input', saveDraftDebounced);

    // Per-conversation toggles — delegated
    $(document).off('change.bp_context', '#bp_toggle_context_mode').on('change.bp_context', '#bp_toggle_context_mode', function () {
        const convo = getActiveConversation();
        if (convo) {
            convo.pmContextMode = $(this).val();
            saveSettingsDebounced();
            debug(`pmContextMode = ${convo.pmContextMode}`);
            // Clear story injection if no longer in full mode
            if (convo.pmContextMode !== 'full') {
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
        convo.lastReadCount = 0;
        saveSettingsDebounced();
        renderConversation();
        updateDrawerBadge();
        setStatus('Conversation cleared');
    });

    // Cancel generation
    $(document).off('click.bp_cancel', '#bp_cancel').on('click.bp_cancel', '#bp_cancel', function () {
        cancelGeneration();
    });

    // Export conversation
    $(document).off('click.bp_export', '#bpExport').on('click.bp_export', '#bpExport', function () {
        exportConversation();
    });

    // Import conversation
    $(document).off('click.bp_import', '#bpImport').on('click.bp_import', '#bpImport', function () {
        $('#bpImportFile').trigger('click');
    });
    $(document).off('change.bp_import_file', '#bpImportFile').on('change.bp_import_file', '#bpImportFile', function () {
        importConversation(this.files[0]);
        $(this).val(''); // Reset so same file can be re-imported
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

    // Retry pending message
    $panel.on('click', '.bp-retry', function (e) {
        e.stopPropagation();
        const convo = getActiveConversation();
        if (!convo) return;
        const lastMsg = convo.messages[convo.messages.length - 1];
        if (lastMsg && lastMsg.pending) {
            // sendPmRetry handles pending flag: deletes on success, keeps on failure
            sendPmRetry(convo);
        }
    });

    // Delete pending message
    $panel.on('click', '.bp-delete-pending', function (e) {
        e.stopPropagation();
        const convo = getActiveConversation();
        if (!convo) return;
        const lastMsg = convo.messages[convo.messages.length - 1];
        if (lastMsg && lastMsg.pending) {
            convo.messages.pop();
            saveSettingsDebounced();
            renderConversation();
        }
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

    // Migrate old '::' conversation keys to '\x1F' separator
    migrateConversationKeys();

    // v0.7.0 migration: storySeesPm → full mode, add lastReadCount
    {
        const conversations = getConversations();
        let migrated = false;
        for (const convo of Object.values(conversations)) {
            // Migrate storySeesPm into pmContextMode
            if (convo.storySeesPm !== undefined) {
                if (convo.storySeesPm) {
                    // storySeesPm was on → upgrade to full
                    convo.pmContextMode = 'full';
                } else if (convo.pmContextMode === 'full') {
                    // Old 'full' without storySeesPm → map to lore-context
                    convo.pmContextMode = 'lore-context';
                }
                delete convo.storySeesPm;
                migrated = true;
            }
            // Init lastReadCount for existing conversations (no spurious badge)
            if (convo.lastReadCount === undefined) {
                convo.lastReadCount = convo.messages?.length || 0;
                migrated = true;
            }
        }
        // Also clean storySeesPm from global settings
        if (extension_settings[MODULE_NAME].storySeesPm !== undefined) {
            delete extension_settings[MODULE_NAME].storySeesPm;
            migrated = true;
        }
        if (migrated) {
            saveSettingsDebounced();
            debug('v0.7.0 migration: storySeesPm → pmContextMode, added lastReadCount');
        }
    }

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

    // Initialize character pickers
    initPickers();

    // Refresh pickers and auto-populate on chat change
    eventSource.on(event_types.CHAT_CHANGED, () => {
        autoPopulateTo();
    });

    // Restore active conversation if any
    const activeKey = getActiveKey();
    if (activeKey && getConversations()[activeKey]) {
        switchToConversation(activeKey);
    }

    // Initial badge
    updateDrawerBadge();

    console.log('[BurnerPhone] Extension loaded (v0.7.0)');
});
