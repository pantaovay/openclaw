import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTelegramUserRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getTelegramUserRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Telegram User runtime not initialized");
  }
  return runtime;
}
