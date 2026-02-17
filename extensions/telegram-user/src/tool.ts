import { Type } from "@sinclair/typebox";
import type { TelegramClient, Api } from "telegram";
import { resolveTelegramUserAccountSync, isAccountConfigured } from "./accounts.js";
import { getSelfInfo } from "./client.js";
import { getClientPool } from "./pool.js";
import { getTelegramUserRuntime } from "./runtime.js";

const ACTIONS = ["send", "history", "contacts", "dialogs", "me", "status", "search"] as const;

type AgentToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
};

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

export const TelegramUserToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, {
      description: `Action: ${ACTIONS.join(", ")}`,
    }),
    chatId: Type.Optional(
      Type.String({ description: "Chat/user ID or username for messaging and history" }),
    ),
    message: Type.Optional(Type.String({ description: "Message text to send" })),
    replyToMsgId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
    limit: Type.Optional(Type.Number({ description: "Max results to return (default 20)" })),
    query: Type.Optional(Type.String({ description: "Search query for contacts or messages" })),
  },
  { additionalProperties: false },
);

type ToolParams = {
  action: (typeof ACTIONS)[number];
  chatId?: string;
  message?: string;
  replyToMsgId?: number;
  limit?: number;
  query?: string;
};

function json(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

async function withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const core = getTelegramUserRuntime();
  const cfg = core.config.loadConfig();
  const account = resolveTelegramUserAccountSync({ cfg });
  if (!isAccountConfigured(account)) {
    throw new Error(
      "Telegram User not configured. Run: openclaw channels login --channel telegram-user",
    );
  }
  const pool = getClientPool();
  const client = await pool.acquire({
    apiId: account.apiId,
    apiHash: account.apiHash,
    session: account.session,
  });
  try {
    return await fn(client);
  } finally {
    pool.release(client);
  }
}

function formatMessage(msg: Api.Message): Record<string, unknown> {
  return {
    id: msg.id,
    date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
    senderId: msg.senderId ? String(msg.senderId.toJSON()) : null,
    text: msg.text ?? "",
    replyToMsgId:
      msg.replyTo && "replyToMsgId" in msg.replyTo ? msg.replyTo.replyToMsgId : undefined,
  };
}

export async function executeTelegramUserTool(
  _toolCallId: string,
  params: ToolParams,
  _signal?: AbortSignal,
  _onUpdate?: unknown,
): Promise<AgentToolResult> {
  try {
    switch (params.action) {
      case "send": {
        if (!params.chatId || !params.message) {
          throw new Error("chatId and message required for send action");
        }
        return await withClient(async (client) => {
          const peer = await client.getEntity(params.chatId!);
          const result = await client.sendMessage(peer, {
            message: params.message!,
            replyTo: params.replyToMsgId,
          });
          return json({ success: true, messageId: result.id });
        });
      }

      case "history": {
        if (!params.chatId) {
          throw new Error("chatId required for history action");
        }
        const limit = params.limit ?? 20;
        return await withClient(async (client) => {
          const messages = await client.getMessages(params.chatId!, {
            limit,
          });
          return json(messages.map(formatMessage));
        });
      }

      case "search": {
        if (!params.query) {
          throw new Error("query required for search action");
        }
        const limit = params.limit ?? 20;
        return await withClient(async (client) => {
          if (params.chatId) {
            // Search within a specific chat
            const messages = await client.getMessages(params.chatId, {
              limit,
              search: params.query!,
            });
            return json(messages.map(formatMessage));
          }
          // Global search across all chats
          const { Api: TgApi } = await import("telegram");
          const results = await client.invoke(
            new TgApi.messages.SearchGlobal({
              q: params.query!,
              filter: new TgApi.InputMessagesFilterEmpty(),
              minDate: 0,
              maxDate: 0,
              offsetRate: 0,
              offsetPeer: new TgApi.InputPeerEmpty(),
              offsetId: 0,
              limit,
            }),
          );
          if ("messages" in results) {
            return json((results.messages as Api.Message[]).map(formatMessage));
          }
          return json({ results: [] });
        });
      }

      case "contacts": {
        const limit = params.limit ?? 50;
        return await withClient(async (client) => {
          const dialogs = await client.getDialogs({ limit });
          const contacts = dialogs
            .filter((d) => !d.isGroup && !d.isChannel)
            .map((d) => ({
              id: String(d.id),
              name: d.name ?? "",
              unreadCount: d.unreadCount,
              lastMessage: d.message?.text?.slice(0, 100) ?? "",
            }));
          if (params.query) {
            const q = params.query.toLowerCase();
            return json(
              contacts.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q)),
            );
          }
          return json(contacts);
        });
      }

      case "dialogs": {
        const limit = params.limit ?? 30;
        return await withClient(async (client) => {
          const dialogs = await client.getDialogs({ limit });
          return json(
            dialogs.map((d) => ({
              id: String(d.id),
              name: d.name ?? "",
              isGroup: d.isGroup,
              isChannel: d.isChannel,
              unreadCount: d.unreadCount,
              lastMessage: d.message?.text?.slice(0, 100) ?? "",
              date: d.date ? new Date(d.date * 1000).toISOString() : null,
            })),
          );
        });
      }

      case "me": {
        return await withClient(async (client) => {
          const self = await getSelfInfo(client);
          return json(self);
        });
      }

      case "status": {
        try {
          return await withClient(async (client) => {
            const self = await getSelfInfo(client);
            return json({ connected: true, user: self });
          });
        } catch (err) {
          return json({
            connected: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      default: {
        params.action satisfies never;
        throw new Error(`Unknown action: ${String(params.action)}. Valid: ${ACTIONS.join(", ")}`);
      }
    }
  } catch (err) {
    return json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
