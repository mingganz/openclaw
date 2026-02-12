import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setFortivoiceRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getFortivoiceRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("FortiVoice runtime not initialized");
  }
  return runtime;
}
