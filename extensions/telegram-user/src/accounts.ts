import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type {
  ResolvedTelegramUserAccount,
  TelegramUserAccountConfig,
  TelegramUserConfig,
} from "./types.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.["telegram-user"] as TelegramUserConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listTelegramUserAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTelegramUserAccountId(cfg: OpenClawConfig): string {
  const tguConfig = cfg.channels?.["telegram-user"] as TelegramUserConfig | undefined;
  if (tguConfig?.defaultAccount?.trim()) {
    return tguConfig.defaultAccount.trim();
  }
  const ids = listTelegramUserAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function mergeAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramUserAccountConfig {
  const raw = (cfg.channels?.["telegram-user"] ?? {}) as TelegramUserConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account =
    raw.accounts && typeof raw.accounts === "object"
      ? (raw.accounts[accountId] as TelegramUserAccountConfig | undefined)
      : undefined;
  return { ...base, ...account };
}

function resolveApiCredentials(
  config: TelegramUserAccountConfig,
): { apiId: number; apiHash: string } {
  const envApiId = process.env.TELEGRAM_API_ID?.trim();
  const envApiHash = process.env.TELEGRAM_API_HASH?.trim();
  const apiId = config.apiId ?? (envApiId ? Number(envApiId) : 0);
  const apiHash = config.apiHash ?? envApiHash ?? "";
  return { apiId, apiHash };
}

function resolveSession(config: TelegramUserAccountConfig): string {
  const envSession = process.env.TELEGRAM_USER_SESSION?.trim();
  return config.session ?? envSession ?? "";
}

export function resolveTelegramUserAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramUserAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.["telegram-user"] as TelegramUserConfig | undefined)?.enabled !== false;
  const merged = mergeAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const { apiId, apiHash } = resolveApiCredentials(merged);
  const session = resolveSession(merged);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    apiId,
    apiHash,
    session,
    phoneNumber: merged.phoneNumber?.trim() || undefined,
    config: merged,
  };
}

export function isAccountConfigured(account: ResolvedTelegramUserAccount): boolean {
  return Boolean(account.apiId && account.apiHash && account.session);
}
