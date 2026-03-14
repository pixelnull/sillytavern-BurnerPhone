# BurnerPhone

A SillyTavern extension for private message conversations with characters — outside the main roleplay.

## Features

- **From/To messaging** — Chat as yourself or puppet one character messaging another
- **Character picker with avatars** — Dropdown with avatar thumbnails for characters and personas, or type any name for manual entry
- **Auto-populate** — "To" field auto-fills with the active character when opening with no conversation
- **6 knowledge modes** via two independent toggles:
  - **PM Context Mode** (Isolated / Lore / Full) — controls what the PM character knows
  - **Story Sees PM** — injects PM transcript into the main generation
- **Group chat targeting** — When "Story sees PM" is on in a group chat, only the target character sees the PM transcript
- **Regenerate any message** — Regenerate any AI message, not just the last one (mid-conversation regen truncates with confirmation)
- **Swipe support** — Swipe through alternate responses; swipe-right past the last swipe triggers regeneration
- **Cancel generation** — Stop button appears during generation to discard the response
- **Export/Import** — Save conversations as JSON files, import them back
- **Date separators** — Optional date dividers between messages (display only, not sent to AI)
- **Conversation badge** — Total message count shown on the drawer icon
- **Ghost detection** — Orphaned conversations from deleted characters are visually flagged
- **Pending message UI** — Failed sends show retry/delete options instead of disappearing
- **Editable prompt template** — Customize the system prompt with placeholders
- **View sent context** — Inspect the full prompt sent to the AI after each generation
- **Customizable bubble colors** — Color picker for From and To message bubbles
- **Persistent conversations** — PM chats survive page reloads (stored in extension settings)
- **Works with DeepLore Enhanced** — Character names are prepended to scan text for reliable lore matching

## Knowledge Modes

| PM Context Mode | Story Sees PM | Effect |
|:---:|:---:|-----------|
| Isolated | Off | Fully isolated PM — no lore, no chat |
| Isolated | On | Story references PM, PM character fully isolated |
| Lore | Off | PM character gets world info/lore, but no main chat context |
| Lore | On | PM character gets lore; story also sees PM |
| Full | Off | PM character sees lore + main chat, story doesn't see PM |
| Full | On | Full bidirectional awareness |

**Group chat bonus:** With "Story sees PM" on, only the target character's generation receives the PM transcript. Other characters in the group remain unaware.

## How It Works

### Generation

BurnerPhone uses a shared `generateResponse()` core with:
- **Mutex** — prevents double-sends
- **120s safety timeout** — auto-resets if generation hangs
- **Cancel support** — discard response mid-generation
- **No mutation** — builds a temporary conversation copy for the prompt
- **Pending messages** — user messages marked pending until AI responds successfully

Context modes:
- **Lore/Full**: Uses `generateQuietPrompt({ skipWIAN: false })` — full SillyTavern pipeline runs
- **Isolated**: Uses `generateQuietPrompt({ skipWIAN: true })` — World Info suppressed, isolation framing added

### Story Injection

When "Story sees PM" is enabled, the `generate_interceptor` injects the PM transcript via `setExtensionPrompt()`. In group chats, injection is targeted to `this_chid` so only the relevant character sees it. If the character card is deleted, injection is safely cleared.

### DeepLore Integration

Character names (From and To) are prepended to the scan text sent to DeepLore, ensuring lore entries keyed to those names always match — even for manually typed characters. Errors show a `toastr.warning` instead of failing silently.

## Prompt Template

The prompt template supports these placeholders:

| Placeholder | Description |
|-------------|-------------|
| `{{from}}` | From character name |
| `{{to}}` | To character name |
| `{{user}}` | Your SillyTavern username |
| `{{fromContext}}` | From character's card description (or WI instruction for typed names) |
| `{{toContext}}` | To character's card description (or WI instruction for typed names) |
| `{{loreContext}}` | Matched DeepLore/lorebook entries |
| `{{storyContext}}` | Recent main chat messages (empty in Isolated/Lore modes) |
| `{{pmHistory}}` | Formatted PM conversation history |

## Installation

1. Copy or symlink the `sillytavern-BurnerPhone` folder into:
   ```
   SillyTavern/public/scripts/extensions/third-party/sillytavern-BurnerPhone
   ```

2. Reload SillyTavern

3. The extension appears as:
   - A phone icon in the top settings bar (with message count badge)
   - Its own slide-out panel
   - Settings in the Extensions settings panel

## Usage

1. Click the phone icon in the top bar to open the BurnerPhone panel
2. **From** defaults to your current persona. Click the field to see a dropdown of personas and characters
3. **To** auto-populates with the active character. Click to browse or type a name
4. Click the arrow button to start a conversation
5. Toggle PM Context Mode and Story Sees PM per conversation
6. Use the header icons to export, import, or inspect the last prompt

## Settings

Found in the Extensions settings panel under "BurnerPhone":

- **Defaults** — Default PM context mode and Story Sees PM for new conversations
- **Generation** — PM message depth, main chat scan depth
- **Injection** — Position, depth, role, and max messages for main chat injection
- **Appearance** — Date separators toggle, From/To bubble colors with reset buttons
- **Prompt Template** — Full template editor with reset to default
- **Debug Mode** — Logs prompt and injection details to console

## Requirements

- SillyTavern (recent version with extension support)
- An active API connection configured in SillyTavern

## Compatibility

- Works in Firefox and Chrome
- Compatible with DeepLore Enhanced — lorebook entries activate automatically
- Compatible with group chats — targeted PM injection per character
