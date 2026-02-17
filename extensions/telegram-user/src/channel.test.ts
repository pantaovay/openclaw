import { describe, expect, it } from "vitest";
import { telegramUserPlugin, telegramUserDock } from "./channel.js";

describe("telegramUser plugin meta", () => {
  it("has the correct channel id", () => {
    expect(telegramUserPlugin.id).toBe("telegram-user");
  });

  it("includes aliases", () => {
    expect(telegramUserPlugin.meta.aliases).toContain("tgu");
  });

  it("supports direct and group chat types", () => {
    expect(telegramUserPlugin.capabilities?.chatTypes).toEqual(["direct", "group"]);
  });
});

describe("telegramUser outbound chunker", () => {
  it("has a chunker function", () => {
    const chunker = telegramUserPlugin.outbound?.chunker;
    expect(chunker).toBeTypeOf("function");
  });

  it("chunks text respecting the 4096 limit", () => {
    const chunker = telegramUserPlugin.outbound?.chunker;
    if (!chunker) {
      return;
    }
    const limit = telegramUserPlugin.outbound?.textChunkLimit ?? 4096;
    const longText = "A".repeat(limit + 100);
    const chunks = chunker(longText, limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.every((c) => c.length <= limit)).toBe(true);
  });

  it("returns single chunk for short text", () => {
    const chunker = telegramUserPlugin.outbound?.chunker;
    if (!chunker) {
      return;
    }
    const chunks = chunker("hello world", 4096);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("hello world");
  });
});

describe("telegramUser dock", () => {
  it("has correct outbound text chunk limit", () => {
    expect(telegramUserDock.outbound?.textChunkLimit).toBe(4096);
  });

  it("supports direct and group chat types", () => {
    expect(telegramUserDock.capabilities?.chatTypes).toEqual(["direct", "group"]);
  });

  it("resolves requireMention to true", () => {
    expect(telegramUserDock.groups?.resolveRequireMention?.({} as never)).toBe(true);
  });
});

describe("telegramUser messaging normalizeTarget", () => {
  const normalizeTarget = telegramUserPlugin.messaging?.normalizeTarget;

  it("is defined", () => {
    expect(normalizeTarget).toBeTypeOf("function");
  });

  it("strips telegram-user: prefix", () => {
    if (!normalizeTarget) return;
    expect(normalizeTarget("telegram-user:12345")).toBe("12345");
  });

  it("strips tgu: prefix (case insensitive)", () => {
    if (!normalizeTarget) return;
    expect(normalizeTarget("TGU:12345")).toBe("12345");
  });

  it("strips telegram: prefix", () => {
    if (!normalizeTarget) return;
    expect(normalizeTarget("telegram:12345")).toBe("12345");
  });

  it("strips tg: prefix", () => {
    if (!normalizeTarget) return;
    expect(normalizeTarget("tg:12345")).toBe("12345");
  });

  it("passes through plain IDs unchanged", () => {
    if (!normalizeTarget) return;
    expect(normalizeTarget("12345")).toBe("12345");
  });

  it("returns undefined for empty input", () => {
    if (!normalizeTarget) return;
    expect(normalizeTarget("")).toBeUndefined();
    expect(normalizeTarget("  ")).toBeUndefined();
  });
});

describe("telegramUser messaging looksLikeId", () => {
  const looksLikeId = telegramUserPlugin.messaging?.targetResolver?.looksLikeId;

  it("is defined", () => {
    expect(looksLikeId).toBeTypeOf("function");
  });

  it("recognizes positive numeric ID", () => {
    if (!looksLikeId) return;
    expect(looksLikeId("123456789")).toBe(true);
  });

  it("recognizes negative group ID", () => {
    if (!looksLikeId) return;
    expect(looksLikeId("-1001234567890")).toBe(true);
  });

  it("rejects short numbers", () => {
    if (!looksLikeId) return;
    expect(looksLikeId("12")).toBe(false);
  });

  it("rejects non-numeric", () => {
    if (!looksLikeId) return;
    expect(looksLikeId("@username")).toBe(false);
  });

  it("rejects empty", () => {
    if (!looksLikeId) return;
    expect(looksLikeId("")).toBe(false);
    expect(looksLikeId("  ")).toBe(false);
  });
});
