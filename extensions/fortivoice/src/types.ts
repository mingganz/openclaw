import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { FortivoiceAccountConfig, FortivoiceConfig } from "./config-schema.js";

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    fortivoice?: FortivoiceConfig;
  };
};

export type ResolvedFortivoiceAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  url?: string;
  reconnectDelayMs: number;
  helloWorldOnStart: boolean;
  config: FortivoiceAccountConfig;
};

export type FortivoiceCallInfo = {
  callId?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};
