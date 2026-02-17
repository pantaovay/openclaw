import type { OpenClawConfig, MarkdownTableMode, RuntimeEnv } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions, resolveSenderCommandAuthorization } from "openclaw/plugin-sdk";
import type { TelegramClient } from "telegram";
import {
  createTelegramUserClient,
  connectClient,
  disconnectClient,
  destroyClient,
  getSelfInfo,
  setupMessageListener,
  sendTextMessage,
  sendFileMessage,
} from "./client.js";
import { getTelegramUserRuntime } from "./runtime.js";
import type { ResolvedTelegramUserAccount, TelegramUserMessage } from "./types.js";

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

type TelegramUserCoreRuntime = ReturnType<typeof getTelegramUserRuntime>;

function logVerbose(core: TelegramUserCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[telegram-user] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[], senderUsername?: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  const normalizedUsername = senderUsername?.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(telegram-user|telegram|tgu|tg):/i, "");
    if (normalized === normalizedSenderId) {
      return true;
    }
    // Also match by username (onboarding stores usernames without @)
    if (normalizedUsername && normalized === normalizedUsername) {
      return true;
    }
    return false;
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
  const candidates = [params.groupId, `group:${params.groupId}`, params.groupName ?? ""].filter(
    Boolean,
  );
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
  const {
    chatId,
    text,
    timestamp,
    senderId,
    senderName,
    senderUsername,
    isGroup,
    isChannel,
    groupName,
  } = message;
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
    isSenderAllowed: (sid, af) => isSenderAllowed(sid, af, senderUsername),
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
              const pairingResult = await sendTextMessage(client, chatId, pairingReply);
              if (pairingResult.ok) {
                statusSink?.({ lastOutboundAt: Date.now() });
              }
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

  // Use "group" kind for both branches to avoid dmScope=main collapsing all DMs
  // into the main session. This ensures each DM sender gets their own session.
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

  const fromLabel = isGroup ? `group:${groupName || chatId}` : senderName || `user:${senderId}`;

  // Build body with quoted message context if replying to a message
  let bodyForAgent = rawBody;
  if (message.quotedText) {
    const quotedFrom = message.quotedSenderName ?? "someone";
    bodyForAgent = `[Replying to ${quotedFrom}: "${message.quotedText}"]\n\n${rawBody}`;
  }

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
    body: bodyForAgent,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
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
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      first = false;
      try {
        logVerbose(core, runtime, `Sending media to ${chatId}`);
        const result = await sendFileMessage(client, chatId, mediaUrl, caption);
        if (result.ok) {
          statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          runtime.error(`Telegram User media send failed: ${result.error}`);
        }
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
        const result = await sendTextMessage(client, chatId, chunk);
        if (result.ok) {
          statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          runtime.error(`Telegram User message send failed: ${result.error}`);
        }
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
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let resolveRunning: (() => void) | null = null;

  const KEEP_ALIVE_INTERVAL_MS = 60_000; // ping every 60s to keep update stream alive

  const stop = () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (client) {
      destroyClient(client).catch((err) => {
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
      logVerbose(core, runtime, `[${account.accountId}] starting GramJS client (MTProto)`);

      client = await createTelegramUserClient({
        apiId: account.apiId,
        apiHash: account.apiHash,
        session: account.session,
      });

      await connectClient(client);
      runtime.error(`[${account.accountId}] GramJS connected, registering event handler`);

      // Debug: listen for ALL raw updates to verify GramJS receives anything
      client.addEventHandler((update: unknown) => {
        const name = update?.constructor?.name ?? typeof update;
        runtime.error(`[${account.accountId}] raw update: ${name}`);
      });

      // Register event handler BEFORE any high-level API calls (getMe/getDialogs).
      // GramJS must have the handler in place before Telegram's update stream is
      // initialized by a high-level request. We use a late-binding selfId so the
      // handler is registered first, then getMe() triggers the update stream.
      // See: https://github.com/gram-js/gramjs/issues/280
      let selfId: string | null = null;

      setupMessageListener(client, selfId, (msg) => {
        runtime.error(
          `[${account.accountId}] event handler fired: senderId=${msg.senderId} text=${msg.text?.slice(0, 30)}`,
        );
        if (!client) {
          return; // client torn down between event queue and handler execution
        }
        // Filter self messages here since selfId is resolved after handler registration
        if (selfId && msg.senderId === selfId) {
          runtime.error(`[${account.accountId}] skipping self message`);
          return;
        }
        logVerbose(core, runtime, `[${account.accountId}] inbound message from ${msg.senderId}`);
        statusSink?.({ lastInboundAt: Date.now() });
        processMessage(msg, account, config, core, runtime, client, statusSink).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
        });
      });

      runtime.error(`[${account.accountId}] event handler registered, calling getMe`);

      // Now make high-level calls to initialize the update stream
      const self = await getSelfInfo(client);
      selfId = self.userId;
      runtime.error(`[${account.accountId}] getMe done: selfId=${selfId}`);

      // Fetch dialogs to populate GramJS entity cache
      try {
        await client.getDialogs({ limit: 1 });
        runtime.error(`[${account.accountId}] getDialogs done`);
      } catch {
        // non-fatal: listener may still work for known entities
      }

      // Periodic keep-alive: call getMe() to prevent update stream from going stale.
      keepAliveTimer = setInterval(() => {
        if (!client || stopped) {
          return;
        }
        client.getMe().catch(() => {
          // ignore keep-alive errors; reconnect logic handles actual failures
        });
      }, KEEP_ALIVE_INTERVAL_MS);

      logVerbose(
        core,
        runtime,
        `[${account.accountId}] connected as ${self.firstName ?? ""} ${self.lastName ?? ""} (@${self.username ?? "?"})`,
      );
    } catch (err) {
      runtime.error(`[${account.accountId}] GramJS connection error: ${String(err)}`);
      // Clean up the failed client to prevent connection leaks
      if (client) {
        disconnectClient(client).catch(() => {});
        client = null;
      }
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
    abortSignal.addEventListener(
      "abort",
      () => {
        stop(); // stop() calls resolveRunning() which resolves this promise
      },
      { once: true },
    );
  });

  await startListener();
  await runningPromise;

  return { stop };
}
