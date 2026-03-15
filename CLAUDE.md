# BurnerPhone - SillyTavern Extension

## File Structure
```
sillytavern-BurnerPhone/
  index.js          - Main extension (~1750 lines). Settings-backed conversations, UI, generation.
  chat-panel.html   - Chat panel UI template (injected into drawer).
  settings.html     - Settings panel HTML (injected into ST extensions settings).
  style.css         - Styles for messages, bubbles, input, picker, settings.
  manifest.json     - Extension manifest.
```

## What It Does
PM (private message) extension enabling isolated or integrated character conversations outside the main story. Per-conversation `pmContextMode` (isolated/lore/lore-context/full) controls knowledge flow — 4 modes from fully isolated to bidirectional story awareness. Uses ST's `.mes` message template for visual parity with main chat. Conversations stored in `extension_settings`.

## Imports
| Import | Source | Used For |
|--------|--------|----------|
| `setExtensionPrompt` | script.js | Inject PM into main generation |
| `extension_prompt_types/roles` | script.js | Injection position/role constants |
| `generateQuietPrompt` | script.js | Generate AI response for PM |
| `characters`, `chat`, `name1`, `this_chid` | script.js | Character list, current chat, user name, character ID |
| `messageFormatting` | script.js | Rich text rendering (markdown, code blocks, DOMPurify) |
| `user_avatar`, `default_avatar` | script.js | Avatar paths |
| `doNavbarIconClick` | script.js | Drawer toggle binding |
| `extension_settings`, `renderExtensionTemplateAsync` | extensions.js | Settings storage, HTML templates |
| `eventSource`, `event_types` | events.js | `GENERATE_AFTER_DATA`, `CHAT_CHANGED` |
| `is_group_generating`, `selected_group` | group-chats.js | Group chat detection |
| `executeSlashCommandsWithOptions` | slash-commands.js | TTS via `/narrate` |
| `Popup`, `POPUP_TYPE` | popup.js | Modal popup for prompt viewer |

## Settings (defaultSettings)
```javascript
{
  enabled, pmContextMode, pmScanDepth, mainChatScanDepth,
  injectionPosition, injectionDepth, injectionRole, injectionMaxMessages,
  promptTemplate, userBubbleColor, charBubbleColor, showDateSeparators,
  conversations, activeConversation, debugMode
}
// Per-conversation: { from, to, messages, pmContextMode, lastReadCount, draftText }
```

## Key Functions
| Function | Purpose |
|----------|---------|
| `generateResponse(convo, messagesForPrompt, statusLabel)` | Shared generation core — builds prompt, calls API, returns cleaned response |
| `sendPmMessage(text)` | Add user msg (pending), call generateResponse, commit on success |
| `sendPmRetry(convo)` | Retry generation for pending user message |
| `handleRegenerate(convo, index)` | Regenerate any AI message. Truncates if not last. |
| `cancelGeneration()` | Set cancelRequested flag to discard response |
| `resetGenerationState()` | Clear isGenerating, cancel, restore UI |
| `buildPromptFromTemplate(conversation, loreContext)` | Build PM prompt with placeholder substitution |
| `fetchDeepLoreEntries(conversation, scanDepth, mainChatText, namesOnly)` | Fetch matched lore. All modes include character names; namesOnly=true for isolated mode |
| `formatPmForInjection(conversation, max)` | Format PM as XML for main chat injection |
| `onGenerate(chatMessages, ...)` | Generate interceptor: inject PM via `setExtensionPrompt()` |
| `renderConversation()` | Render messages with date separators, pending UI, swipes |
| `buildPickerItems(isFromField, filter)` | Build character/persona items for picker dropdown |
| `setupPickerField(inputId, dropdownId, isFromField)` | Wire up focus/input/blur for picker |
| `exportConversation() / importConversation(file)` | JSON export/import of conversations |
| `updateDrawerBadge()` | Show unread message count on drawer icon |
| `markActiveConversationRead()` | Set lastReadCount = messages.length, update badge |
| `migrateConversationKeys()` | Migrate old '::' keys to '\x1F' separator |

## Architecture Notes

### Generation Pipeline (v0.7)
- Shared `generateResponse()` handles: isGenerating mutex, 120s safety timeout, cancel support, DeepLore fetch, prompt building (no mutation — uses tempConvo), context capture, cleanup
- `sendPmMessage()`: pushes user msg with `pending: true`, calls generateResponse, commits on success
- `handleRegenerate()`: works on ANY AI message (not just last). Mid-conversation regen truncates messages after the target with user confirmation.
- Cancel: sets `cancelRequested` flag, response is discarded after API returns

