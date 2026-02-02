import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setCommonlyRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getCommonlyRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Commonly runtime not initialized");
  }
  return runtime;
}
