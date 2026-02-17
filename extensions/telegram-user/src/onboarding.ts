import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptAccountId,
  promptChannelAccessConfig,
} from "openclaw/plugin-sdk";
import {
  listTelegramUserAccountIds,
  resolveDefaultTelegramUserAccountId,
  resolveTelegramUserAccountSync,
  isAccountConfigured,
} from "./accounts.js";
import { interactiveLogin } from "./client.js";
import { getTelegramUserRuntime } from "./runtime.js";

const channel = "telegram-user" as const;

async function copyTemplatesToStateDir(prompter: WizardPrompter): Promise<void> {
  try {
    const { resolve, dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { existsSync, copyFileSync, mkdirSync } = await import("node:fs");

    const core = getTelegramUserRuntime();
    const stateDir = core.state.resolveStateDir();
    const targetDir = resolve(stateDir, "telegram-user");

    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const templatesDir = resolve(pluginDir, "..", "templates");

    if (!existsSync(templatesDir)) {
      return;
    }

    mkdirSync(targetDir, { recursive: true });

    const files = ["SOUL.md", "HEARTBEAT.md"];
    const copied: string[] = [];
    for (const file of files) {
      const src = join(templatesDir, file);
      const dest = join(targetDir, file);
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest);
        copied.push(dest);
      }
    }

    if (copied.length > 0) {
      await prompter.note(
        [
          "Template files copied to your config directory:",
          ...copied.map((p) => `  ${p}`),
          "",
          "Edit these files to customize your assistant's personality and periodic tasks.",
        ].join("\n"),
        "Templates",
      );
    }
  } catch {
    // Non-critical; silently skip if copy fails
  }
}

/**
 * Upsert fields into the telegram-user channel config, handling both
 * top-level (DEFAULT_ACCOUNT_ID) and per-account config placement.
 */
function upsertTelegramUserField(
  cfg: OpenClawConfig,
  accountId: string,
  fields: Record<string, unknown>,
): OpenClawConfig {
  const tgu = (cfg.channels?.["telegram-user"] ?? {}) as Record<string, unknown>;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "telegram-user": { ...tgu, enabled: true, ...fields },
      },
    } as OpenClawConfig;
  }
  const accounts = (tgu.accounts ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "telegram-user": {
        ...tgu,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...(accounts[accountId] as Record<string, unknown> | undefined),
            enabled: true,
            ...fields,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(
          (cfg.channels?.["telegram-user"] as Record<string, unknown> | undefined)?.allowFrom as
            | Array<string | number>
            | undefined,
        )
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "telegram-user": {
        ...(cfg.channels?.["telegram-user"] as Record<string, unknown> | undefined),
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Telegram Personal Account login via MTProto.",
      "",
      "Prerequisites:",
      "1) Get API credentials from https://my.telegram.org/apps",
      "2) You'll enter your phone number and verification code",
      "",
      "Environment variables (optional):",
      "  TELEGRAM_API_ID     - Your Telegram API ID",
      "  TELEGRAM_API_HASH   - Your Telegram API Hash",
    ].join("\n"),
    "Telegram Personal Setup",
  );
}

async function promptAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveTelegramUserAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const parseInput = (raw: string) =>
    raw
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  while (true) {
    const entry = await prompter.text({
      message: "Telegram allowFrom (user id or @username)",
      placeholder: "123456789, @alice",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInput(String(entry));
    if (parts.length === 0) {
      continue;
    }
    const cleaned = parts.map((part) => part.replace(/^@/, ""));
    const unique = mergeAllowFromEntries(existingAllowFrom, cleaned);
    return upsertTelegramUserField(cfg, accountId, { dmPolicy: "allowlist", allowFrom: unique });
  }
}

function setGroupPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  return upsertTelegramUserField(cfg, accountId, { groupPolicy });
}

function setGroupAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  groupKeys: string[],
): OpenClawConfig {
  const groups = Object.fromEntries(groupKeys.map((key) => [key, { allow: true }]));
  return upsertTelegramUserField(cfg, accountId, { groups });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Telegram Personal",
  channel,
  policyKey: "channels.telegram-user.dmPolicy",
  allowFromKey: "channels.telegram-user.allowFrom",
  getCurrent: (cfg) =>
    ((cfg.channels?.["telegram-user"] as Record<string, unknown> | undefined)?.dmPolicy ??
      "pairing") as "pairing" | "allowlist" | "open" | "disabled",
  setPolicy: (cfg, policy) => setDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultTelegramUserAccountId(cfg);
    return promptAllowFrom({ cfg, prompter, accountId: id });
  },
};

