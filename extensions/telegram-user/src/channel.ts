import type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelDock,
  ChannelPlugin,
  ChannelGroupContext,
  OpenClawConfig,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  deleteAccountFromConfigSection,
  formatAllowFromLowercase,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  resolveChannelAccountConfigBasePath,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";
import {
  listTelegramUserAccountIds,
  resolveDefaultTelegramUserAccountId,
  resolveTelegramUserAccountSync,
  isAccountConfigured,
} from "./accounts.js";
import { TelegramUserConfigSchema } from "./config-schema.js";
import { telegramUserOnboardingAdapter } from "./onboarding.js";
import { collectTelegramUserStatusIssues } from "./status-issues.js";
import {
  createTelegramUserClient,
  connectClient,
  disconnectClient,
  getSelfInfo,
  sendTextMessage,
  sendFileMessage,
  probeConnection,
  interactiveLogin,
} from "./client.js";
import { getClientPool } from "./pool.js";
import type { ResolvedTelegramUserAccount, TelegramUserSelfInfo } from "./types.js";
import { getTelegramUserRuntime } from "./runtime.js";

const meta = {
  id: "telegram-user",
  label: "Telegram Personal",
  selectionLabel: "Telegram (Personal Account)",
  docsPath: "/channels/telegram-user",
  docsLabel: "telegram-user",
  blurb: "Telegram personal account via MTProto user login.",
  aliases: ["tgu"],
  order: 86,
  quickstartAllowFrom: true,
};

function resolveGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveTelegramUserAccountSync({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();
  const candidates = [groupId, groupChannel, "*"].filter((value): value is string =>
    Boolean(value),
  );
  for (const key of candidates) {
    const entry = groups[key];
    if (entry?.tools) {
      return entry.tools;
    }
  }
  return undefined;
}

export const telegramUserDock: ChannelDock = {
  id: "telegram-user",
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4096 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTelegramUserAccountSync({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({
        allowFrom,
        stripPrefixRe: /^(telegram-user|telegram|tgu|tg):/i,
      }),
  },
  groups: {
    resolveRequireMention: () => true,
    resolveToolPolicy: resolveGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

export const telegramUserPlugin: ChannelPlugin<ResolvedTelegramUserAccount> = {
  id: "telegram-user",
  meta,
  onboarding: telegramUserOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.telegram-user"] },
  configSchema: buildChannelConfigSchema(TelegramUserConfigSchema),
  config: {
    listAccountIds: (cfg) => listTelegramUserAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTelegramUserAccountSync({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTelegramUserAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "telegram-user",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "telegram-user",
        accountId,
        clearBaseFields: [
          "apiId",
          "apiHash",
          "session",
          "phoneNumber",
          "name",
          "dmPolicy",
          "allowFrom",
          "groupPolicy",
          "groups",
          "messagePrefix",
          "responsePrefix",
        ],
      }),
    isConfigured: (account) => isAccountConfigured(account),
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTelegramUserAccountSync({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({
        allowFrom,
        stripPrefixRe: /^(telegram-user|telegram|tgu|tg):/i,
      }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = resolveChannelAccountConfigBasePath({
        cfg,
        channelKey: "telegram-user",
        accountId: resolvedAccountId,
      });
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("telegram-user"),
        normalizeEntry: (raw) => raw.replace(/^(telegram-user|telegram|tgu|tg):/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
    resolveToolPolicy: resolveGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^(telegram-user|telegram|tgu|tg):/i, "");
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        // Telegram IDs are numeric, may be negative for groups
        return /^-?\d{3,}$/.test(trimmed);
      },
      hint: "<chatId>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveTelegramUserAccountSync({ cfg, accountId });
      if (!isAccountConfigured(account)) {
        return null;
      }
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        const self = await getSelfInfo(client);
        return {
          kind: "user",
          id: self.userId,
          name: [self.firstName, self.lastName].filter(Boolean).join(" ") || undefined,
        } as ChannelDirectoryEntry;
      } finally {
        pool.release(client);
      }
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTelegramUserAccountSync({ cfg, accountId });
      if (!isAccountConfigured(account)) {
        throw new Error("Telegram User not configured");
      }
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        const dialogs = await client.getDialogs({ limit: limit ?? 100 });
        let peers = dialogs
          .filter((d) => !d.isGroup && !d.isChannel)
          .map(
            (d) =>
              ({
                kind: "user",
                id: String(d.id),
                name: d.name ?? undefined,
              }) as ChannelDirectoryEntry,
          );
        if (query?.trim()) {
          const q = query.trim().toLowerCase();
          peers = peers.filter(
            (p) =>
              (p.name ?? "").toLowerCase().includes(q) || p.id.includes(q),
          );
        }
        return typeof limit === "number" && limit > 0 ? peers.slice(0, limit) : peers;
      } finally {
        pool.release(client);
      }
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTelegramUserAccountSync({ cfg, accountId });
      if (!isAccountConfigured(account)) {
        throw new Error("Telegram User not configured");
      }
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        const dialogs = await client.getDialogs({ limit: limit ?? 100 });
        let groups = dialogs
          .filter((d) => d.isGroup || d.isChannel)
          .map(
            (d) =>
              ({
                kind: "group",
                id: String(d.id),
                name: d.name ?? undefined,
              }) as ChannelDirectoryEntry,
          );
        if (query?.trim()) {
          const q = query.trim().toLowerCase();
          groups = groups.filter(
            (g) =>
              (g.name ?? "").toLowerCase().includes(q) || g.id.includes(q),
          );
        }
        return typeof limit === "number" && limit > 0 ? groups.slice(0, limit) : groups;
      } finally {
        pool.release(client);
      }
    },
  },
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(telegram-user|telegram|tgu|tg):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveTelegramUserAccountSync({ cfg });
      if (!isAccountConfigured(account)) {
        throw new Error("Telegram User not configured");
      }
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        await sendTextMessage(client, id, "Your pairing request has been approved.");
      } finally {
        pool.release(client);
      }
    },
  },
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveTelegramUserAccountSync({
        cfg,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      });
      if (!account.apiId || !account.apiHash) {
        throw new Error(
          "Missing Telegram API credentials. Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars, " +
            "or add apiId/apiHash to channels.telegram-user in config.",
        );
      }
      runtime.log(
        `Starting Telegram user login (account: ${account.accountId}). ` +
          "You will be asked for your phone number and verification code.",
      );
      const session = await interactiveLogin({
        apiId: account.apiId,
        apiHash: account.apiHash,
        phoneNumber: account.phoneNumber,
      });
      // Save session to config
      const core = getTelegramUserRuntime();
      const nextCfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          "telegram-user": {
            ...(cfg.channels?.["telegram-user"] as Record<string, unknown> | undefined),
            enabled: true,
            session,
          },
        },
      } as OpenClawConfig;
      await core.config.writeConfigFile(nextCfg);
      runtime.log("Telegram User login successful. Session saved to config.");
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "telegram-user",
        accountId,
        name,
      }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "telegram-user",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "telegram-user",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            "telegram-user": {
              ...next.channels?.["telegram-user"],
              enabled: true,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          "telegram-user": {
            ...next.channels?.["telegram-user"],
            enabled: true,
            accounts: {
              ...(next.channels?.["telegram-user"] as Record<string, unknown> | undefined)
                ?.accounts,
              [accountId]: {
                ...((next.channels?.["telegram-user"] as Record<string, unknown> | undefined)
                  ?.accounts as Record<string, unknown> | undefined)?.[accountId],
                enabled: true,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 4096,
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveTelegramUserAccountSync({ cfg, accountId });
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        const result = await sendTextMessage(client, to, text);
        return {
          channel: "telegram-user",
          ok: result.ok,
          messageId: result.messageId ?? "",
          error: result.error ? new Error(result.error) : undefined,
        };
      } finally {
        pool.release(client);
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      if (!mediaUrl) {
        return { channel: "telegram-user" as const, ok: false, messageId: "", error: new Error("mediaUrl is required") };
      }
      const account = resolveTelegramUserAccountSync({ cfg, accountId });
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        const result = await sendFileMessage(client, to, mediaUrl, text);
        return {
          channel: "telegram-user",
          ok: result.ok,
          messageId: result.messageId ?? "",
          error: result.error ? new Error(result.error) : undefined,
        };
      } finally {
        pool.release(client);
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectTelegramUserStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!isAccountConfigured(account)) {
        return { ok: false, error: "Not configured" };
      }
      const pool = getClientPool();
      const client = await pool.acquire({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });
      try {
        return await probeConnection(client);
      } finally {
        pool.release(client);
      }
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dmPolicy ?? "pairing",
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      let userLabel = "";
      try {
        const pool = getClientPool();
        const client = await pool.acquire({
          apiId: account.apiId,
          apiHash: account.apiHash,
          session: account.session,
        });
        try {
          const self = await getSelfInfo(client);
          if (self.firstName || self.username) {
            userLabel = ` (${self.firstName ?? ""}${self.username ? ` @${self.username}` : ""})`;
          }
        } finally {
          pool.release(client);
        }
      } catch {
        // ignore probe errors
      }
      ctx.log?.info(`[${account.accountId}] starting telegram-user provider${userLabel}`);
      const { monitorTelegramUserProvider } = await import("./monitor.js");
      return monitorTelegramUserProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const core = getTelegramUserRuntime();
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextChannel = cfg.channels?.["telegram-user"]
        ? { ...(cfg.channels["telegram-user"] as Record<string, unknown>) }
        : undefined;
      let cleared = false;
      let changed = false;

      if (nextChannel) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextChannel.session) {
          delete nextChannel.session;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextChannel.accounts && typeof nextChannel.accounts === "object"
            ? { ...(nextChannel.accounts as Record<string, unknown>) }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("session" in nextEntry) {
              if (nextEntry.session) {
                cleared = true;
              }
              delete nextEntry.session;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextChannel.accounts;
            changed = true;
          } else {
            nextChannel.accounts = accounts;
          }
        }
      }

      if (changed) {
        if (nextChannel && Object.keys(nextChannel).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, "telegram-user": nextChannel };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels["telegram-user"];
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await core.config.writeConfigFile(nextCfg);
      }

      const resolved = resolveTelegramUserAccountSync({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = !resolved.session;

      return { cleared, loggedOut };
    },
  },
};

export type { ResolvedTelegramUserAccount };
