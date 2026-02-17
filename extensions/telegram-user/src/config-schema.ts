import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const groupConfigSchema = z.object({
  allow: z.boolean().optional(),
  enabled: z.boolean().optional(),
  tools: ToolPolicySchema,
});

const telegramUserAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  apiId: z.number().optional(),
  apiHash: z.string().optional(),
  session: z.string().optional(),
  phoneNumber: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const TelegramUserConfigSchema = telegramUserAccountSchema.extend({
  accounts: z.object({}).catchall(telegramUserAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