export const telegramUserOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const ids = listTelegramUserAccountIds(cfg);
    let configured = false;
    for (const accountId of ids) {
      const account = resolveTelegramUserAccountSync({ cfg, accountId });
      if (isAccountConfigured(account)) {
        configured = true;
        break;
      }
    }
    return {
      channel,
      configured,
      statusLines: [`Telegram Personal: ${configured ? "session active" : "needs MTProto login"}`],
      selectionHint: configured ? "recommended - session active" : "recommended - needs login",
      quickstartScore: configured ? 1 : 20,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const tguOverride = accountOverrides["telegram-user"]?.trim();
    const defaultAccountId = resolveDefaultTelegramUserAccountId(cfg);
    let accountId = tguOverride ? normalizeAccountId(tguOverride) : defaultAccountId;

    if (shouldPromptAccountIds && !tguOverride) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Telegram Personal",
        currentId: accountId,
        listAccountIds: listTelegramUserAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const account = resolveTelegramUserAccountSync({ cfg: next, accountId });
    const alreadyConfigured = isAccountConfigured(account);

    if (!alreadyConfigured) {
      await noteSetupHelp(prompter);

      // Check for API credentials
      let apiId = account.apiId;
      let apiHash = account.apiHash;

      if (!apiId || !apiHash) {
        const apiIdInput = await prompter.text({
          message: "Telegram API ID (from https://my.telegram.org/apps)",
          placeholder: "12345678",
          validate: (value) => {
            const num = Number(String(value ?? "").trim());
            return num > 0 ? undefined : "Must be a positive number";
          },
        });
        apiId = Number(String(apiIdInput).trim());

        const apiHashInput = await prompter.text({
          message: "Telegram API Hash",
          placeholder: "abc123def456...",
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        });
        apiHash = String(apiHashInput).trim();
      }

      const wantsLogin = await prompter.confirm({
        message: "Login with phone number now?",
        initialValue: true,
      });

      if (wantsLogin) {
        await prompter.note(
          "You will be prompted for your phone number, verification code, and 2FA password (if enabled).",
          "MTProto Login",
        );

        try {
          const session = await interactiveLogin({ apiId, apiHash });
          const core = getTelegramUserRuntime();
          next = upsertTelegramUserField(next, accountId, { apiId, apiHash, session });
          await core.config.writeConfigFile(next);
          await prompter.note("Login successful! Session saved.", "Success");
          await copyTemplatesToStateDir(prompter);
        } catch (err) {
          await prompter.note(
            `Login failed: ${err instanceof Error ? err.message : String(err)}`,
            "Error",
          );
        }
      } else {
        next = upsertTelegramUserField(next, accountId, { apiId, apiHash });
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Telegram Personal already configured. Keep session?",
        initialValue: true,
      });
      if (!keepSession) {
        try {
          const session = await interactiveLogin({
            apiId: account.apiId,
            apiHash: account.apiHash,
          });
          const core = getTelegramUserRuntime();
          next = upsertTelegramUserField(next, accountId, { session });
          await core.config.writeConfigFile(next);
          await prompter.note("Re-login successful! Session saved.", "Success");
          await copyTemplatesToStateDir(prompter);
        } catch (err) {
          await prompter.note(
            `Login failed: ${err instanceof Error ? err.message : String(err)}`,
            "Error",
          );
        }
      }
    }

    // Enable channel
    next = upsertTelegramUserField(next, accountId, {});

    if (forceAllowFrom) {
      next = await promptAllowFrom({ cfg: next, prompter, accountId });
    }

    const updatedAccount = resolveTelegramUserAccountSync({ cfg: next, accountId });
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Telegram groups",
      currentPolicy: updatedAccount.config.groupPolicy ?? "open",
      currentEntries: Object.keys(updatedAccount.config.groups ?? {}),
      placeholder: "-100123456789, My Group",
      updatePrompt: Boolean(updatedAccount.config.groups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setGroupPolicy(next, accountId, accessConfig.policy);
      } else {
        next = setGroupPolicy(next, accountId, "allowlist");
        next = setGroupAllowlist(next, accountId, accessConfig.entries);
      }
    }

    return { cfg: next, accountId };
  },
};
