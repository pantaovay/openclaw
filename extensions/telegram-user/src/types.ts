export type TelegramUserAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiId?: number;
  apiHash?: string;
  session?: string;
  phoneNumber?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<
    string,
    { allow?: boolean; enabled?: boolean; tools?: { allow?: string[]; deny?: string[] } }
  >;
  messagePrefix?: string;
  responsePrefix?: string;
};

export type TelegramUserConfig = {
  enabled?: boolean;
  name?: string;
  apiId?: number;
  apiHash?: string;
  session?: string;
  phoneNumber?: string;
  defaultAccount?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<
    string,
    { allow?: boolean; enabled?: boolean; tools?: { allow?: string[]; deny?: string[] } }
  >;
  messagePrefix?: string;
  responsePrefix?: string;
  accounts?: Record<string, TelegramUserAccountConfig>;
};

export type ResolvedTelegramUserAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  apiId: number;
  apiHash: string;
  session: string;
  phoneNumber?: string;
  config: TelegramUserAccountConfig;
};

export type TelegramUserMessage = {
  chatId: string;
  messageId: number;
  senderId: string;
  senderName: string;
  senderUsername?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  isChannel: boolean;
  groupName?: string;
  replyToMsgId?: number;
  mediaType?: "photo" | "document" | "video" | "audio" | "sticker";
};

export type TelegramUserSelfInfo = {
  userId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
};
