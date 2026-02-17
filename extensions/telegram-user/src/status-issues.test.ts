import { describe, expect, it } from "vitest";
import { collectTelegramUserStatusIssues } from "./status-issues.js";

describe("collectTelegramUserStatusIssues", () => {
  it("flags missing API credentials when lastError mentions apiId", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
        lastError: "Missing apiId credential",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("config");
    expect(issues[0]?.message).toMatch(/apiId/i);
  });

  it("flags missing API credentials when lastError mentions apiHash", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
        lastError: "Missing apiHash",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("config");
    expect(issues[0]?.message).toMatch(/apiId.*apiHash/i);
  });

  it("flags missing session when lastError mentions session", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
        lastError: "No session string",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("auth");
    expect(issues[0]?.message).toMatch(/session/i);
  });

  it("flags generic not-configured when no specific error detail", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
        lastError: "something else went wrong",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("auth");
    expect(issues[0]?.message).toMatch(/not configured/i);
  });

  it("flags generic not-configured when no lastError at all", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("auth");
  });

  it("warns when dmPolicy is open", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("config");
    expect(issues[0]?.message).toMatch(/open/i);
  });

  it("skips disabled accounts", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: false,
        configured: false,
        lastError: "Missing apiId",
      },
    ]);
    expect(issues).toHaveLength(0);
  });

  it("returns no issues for configured account with pairing policy", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "pairing",
      },
    ]);
    expect(issues).toHaveLength(0);
  });

  it("handles multiple accounts", () => {
    const issues = collectTelegramUserStatusIssues([
      {
        accountId: "acct-a",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
      {
        accountId: "acct-b",
        enabled: true,
        configured: false,
        lastError: "No session string",
      },
      {
        accountId: "acct-c",
        enabled: false,
        configured: false,
      },
    ]);
    // acct-a: open dmPolicy issue, acct-b: auth issue, acct-c: skipped
    expect(issues).toHaveLength(2);
    expect(issues[0]?.accountId).toBe("acct-a");
    expect(issues[1]?.accountId).toBe("acct-b");
  });

  it("returns empty for empty accounts array", () => {
    const issues = collectTelegramUserStatusIssues([]);
    expect(issues).toHaveLength(0);
  });
});
