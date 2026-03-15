# Changelog

## v0.7.0

### Context Mode Rework
- **4-mode system** — replaces old 3-mode `pmContextMode` + separate `storySeesPm` toggle:
  - **Isolated**: Character cards + character-name-only lore scan. No PM-triggered lore, no main chat context.
  - **Lore Only**: Character cards + lore triggered by PM messages + character names. No main chat context.
  - **Lore + Context** (new): Character cards + main chat messages in prompt + lore triggered by PM + main chat + character names.
  - **Full**: Same as Lore + Context, plus PMs injected into main story generation (bidirectional).
- **`storySeesPm` removed** — functionality folded into Full mode. Migration auto-converts existing conversations.
- **Character-name lore in all modes** — character names are always included in DeepLore/WI scan text, ensuring characters without cards but with lorebook entries get their info in every mode.
- **`skipWIAN: false` for all modes** — ST's built-in World Info always scans the prompt, finding character entries even in isolated mode.

### Unread Badge Tracking
- **Per-conversation unread count** — badge shows total unread messages across all conversations, not total messages.
- **`lastReadCount` tracking** — each conversation tracks how many messages have been read.
- **Mark as read** — conversations marked read when opened or switched to; badge clears accordingly.
- **Per-tab unread labels** — conversation list shows "(N new)" for conversations with unread messages.

### Bug Fixes
- **Picker dropdown opacity** — character picker dropdown now uses `--SmartThemeBGColor` (opaque) instead of `--SmartThemeBlurTintColor` (semi-transparent).

### Migration
- Existing conversations with `storySeesPm: true` → mode set to `full`.
- Old `full` mode without `storySeesPm` → mapped to `lore-context`.
- Existing conversations get `lastReadCount = messages.length` to avoid spurious badge on upgrade.

## v0.6.0

### Bug Fixes
- **Race condition in handleRegenerate** — no longer mutates conversation in-place; uses a temporary copy so the original is safe if prompt building fails
- **isGenerating flag can get stuck** — added 120s safety timeout that auto-resets, plus a cancel button
- **Dangling user messages on failed generation** — messages now have a `pending` flag; failed sends show retry/delete UI instead of leaving orphaned messages
- **Conversation key collision** — switched from `::` to `\x1F` (unit separator) for conversation keys; character names containing `::` no longer break key parsing. Auto-migration runs at init

### Robustness
- **DeepLore errors surface to user** — `toastr.warning` on DeepLore fetch errors instead of silent console-only logging
- **Ghost conversation detection** — orphaned conversations from deleted characters get `.bp-orphaned` styling (dimmed + warning icon)
- **Group chat null guard** — if a character card is deleted, injection is safely cleared instead of falling through to the wrong character
- **DeepLore lore matching for typed characters** — character names (From and To) are prepended to DeepLore scan text so lore entries keyed to those names always match

### Code Quality
- **Consistent avatar lookup** — `getCharAvatarUrl()` now accepts identity objects and uses `findCharacterCard()` consistently
- **Swipes initialized on all new AI messages** — `swipes` array and `swipe_id` set on message creation, not just after first regenerate
- **Console.log cleanup** — all non-error `console.log` calls replaced with `debug()` helper
- **Shared generation core** — extracted `generateResponse()` eliminating ~60 lines of duplicated logic between `sendPmMessage` and `handleRegenerate`

### Features
- **Character picker with avatars** — replaced datalist inputs with custom dropdown showing avatar thumbnails + names; personas listed in "From" field, characters in both
- **Auto-populate To field** — when opening BurnerPhone with no active conversation, "To" auto-fills with the current active character
- **Regenerate any AI message** — regen button on all AI messages, not just the last one; mid-conversation regen truncates with user confirmation
- **Cancel generation** — cancel button replaces send button during generation; response is discarded on cancel
- **Swipe-right to regenerate** — swiping right past the last swipe on the last AI message triggers regeneration
- **Date separators** — optional date dividers between messages (display only, not sent to AI); toggle in settings
- **Export/Import conversations** — export active conversation as JSON, import from file; format includes version, participants, messages, and settings
- **Drawer badge** — total message count across all conversations shown on the drawer icon
- **PM Context Mode** — expanded from binary toggle to three modes: Isolated, Lore, Full

## v0.5.0

- Initial release
- From/To private messaging with character cards or typed names
- PM sees world / Story sees PM knowledge toggles
- Group chat targeted injection
- Editable prompt template with placeholders
- Customizable bubble colors
- Persistent conversations in extension settings
- DeepLore Enhanced compatibility
- Context viewer popup
