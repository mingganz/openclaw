import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { CoreConfig, ResolvedFortivoiceAccount } from "./types.js";
import {
  listFortivoiceAccountIds,
  resolveDefaultFortivoiceAccountId,
  resolveFortivoiceAccount,
} from "./accounts.js";
import { FortivoiceConfigSchema } from "./config-schema.js";
import { monitorFortivoiceProvider } from "./monitor.js";
import { normalizeFortivoiceTarget } from "./protocol.js";
import {
  hasActiveFortivoiceSession,
  queueFortivoiceText,
  resolveFortivoiceSessionId,
} from "./state.js";

function isWebSocketUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

function isE164ishPhone(raw: string): boolean {
  return /^\+?[0-9]{7,15}$/.test(raw);
}

function resolveSessionTarget(params: {
  accountId: string;
  to?: string | null;
}): string | undefined {
  return resolveFortivoiceSessionId({
    accountId: params.accountId,
    target: params.to,
  });
}

const meta = {
  id: "fortivoice",
  label: "FortiVoice",
  selectionLabel: "FortiVoice (WebSocket)",
  docsPath: "/channels/fortivoice",
  docsLabel: "fortivoice",
  blurb: "Outbound WebSocket bridge for FortiVoice request/response control messages.",
  order: 75,
  quickstartAllowFrom: true,
} as const;

export const fortivoicePlugin: ChannelPlugin<ResolvedFortivoiceAccount> = {
  id: "fortivoice",
  meta,
  capabilities: {
    chatTypes: ["direct"],
  },
  reload: { configPrefixes: ["channels.fortivoice"] },
  configSchema: buildChannelConfigSchema(FortivoiceConfigSchema),
  config: {
    listAccountIds: (cfg) => listFortivoiceAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveFortivoiceAccount({
        cfg: cfg as CoreConfig,
        accountId,
      }),
    defaultAccountId: (cfg) => resolveDefaultFortivoiceAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "fortivoice",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "fortivoice",
        accountId,
        clearBaseFields: ["name", "phone", "url", "reconnectDelayMs", "helloWorldOnStart"],
      }),
    isConfigured: (account) => Boolean(account.url && account.phone),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.url && account.phone),
      url: account.url,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "fortivoice",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "FORTIVOICE_WS_URL can only be used for the default account.";
      }
      const url = (input.url ?? input.httpUrl)?.trim();
      if (!input.useEnv && !url) {
        return "FortiVoice requires --url <ws://host:port/path> (or --use-env).";
      }
      if (url && !isWebSocketUrl(url)) {
        return "FortiVoice --url must use ws:// or wss:// and include host[:port].";
      }
      const phone = input.phone?.trim();
      if (!phone && !input.useEnv) {
        return "FortiVoice requires --phone <+15551234567> (or --use-env).";
      }
      if (phone && !isE164ishPhone(phone)) {
        return "FortiVoice --phone must look like E.164 (+14155550123).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const url = (input.url ?? input.httpUrl)?.trim();
      const phone = input.phone?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "fortivoice",
        accountId,
        name: input.name,
      });

      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "fortivoice",
            })
          : namedConfig;
      const coreNext = next as CoreConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...coreNext,
          channels: {
            ...coreNext.channels,
            fortivoice: {
              ...coreNext.channels?.fortivoice,
              enabled: true,
              ...(phone ? { phone } : {}),
              ...(input.useEnv ? {} : url ? { url } : {}),
            },
          },
        };
      }

      return {
        ...coreNext,
        channels: {
          ...coreNext.channels,
          fortivoice: {
            ...coreNext.channels?.fortivoice,
            enabled: true,
            accounts: {
              ...coreNext.channels?.fortivoice?.accounts,
              [accountId]: {
                ...coreNext.channels?.fortivoice?.accounts?.[accountId],
                enabled: true,
                ...(phone ? { phone } : {}),
                ...(url ? { url } : {}),
              },
            },
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeFortivoiceTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(normalizeFortivoiceTarget(raw)),
      hint: "<sessionId|session:ID|call:ID>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 700,
    resolveTarget: ({ to, accountId }) => {
      const aid = normalizeAccountId(accountId);
      const sessionId = resolveSessionTarget({ accountId: aid, to });
      if (!sessionId) {
        const hasAny = hasActiveFortivoiceSession(aid);
        return {
          ok: false,
          error: missingTargetError(
            "FortiVoice",
            hasAny
              ? "<sessionId|session:ID|call:ID>"
              : "<sessionId|session:ID|call:ID> (no active session yet)",
          ),
        };
      }
      return { ok: true, to: sessionId };
    },
    sendText: async ({ to, text, accountId }) => {
      const aid = normalizeAccountId(accountId);
      const sessionId = resolveSessionTarget({ accountId: aid, to });
      if (!sessionId) {
        throw missingTargetError(
          "FortiVoice",
          "<sessionId|session:ID|call:ID> (requires active session)",
        );
      }
      const queued = queueFortivoiceText({
        accountId: aid,
        sessionId,
        text,
      });
      return {
        channel: "fortivoice",
        messageId: queued.messageId,
        chatId: sessionId,
        meta: {
          queued: true,
          sessionId,
        },
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const aid = normalizeAccountId(accountId);
      const sessionId = resolveSessionTarget({ accountId: aid, to });
      if (!sessionId) {
        throw missingTargetError(
          "FortiVoice",
          "<sessionId|session:ID|call:ID> (requires active session)",
        );
      }
      const merged = [text?.trim(), mediaUrl ? `[media] ${mediaUrl}` : ""]
        .filter(Boolean)
        .join("\n");
      const queued = queueFortivoiceText({
        accountId: aid,
        sessionId,
        text: merged || (mediaUrl ?? ""),
      });
      return {
        channel: "fortivoice",
        messageId: queued.messageId,
        chatId: sessionId,
        meta: {
          queued: true,
          sessionId,
        },
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastError: null,
      lastStartAt: null,
      lastStopAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      url: snapshot.baseUrl ?? null,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastDisconnect: snapshot.lastDisconnect ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.url && account.phone),
      baseUrl: account.url,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastError: runtime?.lastError ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.url,
        lastStartAt: Date.now(),
      });
      ctx.log?.info(
        `[${account.accountId}] starting FortiVoice channel (${account.url ?? "url not configured"})`,
      );

      if (!account.url) {
        throw new Error(
          `FortiVoice URL missing for account "${account.accountId}" (set channels.fortivoice.url or channels.fortivoice.accounts.${account.accountId}.url).`,
        );
      }
      if (!account.phone) {
        throw new Error(
          `FortiVoice phone missing for account "${account.accountId}" (set channels.fortivoice.phone or channels.fortivoice.accounts.${account.accountId}.phone, or FORTIVOICE_PHONE for default account).`,
        );
      }

      return monitorFortivoiceProvider({
        account,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
