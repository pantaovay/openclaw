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

Select "Telegram (Personal Account)" when prompted. The wizard will guide you through entering API credentials and logging in with your phone number. API credentials, session, and all settings are automatically saved to your config file.

### Option 2: Manual Setup

1. Add your API credentials to the config file (`~/.openclaw/openclaw.json`):

```json
{
  "channels": {
    "telegram-user": {
      "apiId": 12345678,
      "apiHash": "abcdef0123456789abcdef0123456789"
    }
  }
}
```

Alternatively, set environment variables as a fallback:

```bash
export TELEGRAM_API_ID=12345678
export TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
```

2. Enable the plugin:

```bash
openclaw plugins enable telegram-user
```

3. Run the channel login:

```bash
openclaw channels login --channel telegram-user
```

4. Enter your phone number and the verification code sent to your Telegram app. On success, the session string and API credentials are saved to your config file automatically.

5. Start the gateway:

```bash
openclaw gateway --verbose
```

## Configuration

Configuration lives in your OpenClaw config file (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "telegram-user": {
        "enabled": true
      }
    }
  },
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

> **Note:** The `plugins.entries.telegram-user.enabled` field is required to load the plugin. The `channels.telegram-user` section stores your credentials and channel settings. Both must be present.

### Environment Variables

| Variable                | Description                                   |
| ----------------------- | --------------------------------------------- |
| `TELEGRAM_API_ID`       | Telegram API ID (fallback if not in config)   |
| `TELEGRAM_API_HASH`     | Telegram API Hash (fallback if not in config) |
| `TELEGRAM_USER_SESSION` | Session string (fallback if not in config)    |

Environment variables serve as fallbacks only. The recommended approach is to store credentials in the config file (they are saved automatically during login).

### DM Policy Options

| Policy              | Behavior                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `pairing` (default) | Unknown senders get a pairing code; approve with `openclaw pairing approve` |
| `allowlist`         | Only senders in `allowFrom` list can message                                |
| `open`              | Anyone can message (requires `allowFrom: ["*"]`)                            |
| `disabled`          | All DMs are ignored                                                         |

> **Note:** When using `dmPolicy: "open"`, you must also set `"allowFrom": ["*"]` in the channel config. Run `openclaw doctor --fix` to add it automatically.

### Group Policy Options

| Policy           | Behavior                                         |
| ---------------- | ------------------------------------------------ |
| `open` (default) | Respond in all groups                            |
| `allowlist`      | Only respond in groups listed in `groups` config |
| `disabled`       | Ignore all group messages                        |

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

| Action     | Description                            | Required Params     | Optional Params   |
| ---------- | -------------------------------------- | ------------------- | ----------------- |
| `send`     | Send a text message                    | `chatId`, `message` | `replyToMsgId`    |
| `history`  | Read chat history                      | `chatId`            | `limit`           |
| `contacts` | List DM contacts                       | —                   | `query`, `limit`  |
| `dialogs`  | List all chats (DMs, groups, channels) | —                   | `limit`           |
| `search`   | Search messages globally or in a chat  | `query`             | `chatId`, `limit` |
| `me`       | Get authenticated user info            | —                   | —                 |
| `status`   | Check connection status                | —                   | —                 |

The `limit` parameter defaults to 20–50 depending on the action and is capped at 200.

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

### "Unsupported channel: telegram-user"

The plugin is not loaded. Enable it first:

```bash
openclaw plugins enable telegram-user
```

### "Missing Telegram API credentials"

Add `apiId` and `apiHash` to your config file under `channels.telegram-user`, or set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` environment variables as fallback.

### "Not configured or not authenticated"

The session string or API credentials are missing from config. Re-run login:

```bash
openclaw channels login --channel telegram-user
```

Login now saves `apiId`, `apiHash`, and `session` to your config file automatically.

### Not receiving messages

1. Check that `dmPolicy` is set correctly. If using `"open"`, you must also set `"allowFrom": ["*"]`. Run `openclaw doctor --fix` to add it.
2. Verify the gateway log shows `[telegram-user] [default] connected as ...`. If not, the plugin is not loaded or not configured.
3. Messages must be **text** (not stickers, images, or media-only) and from a **different account** (self-messages are filtered).

### "FloodWaitError" from Telegram

Telegram rate-limits API calls. Wait the specified duration before retrying. Reduce message frequency if this recurs.

### Session expired / "AUTH_KEY_UNREGISTERED"

Your session was invalidated (e.g., you logged out from another client). Re-login:

```bash
openclaw channels login --channel telegram-user
```

### Connection keeps reconnecting

Check your network. The plugin retries every 10 seconds on connection failure. Verify your API credentials are correct with `openclaw doctor`.
