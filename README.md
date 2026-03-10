# BurnerPhone

A SillyTavern extension for private message conversations with characters — outside the main roleplay.

## Features

- **From/To messaging** — Chat as yourself or puppet one character messaging another
- **Character cards or typed names** — Select from your character cards or type any name to trigger lorebook/World Info entries
- **4 knowledge modes** via two independent toggles:
  - **PM sees world** — The PM character knows the story (main chat history + full lorebook)
  - **Story sees PM** — The main chat/story generation includes the PM conversation
- **Group chat targeting** — When "Story sees PM" is on in a group chat, only the target character sees the PM transcript
- **Editable prompt template** — Customize the system prompt with placeholders
- **View sent context** — Inspect the full prompt sent to the AI after each generation
- **Customizable bubble colors** — Color picker for From and To message bubbles
- **Persistent conversations** — PM chats and unsent drafts survive page reloads
- **Works with DeepLore Enhanced** — No special integration needed; DeepLore's interceptor fires automatically during PM generation, providing Obsidian lorebook context

## Knowledge Modes

| Mode | PM sees world | Story sees PM | Use case |
|------|:---:|:---:|-----------|
| Isolated | Off | Off | Chat with a character outside the current story |
| PM-aware | On | Off | Ask a character about story events privately |
| Story-aware | Off | On | Story references PMs but PM character is out of the loop |
| Connected | On | On | Fully linked — immersive PM that both sides know about |

**Group chat bonus:** With "Story sees PM" on, only the target character's generation receives the PM transcript. Other characters in the group remain unaware — useful for secret messages.

## How It Works

### Generation

- **PM sees world ON**: Uses `generateQuietPrompt({ skipWIAN: false })` — the full SillyTavern pipeline runs, including World Info, lorebook, DeepLore Enhanced, and all other interceptors
- **PM sees world OFF**: Uses `generateQuietPrompt({ skipWIAN: true })` — World Info from the main chat is suppressed. An isolation framing instruction tells the AI to only use PM context. Character names in the PM still trigger DeepLore/lorebook entries

### Story Injection

When "Story sees PM" is enabled, the extension registers a `generate_interceptor` that injects the PM transcript into the main generation via `setExtensionPrompt()`. In group chats, injection is targeted — it checks `this_chid` against the To character so only that character's generation sees the PM.

## Prompt Template

The prompt template supports these placeholders:

| Placeholder | Description |
|-------------|-------------|
| `{{from}}` | From character name |
| `{{to}}` | To character name |
| `{{user}}` | Your SillyTavern username |
| `{{fromContext}}` | From character's card description (or WI instruction for typed names) |
| `{{toContext}}` | To character's card description (or WI instruction for typed names) |
| `{{storyContext}}` | Recent main chat messages (empty when PM sees world is off) |
| `{{pmHistory}}` | Formatted PM conversation history |

## Installation

1. Copy or symlink the `sillytavern-BurnerPhone` folder into:
   ```
   SillyTavern/public/scripts/extensions/third-party/sillytavern-BurnerPhone
   ```

2. Reload SillyTavern

3. The extension appears as:
   - A phone icon in the top settings bar
   - Its own slide-out panel (like AI Config or Character Manager)
   - Settings in the Extensions settings panel

## Usage

1. Click the phone icon in the top bar to open the BurnerPhone panel
2. **From** defaults to you. Change it to puppet another character
3. Type a character name in **To** (or pick from autocomplete suggestions)
4. Click the arrow button to start a conversation
5. Toggle knowledge modes per conversation as needed
6. Use the eye icon to inspect the last prompt sent

## Settings

Found in the Extensions settings panel under "BurnerPhone":

- **Defaults** — Default toggle states for new conversations
- **Generation** — PM message depth, main chat scan depth
- **Injection** — Position, depth, and role for main chat injection
- **Appearance** — From/To bubble colors with reset buttons
- **Prompt Template** — Full template editor with reset to default
- **Debug Mode** — Logs prompt and injection details to console

## Requirements

- SillyTavern (recent version with extension support)
- An active API connection configured in SillyTavern

## Compatibility

- Works in Firefox and Chrome (no browser-specific dependencies)
- Compatible with DeepLore Enhanced — lorebook entries activate automatically
- Compatible with group chats — targeted PM injection per character
