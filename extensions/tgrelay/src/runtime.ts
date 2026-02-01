import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTgrelayRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTgrelayRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Telegram Relay runtime not initialized");
  }
  return runtime;
}
