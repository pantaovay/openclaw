import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the telegram module before importing pool
vi.mock("telegram", () => ({
  TelegramClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    connected: true,
  })),
}));

vi.mock("telegram/sessions/index.js", () => ({
  StringSession: vi.fn().mockImplementation((session: string) => ({ session })),
}));

import { getClientPool, destroyClientPool } from "./pool.js";

const OPTS = {
  apiId: 12345,
  apiHash: "abc123",
  session: "test-session-string",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await destroyClientPool();
});

describe("TelegramClientPool", () => {
  it("acquires a client", async () => {
    const pool = getClientPool();
    const client = await pool.acquire(OPTS);
    expect(client).toBeDefined();
    expect(client.connected).toBe(true);
    expect(pool.size).toBe(1);
    expect(pool.activeCount).toBe(1);
    pool.release(client);
  });

  it("reuses an idle client with the same key", async () => {
    const pool = getClientPool();
    const client1 = await pool.acquire(OPTS);
    pool.release(client1);
    expect(pool.activeCount).toBe(0);

    const client2 = await pool.acquire(OPTS);
    expect(client2).toBe(client1); // same instance reused
    expect(pool.size).toBe(1);
    pool.release(client2);
  });

  it("creates a new client for different keys", async () => {
    const pool = getClientPool();
    const client1 = await pool.acquire(OPTS);
    const client2 = await pool.acquire({
      ...OPTS,
      apiId: 99999,
    });
    expect(client1).not.toBe(client2);
    expect(pool.size).toBe(2);
    pool.release(client1);
    pool.release(client2);
  });

  it("does not reuse in-use clients", async () => {
    const pool = getClientPool();
    const client1 = await pool.acquire(OPTS);
    // Do not release client1
    const client2 = await pool.acquire(OPTS);
    expect(client1).not.toBe(client2);
    expect(pool.size).toBe(2);
    expect(pool.activeCount).toBe(2);
    pool.release(client1);
    pool.release(client2);
  });

  it("tracks size and activeCount correctly", async () => {
    const pool = getClientPool();
    expect(pool.size).toBe(0);
    expect(pool.activeCount).toBe(0);

    const c1 = await pool.acquire(OPTS);
    expect(pool.size).toBe(1);
    expect(pool.activeCount).toBe(1);

    pool.release(c1);
    expect(pool.size).toBe(1);
    expect(pool.activeCount).toBe(0);
  });

  it("destroyAll clears all entries", async () => {
    const pool = getClientPool();
    await pool.acquire(OPTS);
    expect(pool.size).toBe(1);

    await pool.destroyAll();
    expect(pool.size).toBe(0);
    expect(pool.activeCount).toBe(0);
  });
});

describe("destroyClientPool", () => {
  it("resets the singleton pool", async () => {
    const pool1 = getClientPool();
    await pool1.acquire(OPTS);
    expect(pool1.size).toBe(1);

    await destroyClientPool();
    const pool2 = getClientPool();
    // After destroy, a fresh pool is created
    expect(pool2.size).toBe(0);
  });
});
