import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import type { TelegramUserMessage, TelegramUserSelfInfo } from "./types.js";

export type TelegramUserClientOptions = {
  apiId: number;
  apiHash: string;
  session: string;
};

export type TelegramUserSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

let activeClient: TelegramClient | null = null;

export function getActiveClient(): TelegramClient | null {
  return activeClient;
}

export async function createTelegramUserClient(
  options: TelegramUserClientOptions,
): Promise<TelegramClient> {
  const stringSession = new StringSession(options.session);
  const client = new TelegramClient(stringSession, options.apiId, options.apiHash, {
    connectionRetries: 5,
  });
  return client;
}

export async function connectClient(client: TelegramClient): Promise<void> {
  await client.connect();
  activeClient = client;
}

export async function disconnectClient(client: TelegramClient): Promise<void> {
  try {
    await client.disconnect();
  } finally {
    if (activeClient === client) {
      activeClient = null;
    }
  }
}

export async function interactiveLogin(params: {
  apiId: number;
  apiHash: string;
  phoneNumber?: string;
}): Promise<string> {
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, params.apiId, params.apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: params.phoneNumber
      ? async () => params.phoneNumber!
      : async () => {
          const { default: input } = await import("input");
          return input.text("Enter your phone number: ");
        },
    password: async () => {
      const { default: input } = await import("input");
      return input.text("Enter your 2FA password (if any): ");
    },
    phoneCode: async () => {
      const { default: input } = await import("input");
      return input.text("Enter the code you received: ");
    },
    onError: (err) => {
      throw err;
    },
  });

  const sessionString = client.session.save() as unknown as string;
  await client.disconnect();
  return sessionString;
}

function extractSenderInfo(message: Api.Message): {
  senderId: string;
  senderName: string;
  senderUsername?: string;
} {
  const sender = message.sender;
  if (!sender) {
    return { senderId: String(message.senderId?.toJSON() ?? "unknown"), senderName: "Unknown" };
  }

  if (sender instanceof Api.User) {
    const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ") || "Unknown";
    return {
      senderId: String(sender.id),
      senderName: name,
      senderUsername: sender.username ?? undefined,
    };
  }

  if (sender instanceof Api.Channel || sender instanceof Api.Chat) {
    return {
      senderId: String(sender.id),
      senderName: (sender as Api.Channel).title ?? "Unknown",
    };
  }

  return { senderId: String(message.senderId?.toJSON() ?? "unknown"), senderName: "Unknown" };
}

export function setupMessageListener(
  client: TelegramClient,
  selfId: string,
  onMessage: (msg: TelegramUserMessage) => void,
): void {
  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message;
    if (!message || !message.text?.trim()) {
      return;
    }

    // Skip messages from self
    const fromId = String(message.senderId?.toJSON() ?? "");
    if (fromId === selfId) {
      return;
    }

    await message.getChat();
    await message.getSender();

    const chat = message.chat;
    const isGroup =
      chat instanceof Api.Chat ||
      chat instanceof Api.ChatForbidden ||
      (chat instanceof Api.Channel && chat.megagroup);
    const isChannel = chat instanceof Api.Channel && !chat.megagroup;
    const chatId = String(message.chatId ?? message.peerId?.toJSON());

    const { senderId, senderName, senderUsername } = extractSenderInfo(message);

    let groupName: string | undefined;
    if (isGroup || isChannel) {
      if (chat instanceof Api.Chat) {
        groupName = chat.title;
      } else if (chat instanceof Api.Channel) {
        groupName = chat.title;
      }
    }

    const parsed: TelegramUserMessage = {
      chatId,
      messageId: message.id,
      senderId,
      senderName,
      senderUsername,
      text: message.text,
      timestamp: message.date,
      isGroup,
      isChannel,
      groupName,
      replyToMsgId:
        message.replyTo instanceof Api.MessageReplyHeader
          ? message.replyTo.replyToMsgId
          : undefined,
    };

    onMessage(parsed);
  }, new NewMessage({ incoming: true }));
}

export async function getSelfInfo(client: TelegramClient): Promise<TelegramUserSelfInfo> {
  const me = await client.getMe();
  if (!(me instanceof Api.User)) {
    throw new Error("Failed to get self info");
  }
  return {
    userId: String(me.id),
    firstName: me.firstName ?? undefined,
    lastName: me.lastName ?? undefined,
    username: me.username ?? undefined,
    phone: me.phone ?? undefined,
  };
}

export async function sendTextMessage(
  client: TelegramClient,
  chatId: string,
  text: string,
  options?: { replyToMsgId?: number },
): Promise<TelegramUserSendResult> {
  try {
    const peer = await client.getEntity(chatId);
    const result = await client.sendMessage(peer, {
      message: text,
      replyTo: options?.replyToMsgId,
    });
    return { ok: true, messageId: String(result.id) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendFileMessage(
  client: TelegramClient,
  chatId: string,
  fileUrl: string,
  caption?: string,
): Promise<TelegramUserSendResult> {
  try {
    const peer = await client.getEntity(chatId);
    const result = await client.sendFile(peer, {
      file: fileUrl,
      caption,
    });
    return { ok: true, messageId: String(result.id) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeConnection(
  client: TelegramClient,
): Promise<{ ok: boolean; user?: TelegramUserSelfInfo; error?: string }> {
  try {
    const self = await getSelfInfo(client);
    return { ok: true, user: self };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
