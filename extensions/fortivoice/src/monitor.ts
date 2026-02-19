import { randomUUID } from "node:crypto";
import {
  createReplyPrefixOptions,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import WebSocket from "ws";
import type { CoreConfig, ResolvedFortivoiceAccount } from "./types.js";
import {
  createFortivoiceRequest,
  createFortivoiceResponse,
  createSpeakAction,
  fortivoiceError,
  fortivoiceOk,
  isFortivoiceRequestEnvelope,
  isFortivoiceResponseEnvelope,
  parseFortivoiceEnvelope,
  parseFortivoiceActionsFromAssistantText,
  parseFortivoiceResponsePayload,
  parseRealtimeUpdate,
  parseSessionStartPayload,
  shouldProcessRealtimeInput,
  type FortivoiceAction,
  type FortivoiceRequestEnvelope,
} from "./protocol.js";
import { getFortivoiceRuntime } from "./runtime.js";
import {
  consumeFortivoiceQueuedText,
  endFortivoiceSession,
  trackFortivoiceSession,
} from "./state.js";

const HELLO_WORLD_TEXT = "Hello from OpenClaw FortiVoice channel.";
const FORTIVOICE_TEXT_LIMIT = 700;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HANDLED_OPS = ["system.ping", "session.start", "session.update", "session.end"] as const;
const WS_LOG_MAX_LEN = 2_000;
const FORTIVOICE_ACTION_GUIDANCE =
  "FortiVoice action contract (must follow):\n" +
  'Return ONLY JSON object: {"actions":[...]} (no prose outside JSON).\n' +
  "Supported action types: speak, collect, end.\n" +
  "When more caller input is required, include BOTH:\n" +
  '1) a "speak" question\n' +
  '2) a "collect" action with schema.fields for required slots.\n' +
  "Do not ask required follow-up questions using speak-only.\n" +
  'For weather requests missing location, collect city with {"key":"city","type":"string","required":true}.';

type FortivoiceRuntimeEnv = RuntimeEnv;
type FortivoiceLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type FortivoiceMonitorOptions = {
  account: ResolvedFortivoiceAccount;
  config: CoreConfig;
  runtime: FortivoiceRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

function rawDataToString(raw: WebSocket.RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function ensureWsUrl(raw?: string): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error("FortiVoice WebSocket URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FortiVoice URL is invalid");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("FortiVoice URL must use ws:// or wss://");
  }
  return parsed.toString();
}

function ensurePhone(raw?: string): string {
  const phone = raw?.trim();
  if (!phone) {
    throw new Error("FortiVoice phone is required");
  }
  return phone;
}

function compactLogString(raw: string): string {
  if (raw.length <= WS_LOG_MAX_LEN) {
    return raw;
  }
  return `${raw.slice(0, WS_LOG_MAX_LEN)}...(truncated)`;
}

function serializeForLog(value: unknown): string {
  try {
    return compactLogString(JSON.stringify(value));
  } catch {
    return compactLogString(String(value));
  }
}

function logWsEnvelope(params: {
  logger: FortivoiceLogger;
  direction: "inbound" | "outbound";
  envelope: {
    type: string;
    op: string;
    req_id?: string;
    session_id?: string | null;
    seq: number;
    payload: unknown;
  };
}) {
  const reqId = params.envelope.req_id ?? "-";
  const sessionId = params.envelope.session_id ?? "null";
  params.logger.info(
    `fortivoice ws ${params.direction}: type=${params.envelope.type} op=${params.envelope.op} req_id=${reqId} session_id=${sessionId} seq=${params.envelope.seq} payload=${serializeForLog(params.envelope.payload)}`,
  );
}

function queuedMessagesToActions(params: {
  accountId: string;
  sessionId: string;
}): FortivoiceAction[] {
  const queued = consumeFortivoiceQueuedText({
    accountId: params.accountId,
    sessionId: params.sessionId,
  });
  return queued
    .map((entry) => ({
      text: entry.text.trim(),
      messageId: entry.messageId,
    }))
    .filter((entry) => Boolean(entry.text))
    .map((entry) => createSpeakAction({ text: entry.text, messageId: entry.messageId }));
}

function createSessionActionResult(actions: FortivoiceAction[]): Record<string, unknown> {
  return {
    actions,
  };
}

function buildFortivoiceAgentInput(text: string): string {
  return `${text}\n\n${FORTIVOICE_ACTION_GUIDANCE}`;
}

export function inferFortivoiceCollectActionFromPlainReply(params: {
  latestUserText: string;
  assistantText: string;
}): Extract<FortivoiceAction, { type: "collect" }> | null {
  const userText = params.latestUserText.trim().toLowerCase();
  const assistantText = params.assistantText.trim();
  if (!userText || !assistantText) {
    return null;
  }
  if (!/\bweather\b/.test(userText)) {
    return null;
  }

  const assistantLower = assistantText.toLowerCase();
  const asksForCity =
    /\bcity\b/.test(assistantLower) &&
    (assistantText.includes("?") ||
      /\b(which|what)\s+city\b/.test(assistantLower) ||
      /\bcould you tell me\b/.test(assistantLower));
  if (!asksForCity) {
    return null;
  }

  return {
    type: "collect",
    schema: {
      fields: [{ key: "city", type: "string", required: true }],
    },
  };
}

async function buildAgentActions(params: {
  request: FortivoiceRequestEnvelope;
  account: ResolvedFortivoiceAccount;
  sessionId: string;
  text: string;
  cfg: OpenClawConfig;
  runtime: FortivoiceRuntimeEnv;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
}): Promise<FortivoiceAction[]> {
  const { request, account, sessionId, text, cfg, runtime, statusSink } = params;
  const core = getFortivoiceRuntime();

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "fortivoice",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: `session:${sessionId}`,
    },
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "FortiVoice",
    from: `session:${sessionId}`,
    timestamp: Date.now(),
    previousTimestamp: core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    }),
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
    body: buildFortivoiceAgentInput(text),
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: `fortivoice:session:${sessionId}`,
    To: `fortivoice:session:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `session:${sessionId}`,
    SenderId: sessionId,
    Provider: "fortivoice",
    Surface: "fortivoice",
    MessageSid: request.req_id,
    OriginatingChannel: "fortivoice",
    OriginatingTo: `fortivoice:session:${sessionId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => runtime.error?.(`fortivoice: session record failed: ${String(err)}`),
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "fortivoice",
    accountId: account.accountId,
  });
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "fortivoice", account.accountId, {
    fallbackLimit: FORTIVOICE_TEXT_LIMIT,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "fortivoice", account.accountId);

  const actions: FortivoiceAction[] = [];
  let actionIndex = 0;
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "fortivoice",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload: ReplyPayload) => {
        const tableSafe = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
        const mediaList = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        const mediaNotice =
          mediaList.length > 0
            ? `\n[media not supported in FortiVoice text bridge: ${mediaList.join(", ")}]`
            : "";
        const combined = `${tableSafe}${mediaNotice}`.trim();
        if (!combined) {
          return;
        }
        const structuredActions = parseFortivoiceActionsFromAssistantText(combined);
        if (structuredActions) {
          actions.push(...structuredActions);
          if (structuredActions.length > 0) {
            core.channel.activity.record({
              channel: "fortivoice",
              accountId: account.accountId,
              direction: "outbound",
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          }
          return;
        }
        const collectAction = inferFortivoiceCollectActionFromPlainReply({
          latestUserText: text,
          assistantText: combined,
        });
        if (collectAction) {
          actionIndex += 1;
          actions.push(
            createSpeakAction({
              text: combined,
              messageId: `${request.req_id}-${actionIndex}`,
            }),
            collectAction,
          );
          core.channel.activity.record({
            channel: "fortivoice",
            accountId: account.accountId,
            direction: "outbound",
          });
          statusSink?.({ lastOutboundAt: Date.now() });
          return;
        }
        const chunks = core.channel.text.chunkTextWithMode(combined, textLimit, chunkMode);
        for (const chunk of chunks.length > 0 ? chunks : [combined]) {
          const trimmed = chunk.trim();
          if (!trimmed) {
            continue;
          }
          actionIndex += 1;
          actions.push(
            createSpeakAction({
              text: trimmed,
              messageId: `${request.req_id}-${actionIndex}`,
            }),
          );
        }
        core.channel.activity.record({
          channel: "fortivoice",
          accountId: account.accountId,
          direction: "outbound",
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        runtime.error?.(`fortivoice ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });

  return actions;
}

async function handleRequest(params: {
  request: FortivoiceRequestEnvelope;
  ws: WebSocket;
  account: ResolvedFortivoiceAccount;
  cfg: OpenClawConfig;
  runtime: FortivoiceRuntimeEnv;
  logger: FortivoiceLogger;
  connectionId: string;
  nextSeq: () => number;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
}): Promise<void> {
  const { request, ws, account, cfg, runtime, logger, connectionId, nextSeq, statusSink } = params;
  const core = getFortivoiceRuntime();

  const reply = (payload: ReturnType<typeof fortivoiceOk> | ReturnType<typeof fortivoiceError>) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const response = createFortivoiceResponse({
      request,
      seq: nextSeq(),
      payload,
    });
    logWsEnvelope({
      logger,
      direction: "outbound",
      envelope: response,
    });
    ws.send(JSON.stringify(response));
  };

  if (request.op === "system.hello") {
    reply(
      fortivoiceOk({
        conn_id: connectionId,
        server: {
          name: "openclaw-fortivoice",
          version: core.version,
        },
        heartbeat_sec: 30,
        dedupe_ttl_sec: 300,
      }),
    );
    return;
  }

  if (request.op === "system.ping") {
    const nonce = typeof request.payload.nonce === "string" ? request.payload.nonce : undefined;
    reply(fortivoiceOk(nonce ? { nonce } : {}));
    return;
  }

  if (request.op === "session.start") {
    const sessionId = request.session_id;
    if (!sessionId || typeof sessionId !== "string") {
      reply(fortivoiceError("invalid_session", "session.start requires session_id"));
      return;
    }

    const start = parseSessionStartPayload(request.payload);
    trackFortivoiceSession({
      accountId: account.accountId,
      sessionId,
      call: {
        callId: start.callId,
        from: start.from,
        to: start.to,
        direction: start.direction,
      },
    });

    const actions = queuedMessagesToActions({
      accountId: account.accountId,
      sessionId,
    });
    if (account.helloWorldOnStart) {
      actions.unshift(createSpeakAction({ text: HELLO_WORLD_TEXT }));
    }

    core.channel.activity.record({
      channel: "fortivoice",
      accountId: account.accountId,
      direction: "inbound",
    });
    statusSink?.({ lastInboundAt: Date.now() });

    reply(fortivoiceOk(createSessionActionResult(actions)));
    return;
  }

  if (request.op === "session.update") {
    const sessionId = request.session_id;
    if (!sessionId || typeof sessionId !== "string") {
      reply(fortivoiceError("invalid_session", "session.update requires session_id"));
      return;
    }

    trackFortivoiceSession({
      accountId: account.accountId,
      sessionId,
    });

    core.channel.activity.record({
      channel: "fortivoice",
      accountId: account.accountId,
      direction: "inbound",
    });
    statusSink?.({ lastInboundAt: Date.now() });

    const actions = queuedMessagesToActions({
      accountId: account.accountId,
      sessionId,
    });
    const update = parseRealtimeUpdate(request.payload);
    if (update && shouldProcessRealtimeInput(update)) {
      const generated = await buildAgentActions({
        request,
        account,
        sessionId,
        text: update.text,
        cfg,
        runtime,
        statusSink,
      });
      actions.push(...generated);
    }

    reply(fortivoiceOk(createSessionActionResult(actions)));
    return;
  }

  reply(fortivoiceError("unsupported_op", `Unsupported operation: ${request.op}`));
}

export async function monitorFortivoiceProvider(options: FortivoiceMonitorOptions): Promise<void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getFortivoiceRuntime();
  const logger = core.logging.getChildLogger({
    channel: "fortivoice",
    accountId: account.accountId,
  });
  const url = ensureWsUrl(account.url);
  const phone = ensurePhone(account.phone);
  const reconnectDelayMs = Math.max(250, account.reconnectDelayMs);

  const connectOnce = async (): Promise<void> => {
    logger.info(`fortivoice connecting to ${url}`);
    const ws = new WebSocket(url);
    const connectionId = randomUUID();
    let outboundSeq = 0;
    const nextSeq = () => {
      outboundSeq += 1;
      return outboundSeq;
    };

    const onAbort = () => ws.close(1000, "aborted");
    abortSignal.addEventListener("abort", onAbort, { once: true });

    let processing = Promise.resolve();
    let helloReqId: string | null = null;
    let helloAcked = false;
    let handshakeTimer: NodeJS.Timeout | null = null;

    await new Promise<void>((resolve) => {
      const clearHandshakeTimer = () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
      };

      const failHandshake = (message: string) => {
        logger.error(`fortivoice handshake failed: ${message}`);
        runtime.error?.(`fortivoice handshake failed: ${message}`);
        statusSink?.({ lastError: message });
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1011, "handshake_failed");
        }
      };

      ws.on("open", () => {
        helloReqId = randomUUID();
        const helloRequest = createFortivoiceRequest({
          reqId: helloReqId,
          seq: nextSeq(),
          op: "system.hello",
          sessionId: null,
          payload: {
            client: {
              name: "openclaw-fortivoice",
              version: core.version,
              phone,
            },
            supports: {
              ops: [...HANDLED_OPS],
            },
          },
        });
        logWsEnvelope({
          logger,
          direction: "outbound",
          envelope: helloRequest,
        });
        ws.send(JSON.stringify(helloRequest));
        handshakeTimer = setTimeout(() => {
          failHandshake(`system.hello timed out after ${HANDSHAKE_TIMEOUT_MS}ms`);
        }, HANDSHAKE_TIMEOUT_MS);
      });

      ws.on("message", (raw) => {
        const message = rawDataToString(raw);
        processing = processing
          .then(async () => {
            const envelope = parseFortivoiceEnvelope(message);
            if (!envelope) {
              logger.warn(`fortivoice ws inbound non-envelope: ${compactLogString(message)}`);
              return;
            }
            logWsEnvelope({
              logger,
              direction: "inbound",
              envelope,
            });
            if (
              !helloAcked &&
              helloReqId &&
              envelope.op === "system.hello" &&
              isFortivoiceResponseEnvelope(envelope) &&
              envelope.req_id === helloReqId
            ) {
              clearHandshakeTimer();
              const payload = parseFortivoiceResponsePayload(envelope.payload);
              if (!payload) {
                failHandshake("system.hello response payload is invalid");
                return;
              }
              if (!payload.ok) {
                failHandshake(
                  `system.hello rejected: ${payload.error.code}: ${payload.error.message}`,
                );
                return;
              }
              helloAcked = true;
              logger.info(`fortivoice connected to ${url}`);
              statusSink?.({
                connected: true,
                running: true,
                lastConnectedAt: Date.now(),
                lastError: null,
              });
              return;
            }
            if (!helloAcked) {
              return;
            }
            if (
              envelope.type === "evt" &&
              envelope.op === "session.end" &&
              typeof envelope.session_id === "string"
            ) {
              endFortivoiceSession({
                accountId: account.accountId,
                sessionId: envelope.session_id,
              });
              return;
            }
            if (!isFortivoiceRequestEnvelope(envelope)) {
              return;
            }
            await handleRequest({
              request: envelope,
              ws,
              account,
              cfg: config,
              runtime,
              logger,
              connectionId,
              nextSeq,
              statusSink,
            });
          })
          .catch((err) => {
            runtime.error?.(`fortivoice message handler failed: ${String(err)}`);
            statusSink?.({ lastError: formatError(err) });
          });
      });

      ws.on("close", (code, reason) => {
        abortSignal.removeEventListener("abort", onAbort);
        clearHandshakeTimer();
        const reasonText = reason.length > 0 ? reason.toString("utf8") : "";
        logger.info(
          `fortivoice disconnected from ${url}: code=${code} reason=${reasonText || "none"}`,
        );
        statusSink?.({
          connected: false,
          running: true,
          lastDisconnect: {
            at: Date.now(),
            status: code,
            ...(reasonText ? { error: reasonText } : {}),
          },
        });
        resolve();
      });

      ws.on("error", (err) => {
        const message = formatError(err);
        logger.error(`fortivoice websocket error: ${message}`);
        runtime.error?.(`fortivoice websocket error: ${message}`);
        statusSink?.({ lastError: message });
      });
    });
  };

  while (!abortSignal.aborted) {
    try {
      await connectOnce();
    } catch (err) {
      const message = formatError(err);
      logger.error(`fortivoice connection error: ${message}`);
      runtime.error?.(`fortivoice connection error: ${message}`);
      statusSink?.({ lastError: message, connected: false });
    }

    if (abortSignal.aborted) {
      break;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, reconnectDelayMs);
      if (!abortSignal.aborted) {
        abortSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
  }

  statusSink?.({
    running: false,
    connected: false,
    lastStopAt: Date.now(),
  });
}
