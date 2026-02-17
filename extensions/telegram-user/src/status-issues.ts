import type { ChannelAccountSnapshot, ChannelStatusIssue } from "openclaw/plugin-sdk";

type TelegramUserAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
  lastError?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

function readAccountStatus(value: ChannelAccountSnapshot): TelegramUserAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    dmPolicy: value.dmPolicy,
    lastError: value.lastError,
  };
}

export function collectTelegramUserStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;
    const lastError = asString(account.lastError)?.trim();

    if (!configured) {
      if (lastError?.includes("apiId") || lastError?.includes("apiHash")) {
        issues.push({
          channel: "telegram-user",
          accountId,
          kind: "config",
          message: "Missing Telegram API credentials (apiId / apiHash).",
          fix: "Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars, or add apiId/apiHash to channels.telegram-user in config.",
        });
      } else if (lastError?.includes("session")) {
        issues.push({
          channel: "telegram-user",
          accountId,
          kind: "auth",
          message: "No session string configured.",
          fix: "Run: openclaw channels login --channel telegram-user",
        });
      } else {
        issues.push({
          channel: "telegram-user",
          accountId,
          kind: "auth",
          message: "Not configured or not authenticated.",
          fix: "Run: openclaw channels login --channel telegram-user",
        });
      }
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "telegram-user",
        accountId,
        kind: "config",
        message:
          'Telegram User dmPolicy is "open", allowing any user to message without pairing.',
        fix: 'Set channels.telegram-user.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }
  }
  return issues;
}
