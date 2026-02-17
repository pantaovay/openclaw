import type { OpenClawConfig, MarkdownTableMode, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  resolveSenderCommandAuthorization,
} from "openclaw/plugin-sdk";
import { getTelegramUserRuntime } from "./runtime.js";
import {
  createTelegramUserClient,
  connectClient,
  disconnectClient,
  getSelfInfo,
  setupMessageListener,
  sendTextMessage,
} from "./client.js";
import type { ResolvedTelegramUserAccount, TelegramUserMessage } from "./types.js";
import type { TelegramClient } from "telegram";

export type TelegramUserMonitorOptions = {
  account: ResolvedTelegramUserAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type TelegramUserMonitorResult = {
  stop: () => void;
};

const TELEGRAM_TEXT_LIMIT = 4096;

function normalizeTelegramUserEntry(entry: string): string {
  return entry.replace(/^(telegram-user|telegram|tgu|tg):/i, "").trim();
}

type TelegramUserCoreRuntime = ReturnType<typeof getTelegramUserRuntime>;

function logVerbose(core: TelegramUserCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[telegram-user] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(telegram-user|telegram|tgu|tg):/i, "");
    return normalized === normalizedSenderId;
  });
}

function isGroupAllowed(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { allow?: boolean; enabled?: boolean }>;
}): boolean {
  const groups = params.groups ?? {};
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    return false;
  }
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (!entry) {
      continue;
    }
    return entry.allow !== false && entry.enabled !== false;
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return wildcard.allow !== false && wildcard.enabled !== false;
  }
  return false;
}

async function processMessage(
  message: TelegramUserMessage,
  account: ResolvedTelegramUserAccount,
  config: OpenClawConfig,
  core: TelegramUserCoreRuntime,
  runtime: RuntimeEnv,
  client: TelegramClient,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const { chatId, text, timestamp, senderId, senderName, isGroup, isChannel, groupName } = message;
  if (!text?.trim()) {
    return;
  }

  // Skip channel messages (broadcasts) - only process DMs and groups
  if (isChannel) {
    logVerbose(core, runtime, `telegram-user: skip channel message from ${chatId}`);
    return;
  }

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
  const groups = account.config.groups ?? {};
  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `telegram-user: drop group ${chatId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      const allowed = isGroupAllowed({ groupId: chatId, groupName, groups });
      if (!allowed) {
        logVerbose(core, runtime, `telegram-user: drop group ${chatId} (not allowlisted)`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const rawBody = text.trim();
  const { senderAllowedForCommands, commandAuthorized } = await resolveSenderCommandAuthorization({
    cfg: config,
    rawBody,
    isGroup,
    dmPolicy,
    configuredAllowFrom: configAllowFrom,
    senderId,
    isSenderAllowed,
    readAllowFromStore: () => core.channel.pairing.readAllowFromStore("telegram-user"),
    shouldComputeCommandAuthorized: (body, cfg) =>
      core.channel.commands.shouldComputeCommandAuthorized(body, cfg),
    resolveCommandAuthorizedFromAuthorizers: (params) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
  });

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked telegram-user DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "telegram-user",
            id: senderId,
            meta: { name: senderName || undefined },
          });

          if (created) {
            logVerbose(core, runtime, `telegram-user pairing request sender=${senderId}`);
            try {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: "telegram-user",
                idLine: `Your Telegram user id: ${senderId}`,
                code,
              });
              await sendTextMessage(client, chatId, pairingReply);
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `telegram-user pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized telegram-user sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(
      core,
      runtime,
      `telegram-user: drop control command from unauthorized sender ${senderId}`,
    );
    return;
  }

  const peer = isGroup
    ? { kind: "group" as const, id: chatId }
    : { kind: "group" as const, id: senderId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "telegram-user",
    accountId: account.accountId,
    peer: {
      kind: peer.kind,
      id: peer.id,
    },
  });

  const fromLabel = isGroup
    ? `group:${groupName || chatId}`
    : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Telegram Personal",
    from: fromLabel,
    timestamp: timestamp ? timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `telegram-user:group:${chatId}` : `telegram-user:${senderId}`,
    To: `telegram-user:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "telegram-user",
    Surface: "telegram-user",
    MessageSid: String(message.messageId),
    OriginatingChannel: "telegram-user",
    OriginatingTo: `telegram-user:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`telegram-user: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "telegram-user",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverTelegramUserReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          client,
          chatId,
          isGroup,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          tableMode: core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "telegram-user",
            accountId: account.accountId,
          }),
        });
      },
      onError: (err, info) => {
        runtime.error(
          `[${account.accountId}] Telegram User ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverTelegramUserReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  client: TelegramClient;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: TelegramUserCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, client, chatId, runtime, core, config, accountId, statusSink } = params;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    const { sendFileMessage } = await import("./client.js");
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      first = false;
      try {
        logVerbose(core, runtime, `Sending media to ${chatId}`);
        await sendFileMessage(client, chatId, mediaUrl, caption);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`Telegram User media send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "telegram-user", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      TELEGRAM_TEXT_LIMIT,
      chunkMode,
    );
    logVerbose(core, runtime, `Sending ${chunks.length} text chunk(s) to ${chatId}`);
    for (const chunk of chunks) {
      try {
        await sendTextMessage(client, chatId, chunk);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`Telegram User message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorTelegramUserProvider(
  options: TelegramUserMonitorOptions,
): Promise<TelegramUserMonitorResult> {
  const { account, config, abortSignal, statusSink, runtime } = options;

  const core = getTelegramUserRuntime();
  let stopped = false;
  let client: TelegramClient | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveRunning: (() => void) | null = null;

  const stop = () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (client) {
      disconnectClient(client).catch((err) => {
        runtime.error(`[${account.accountId}] disconnect error: ${String(err)}`);
      });
      client = null;
    }
    resolveRunning?.();
  };

  const startListener = async () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    try {
      logVerbose(
        core,
        runtime,
        `[${account.accountId}] starting GramJS client (MTProto)`,
      );

      client = await createTelegramUserClient({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });

      await connectClient(client);
      const self = await getSelfInfo(client);

      logVerbose(
        core,
        runtime,
        `[${account.accountId}] connected as ${self.firstName ?? ""} ${self.lastName ?? ""} (@${self.username ?? "?"})`,
      );

      setupMessageListener(client, self.userId, (msg) => {
        logVerbose(core, runtime, `[${account.accountId}] inbound message from ${msg.senderId}`);
        statusSink?.({ lastInboundAt: Date.now() });
        processMessage(msg, account, config, core, runtime, client!, statusSink).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
        });
      });
    } catch (err) {
      runtime.error(`[${account.accountId}] GramJS connection error: ${String(err)}`);
      if (!stopped && !abortSignal.aborted) {
        logVerbose(core, runtime, `[${account.accountId}] reconnecting in 10s...`);
        restartTimer = setTimeout(() => {
          startListener().catch((e) => {
            runtime.error(`[${account.accountId}] restart failed: ${String(e)}`);
          });
        }, 10000);
      } else {
        resolveRunning?.();
      }
    }
  };

  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
    abortSignal.addEventListener("abort", () => {
      stop();
      resolve();
    }, { once: true });
  });

  await startListener();
  await runningPromise;

  return { stop };
}