### Conversation Keys
- Uses `\x1F` (unit separator) instead of `::` to avoid collisions with character names
- `migrateConversationKeys()` runs at init to convert old `::` keys
- `migrateConversation()` handles both separators when reconstructing from keys

### Character Picker
- Custom dropdown with avatar thumbnails + names (replaces datalist)
- Personas listed in "From" field, characters in both fields
- Filters on input, click to select, blur to close
- Auto-populates "To" with active character when opening with no conversation

### Event Isolation
- All handlers bound on `$('#burnerphone-panel')` — closer in DOM than `$(document)`
- `e.stopPropagation()` prevents ST's `$(document).on()` handlers from firing on BP messages
- Catch-all: any `.bp-mes .mes_button` click gets stopPropagation

### ST Template Reuse
- Clones `$('#message_template .mes')` from DOM
- Adds `.bp-mes` class + `data-bp-idx` attribute (NOT `mesid` — avoids ST handler conflicts)
- Uses `messageFormatting()` for rich text
- Hides unused ST buttons (translate, SD gen, bookmark, branch, embed, etc.)
- Regenerate button on ALL AI messages (not just last)
- Pending messages get `.bp-pending` class + retry/delete bar

### Swipe Behavior
- Swipes initialized on all new AI messages (`swipes: [content], swipe_id: 0`)
- Swipe-right past last swipe on last AI message triggers regeneration
- Swipe arrows on non-last messages behave normally (bounded)

### DeepLore Enhanced Integration
- Calls `globalThis.deepLoreEnhanced_matchText(scanText)` to get matched vault entries
- Scan text composition varies by mode:
  - `isolated`: character names only (namesOnly=true)
  - `lore`: character names + PM messages
  - `lore-context` / `full`: character names + PM messages + main chat messages
- Shows `toastr.warning` on DeepLore errors (not silent)
- Returns `{text, count, tokens}` — injected via `{{loreContext}}` placeholder

### Export/Import
- Export: serializes active conversation to JSON with `version: 1` format
- Import: parses JSON, validates structure, appends to existing or creates new conversation
- File format: `{ version, from, to, messages, pmContextMode, exportedAt }`

### Drawer Badge (Unread Tracking)
- Shows total **unread** message count across all conversations on the drawer icon
- Each conversation has `lastReadCount` tracking how many messages have been seen
- Marked read on drawer open and conversation switch
- Updated on send, delete, clear, import

### Ghost Conversation Detection
- `renderConversationList()` checks if card-type characters still exist
- Orphaned conversations get `.bp-orphaned` class (dimmed + warning icon)

### Knowledge Modes (v0.7)
| Mode | Lore/WI Scan | Main Chat in Prompt | Story Sees PM |
|:---:|--------|:---:|:---:|
| Isolated | Character names only | No | No |
| Lore Only | Character names + PM text | No | No |
| Lore + Context | Character names + PM + main chat | Yes | No |
| Full | Character names + PM + main chat | Yes | Yes (injected) |

**Baseline**: Character names (From + To) are ALWAYS included in lore scan text regardless of mode. `skipWIAN: false` for all modes so ST's built-in WI can find character entries.

### Group Chat Injection
In `full` mode during group chat, injection targets `this_chid` so only that character's generation sees the PM transcript. If character card not found (deleted), injection is cleared.

## CSS Structure
- `#burnerphone-drawer` → outer drawer container
- `#burnerphone-panel` → panel content area
- `.bp-mes` → message element (cloned ST template)
- `.bp-mes.bp-pending` → pending message (dimmed)
- `.bp-mes[is_user="true/false"] .mes_block` → bubble coloring via CSS vars
- `.bp-convo-list` → conversation list
- `.bp-convo-item.active` → highlighted conversation tab
- `.bp-convo-item.bp-orphaned` → ghost conversation (dimmed)
- `.bp-picker-dropdown` → character picker dropdown
- `.bp-picker-item` → individual picker entry with avatar
- `.bp-date-separator` → date divider between messages
- `.bp-retry-bar` → retry/delete buttons on pending messages
- `.bp-badge` → unread count on drawer icon
- `.bp-cancel-btn` → cancel generation button
- `.bp-status.generating` → pulsing animation
