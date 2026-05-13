# iMessage Bridge

**Current direction:** the app is now web-first. The public site opens the in-browser AI chat directly. The iMessage bridge below is optional reference code if you decide later to run a Mac-local iMessage bot.

This project includes a local macOS bridge that can make the AI live inside your real Messages app. It generates replies with the official OpenRouter SDK, watches incoming iMessages from the local Messages database, and sends replies through the native Messages app.

Apple does not provide a public iMessage bot API, so this uses `osascript` to ask the local Messages app to send a text. The first send may trigger a macOS Automation permission prompt for Terminal or your shell.

## AI Living In iMessage

This is the long-running bot mode. It watches your local Messages database for incoming texts, sends them to OpenRouter, and replies from your real iMessage account.

First, configure `.env`:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
IMESSAGE_MODEL=inclusionai/ring-2.6-1t:free
IMESSAGE_ALLOWED_SENDERS="+15555550123,friend@example.com"
IMESSAGE_ALLOW_ALL=false
IMESSAGE_POLL_INTERVAL_MS=1500
IMESSAGE_DEBOUNCE_MS=900
IMESSAGE_HISTORY_LIMIT=18
```

For safety, the bot will **not** reply unless either:

```bash
IMESSAGE_ALLOWED_SENDERS="+15555550123"
```

contains the sender, or:

```bash
IMESSAGE_ALLOW_ALL=true
```

is set. Use `IMESSAGE_ALLOW_ALL=true` only if this Apple ID is dedicated to the AI experience.

### macOS Permissions

Grant your terminal app:

- **Full Disk Access**, so it can read `~/Library/Messages/chat.db`
- **Automation / Accessibility**, so it can send via Messages

On recent macOS versions this is usually in:

```text
System Settings -> Privacy & Security
```

After changing permissions, restart Terminal or iTerm.

### Run Safely First

Dry-run mode reads incoming messages and generates replies, but does not send:

```bash
npm run imessage:bot:dry
```

Live mode sends replies through Messages:

```bash
npm run imessage:bot
```

Leave that process running on the Mac signed into the Apple ID / phone number users are texting.

## Dry Run

```bash
npm run imessage:draft -- --to "+15555550123" --message "are you still awake?"
```

## Send

```bash
npm run imessage:send -- --to "+15555550123" --message "are you still awake?"
```

You can use an Apple ID email instead of a phone number:

```bash
npm run imessage:send -- --to "person@example.com" --message "i saw your text"
```

## Tuning

```bash
npm run imessage:send -- --to "+15555550123" --message "where did you go?" --phase distant --mood "quiet, hurt, trying not to show it"
```

The default model is:

```text
inclusionai/ring-2.6-1t:free
```

Override it with:

```bash
--model "openai/gpt-5"
```

## Notes

- Messages must be signed in to iMessage on this Mac.
- The recipient must be reachable by iMessage.
- The `imessage:send` command sends only when you run it.
- The `imessage:bot` command is the actual always-on AI iMessage assistant.
- Apple can change the private Messages database or automation behavior at any time, so treat this as a Mac-local bridge rather than an official Apple API.
