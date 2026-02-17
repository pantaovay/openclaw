import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { telegramUserPlugin, telegramUserDock } from "./src/channel.js";
import { setTelegramUserRuntime } from "./src/runtime.js";
import { TelegramUserToolSchema, executeTelegramUserTool } from "./src/tool.js";

const plugin = {
  id: "telegram-user",
  name: "Telegram Personal",
  description: "Telegram personal account messaging via MTProto (GramJS)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelegramUserRuntime(api.runtime);
    api.registerChannel({ plugin: telegramUserPlugin, dock: telegramUserDock });

    api.registerTool({
      name: "telegram-user",
      label: "Telegram Personal",
      description:
        "Access Telegram via personal account (MTProto). " +
        "Actions: send (text message), history (read chat history), " +
        "contacts (list DM contacts), dialogs (list all chats), " +
        "search (search messages), me (profile info), status (connection check).",
      parameters: TelegramUserToolSchema,
      execute: executeTelegramUserTool,
    } as AnyAgentTool);
  },
};

export default plugin;
