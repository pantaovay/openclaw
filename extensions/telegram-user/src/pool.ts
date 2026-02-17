import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

export type PoolClientOptions = {
  apiId: number;
  apiHash: string;
  session: string;
};

type PoolEntry = {
  client: TelegramClient;
  key: string;
  lastUsed: number;
  inUse: boolean;
};

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POOL_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

function makeKey(opts: PoolClientOptions): string {
  return `${opts.apiId}:${opts.apiHash}:${opts.session}`;
}

class TelegramClientPool {
  private entries: PoolEntry[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), POOL_CHECK_INTERVAL_MS);
    // Allow the process to exit even if the timer is running
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === "object" &&
      "unref" in this.cleanupTimer
    ) {
      this.cleanupTimer.unref();
    }
  }

  async acquire(opts: PoolClientOptions): Promise<TelegramClient> {
    const key = makeKey(opts);

    // Reuse an idle client with the same key
    const existing = this.entries.find((e) => e.key === key && !e.inUse);
    if (existing) {
      existing.inUse = true;
      existing.lastUsed = Date.now();
      // Verify the client is still connected
      if (existing.client.connected) {
        return existing.client;
      }
      // Reconnect if disconnected
      try {
        await existing.client.connect();
        return existing.client;
      } catch {
        // Remove stale entry and create a new one
        this.remove(existing);
      }
    }

    // Create a new client
    const stringSession = new StringSession(opts.session);
    const client = new TelegramClient(stringSession, opts.apiId, opts.apiHash, {
      connectionRetries: 3,
    });
    await client.connect();

    const entry: PoolEntry = {
      client,
      key,
      lastUsed: Date.now(),
      inUse: true,
    };
    this.entries.push(entry);

    return client;
  }

  release(client: TelegramClient): void {
    const entry = this.entries.find((e) => e.client === client);
    if (entry) {
      entry.inUse = false;
      entry.lastUsed = Date.now();
    }
    // Do NOT disconnect here - keep the connection alive for reuse
  }

  private remove(entry: PoolEntry): void {
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
    }
    try {
      entry.client.disconnect().catch(() => {});
    } catch {
      // ignore
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const stale = this.entries.filter((e) => !e.inUse && now - e.lastUsed > IDLE_TIMEOUT_MS);
    for (const entry of stale) {
      this.remove(entry);
    }
  }

  async destroyAll(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const all = [...this.entries];
    this.entries = [];
    await Promise.allSettled(all.map((e) => e.client.disconnect().catch(() => {})));
  }

  get size(): number {
    return this.entries.length;
  }

  get activeCount(): number {
    return this.entries.filter((e) => e.inUse).length;
  }
}

let pool: TelegramClientPool | null = null;

export function getClientPool(): TelegramClientPool {
  if (!pool) {
    pool = new TelegramClientPool();
  }
  return pool;
}

export async function destroyClientPool(): Promise<void> {
  if (pool) {
    await pool.destroyAll();
    pool = null;
  }
}
