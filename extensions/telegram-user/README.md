# @openclaw/telegram-user

OpenClaw extension for Telegram Personal Account messaging via [GramJS](https://gram.js.org/) (MTProto 2.0).

> **Warning:** This extension logs into Telegram as your personal account using the MTProto protocol. Treat your session string as a password. Never commit it to version control.

## Features

- **MTProto User Login**: Authenticate with your phone number and verification code (no bot token needed)
- **Channel Plugin Integration**: Appears in the onboarding wizard with interactive MTProto login
- **Gateway Integration**: Real-time message listening via persistent MTProto connection
- **Connection Pool**: Reuses TCP connections across outbound operations (5-minute idle TTL)
- **Multi-Account Support**: Manage multiple Telegram personal accounts
- **Agent Tool**: 7 actions — send, history, contacts, dialogs, search, me, status
- **DM Policy / Pairing**: Control who can message your assistant (pairing, allowlist, open, disabled)
- **Group Support**: Configurable group access with allowlist, mention gating, and per-group tool policies

## Prerequisites

1. **Node.js >= 22** (required by OpenClaw)
2. **Telegram API credentials** from [my.telegram.org/apps](https://my.telegram.org/apps):
   - Create a new application
   - Note your **API ID** (numeric) and **API Hash** (hex string)

## Quick Start

### Option 1: Onboarding Wizard (Recommended)

```bash
openclaw onboard
```

Select "Telegram (Personal Account)" when prompted. The wizard will guide you through entering API credentials and logging in with your phone number.

### Option 2: Manual Setup

1. Set environment variables:

```bash
export TELEGRAM_API_ID=12345678
export TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
```

2. Run the channel login:

```bash
openclaw channels login --channel telegram-user
```

3. Enter your phone number and the verification code sent to your Telegram app.

4. Start the gateway:

```bash
openclaw gateway --verbose
```

## Configuration

Configuration lives in your OpenClaw config file (`~/.openclaw/openclaw.json`):

```json
{
  "channels": {
    "telegram-user": {
      "enabled": true,
      "apiId": 12345678,
      "apiHash": "your-api-hash",
      "session": "auto-saved-after-login",
      "dmPolicy": "pairing",
      "groupPolicy": "open"
    }
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_API_ID` | Telegram API ID (fallback if not in config) |
| `TELEGRAM_API_HASH` | Telegram API Hash (fallback if not in config) |
| `TELEGRAM_USER_SESSION` | Session string (fallback if not in config) |

### DM Policy Options

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Unknown senders get a pairing code; approve with `openclaw pairing approve` |
| `allowlist` | Only senders in `allowFrom` list can message |
| `open` | Anyone can message (use with caution) |
| `disabled` | All DMs are ignored |

### Group Policy Options

| Policy | Behavior |
|--------|----------|
| `open` (default) | Respond in all groups |
| `allowlist` | Only respond in groups listed in `groups` config |
| `disabled` | Ignore all group messages |

## Multi-Account Support

```json
{
  "channels": {
    "telegram-user": {
      "enabled": true,
      "defaultAccount": "personal",
      "accounts": {
        "personal": {
          "apiId": 12345678,
          "apiHash": "hash-1",
          "session": "session-1"
        },
        "work": {
          "apiId": 87654321,
          "apiHash": "hash-2",
          "session": "session-2"
        }
      }
    }
  }
}
```

## Agent Tool

The agent tool provides 7 actions:

| Action | Description | Required Params |
|--------|-------------|-----------------|
| `send` | Send a text message | `chatId`, `message` |
| `history` | Read chat history | `chatId` |
| `contacts` | List DM contacts | — |
| `dialogs` | List all chats (DMs, groups, channels) | — |
| `search` | Search messages globally or in a chat | `query` |
| `me` | Get authenticated user info | — |
| `status` | Check connection status | — |

## Templates

The extension ships with template files in `templates/`:

- **SOUL.md** — Agent personality and behavior guide
- **HEARTBEAT.md** — Periodic maintenance task checklist

These are automatically copied to `~/.openclaw/telegram-user/` on first login. Edit them to customize your assistant's personality and scheduled tasks.

## Testing

```bash
# Run all telegram-user tests
pnpm vitest run extensions/telegram-user/

# Run specific test file
pnpm vitest run extensions/telegram-user/src/accounts.test.ts

# Watch mode
pnpm vitest watch extensions/telegram-user/
```

## Troubleshooting

### "Missing Telegram API credentials"

Set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` environment variables, or add `apiId`/`apiHash` to your config.

### "No session string configured"

Run `openclaw channels login --channel telegram-user` to complete the MTProto login flow.

### "FloodWaitError" from Telegram

Telegram rate-limits API calls. Wait the specified duration before retrying. Reduce message frequency if this recurs.

### Session expired / "AUTH_KEY_UNREGISTERED"

Your session was invalidated (e.g., you logged out from another client). Re-login:

```bash
openclaw channels login --channel telegram-user
```

### Connection keeps reconnecting

Check your network. The plugin retries every 10 seconds on connection failure. Verify your API credentials are correct with `openclaw doctor`.
