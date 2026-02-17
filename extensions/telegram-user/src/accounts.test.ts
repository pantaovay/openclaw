import { describe, expect, it, afterEach, vi } from "vitest";
import {
  listTelegramUserAccountIds,
  resolveDefaultTelegramUserAccountId,
  resolveTelegramUserAccountSync,
  isAccountConfigured,
} from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

const EMPTY_CFG = {} as OpenClawConfig;

function makeCfg(tgu: Record<string, unknown>): OpenClawConfig {
  return { channels: { "telegram-user": tgu } } as OpenClawConfig;
}

afterEach(() => {
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_USER_SESSION;
});

describe("listTelegramUserAccountIds", () => {
  it("returns ['default'] when no channel config", () => {
    expect(listTelegramUserAccountIds(EMPTY_CFG)).toEqual(["default"]);
  });

  it("returns ['default'] when no accounts object", () => {
    const cfg = makeCfg({ enabled: true });
    expect(listTelegramUserAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns sorted account ids from accounts object", () => {
    const cfg = makeCfg({
      accounts: {
        beta: { enabled: true },
        alpha: { enabled: true },
      },
    });
    expect(listTelegramUserAccountIds(cfg)).toEqual(["alpha", "beta"]);
  });

  it("filters out empty-string keys", () => {
    const cfg = makeCfg({
      accounts: {
        "": { enabled: true },
        valid: { enabled: true },
      },
    });
    expect(listTelegramUserAccountIds(cfg)).toEqual(["valid"]);
  });
});

describe("resolveDefaultTelegramUserAccountId", () => {
  it("returns 'default' when no config", () => {
    expect(resolveDefaultTelegramUserAccountId(EMPTY_CFG)).toBe("default");
  });

  it("uses defaultAccount when specified", () => {
    const cfg = makeCfg({ defaultAccount: "my-account" });
    expect(resolveDefaultTelegramUserAccountId(cfg)).toBe("my-account");
  });

  it("trims whitespace from defaultAccount", () => {
    const cfg = makeCfg({ defaultAccount: "  spaced  " });
    expect(resolveDefaultTelegramUserAccountId(cfg)).toBe("spaced");
  });

  it("returns first sorted account when no default specified and no 'default' key", () => {
    const cfg = makeCfg({
      accounts: {
        beta: { enabled: true },
        alpha: { enabled: true },
      },
    });
    expect(resolveDefaultTelegramUserAccountId(cfg)).toBe("alpha");
  });
});

describe("resolveTelegramUserAccountSync", () => {
  it("resolves config from top-level fields for default account", () => {
    const cfg = makeCfg({
      enabled: true,
      apiId: 12345,
      apiHash: "abc123",
      session: "session-string",
      dmPolicy: "pairing",
    });
    const result = resolveTelegramUserAccountSync({ cfg });
    expect(result.accountId).toBe("default");
    expect(result.apiId).toBe(12345);
    expect(result.apiHash).toBe("abc123");
    expect(result.session).toBe("session-string");
    expect(result.enabled).toBe(true);
    expect(result.config.dmPolicy).toBe("pairing");
  });

  it("merges account-level config over base config", () => {
    const cfg = makeCfg({
      enabled: true,
      apiId: 11111,
      apiHash: "base-hash",
      accounts: {
        custom: {
          apiId: 22222,
          session: "custom-session",
        },
      },
    });
    const result = resolveTelegramUserAccountSync({ cfg, accountId: "custom" });
    expect(result.accountId).toBe("custom");
    expect(result.apiId).toBe(22222);
    expect(result.apiHash).toBe("base-hash"); // inherited from base
    expect(result.session).toBe("custom-session");
  });

  it("uses env vars as fallback for API credentials", () => {
    process.env.TELEGRAM_API_ID = "99999";
    process.env.TELEGRAM_API_HASH = "env-hash";
    process.env.TELEGRAM_USER_SESSION = "env-session";
    const cfg = makeCfg({ enabled: true });
    const result = resolveTelegramUserAccountSync({ cfg });
    expect(result.apiId).toBe(99999);
    expect(result.apiHash).toBe("env-hash");
    expect(result.session).toBe("env-session");
  });

  it("config values take precedence over env vars", () => {
    process.env.TELEGRAM_API_ID = "99999";
    process.env.TELEGRAM_API_HASH = "env-hash";
    const cfg = makeCfg({
      enabled: true,
      apiId: 11111,
      apiHash: "config-hash",
    });
    const result = resolveTelegramUserAccountSync({ cfg });
    expect(result.apiId).toBe(11111);
    expect(result.apiHash).toBe("config-hash");
  });

  it("disabled when base enabled is false", () => {
    const cfg = makeCfg({ enabled: false, apiId: 1, apiHash: "x", session: "s" });
    const result = resolveTelegramUserAccountSync({ cfg });
    expect(result.enabled).toBe(false);
  });

  it("disabled when account enabled is false", () => {
    const cfg = makeCfg({
      enabled: true,
      accounts: {
        acct: { enabled: false, apiId: 1, apiHash: "x", session: "s" },
      },
    });
    const result = resolveTelegramUserAccountSync({ cfg, accountId: "acct" });
    expect(result.enabled).toBe(false);
  });

  it("normalizes null accountId to 'default'", () => {
    const cfg = makeCfg({ enabled: true });
    const result = resolveTelegramUserAccountSync({ cfg, accountId: null });
    expect(result.accountId).toBe("default");
  });
});

describe("isAccountConfigured", () => {
  it("returns true when all credentials present", () => {
    const account = resolveTelegramUserAccountSync({
      cfg: makeCfg({
        enabled: true,
        apiId: 12345,
        apiHash: "abc",
        session: "sess",
      }),
    });
    expect(isAccountConfigured(account)).toBe(true);
  });

  it("returns false when apiId is 0", () => {
    const account = resolveTelegramUserAccountSync({
      cfg: makeCfg({
        enabled: true,
        apiId: 0,
        apiHash: "abc",
        session: "sess",
      }),
    });
    expect(isAccountConfigured(account)).toBe(false);
  });

  it("returns false when apiHash is empty", () => {
    const account = resolveTelegramUserAccountSync({
      cfg: makeCfg({
        enabled: true,
        apiId: 12345,
        apiHash: "",
        session: "sess",
      }),
    });
    expect(isAccountConfigured(account)).toBe(false);
  });

  it("returns false when session is empty", () => {
    const account = resolveTelegramUserAccountSync({
      cfg: makeCfg({
        enabled: true,
        apiId: 12345,
        apiHash: "abc",
        session: "",
      }),
    });
    expect(isAccountConfigured(account)).toBe(false);
  });

  it("returns false when no credentials at all", () => {
    const account = resolveTelegramUserAccountSync({
      cfg: makeCfg({ enabled: true }),
    });
    expect(isAccountConfigured(account)).toBe(false);
  });
});
