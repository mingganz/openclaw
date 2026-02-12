import { randomUUID } from "node:crypto";

export type FortivoiceEnvelopeType = "req" | "res" | "evt";

export type FortivoiceEnvelope = {
  v: 1;
  type: FortivoiceEnvelopeType;
  req_id?: string;
  session_id?: string | null;
  seq: number;
  ts: string;
  op: string;
  payload: Record<string, unknown>;
};

export type FortivoiceRequestEnvelope = FortivoiceEnvelope & {
  type: "req";
  req_id: string;
};

export type FortivoiceResponsePayload =
  | {
      ok: true;
      result: Record<string, unknown>;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

export type FortivoiceActionSpeak = {
  type: "speak";
  message_id: string;
  text: string;
  barge_in?: boolean;
  voice?: {
    name?: string;
  };
};

export type FortivoiceActionCollect = {
  type: "collect";
  schema: {
    fields: Array<{
      key: string;
      type: "string" | "number" | "integer" | "boolean" | "date" | "datetime";
      required?: boolean;
    }>;
  };
};

export type FortivoiceActionEnd = {
  type: "end";
  reason: string;
  transfer?: {
    to: string;
    mode?: "warm" | "cold";
  };
};

export type FortivoiceAction = FortivoiceActionSpeak | FortivoiceActionCollect | FortivoiceActionEnd;

export type FortivoiceRealtimeUpdate = {
  turnId: string;
  inputType?: string;
  text: string;
};

export type FortivoiceSessionStartPayload = {
  callId?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}

export function parseFortivoiceEnvelope(raw: string): FortivoiceEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const type = readString(parsed, "type");
  const op = readString(parsed, "op");
  const seq = readNumber(parsed, "seq");
  const ts = readString(parsed, "ts");
  const payload = parsed.payload;
  if (
    parsed.v !== 1 ||
    (type !== "req" && type !== "res" && type !== "evt") ||
    typeof op !== "string" ||
    typeof ts !== "string" ||
    typeof seq !== "number" ||
    !isRecord(payload)
  ) {
    return null;
  }
  const reqId = readString(parsed, "req_id");
  const sessionIdRaw = parsed.session_id;
  const sessionId =
    typeof sessionIdRaw === "string" || sessionIdRaw === null ? sessionIdRaw : undefined;

  return {
    v: 1,
    type,
    req_id: reqId,
    session_id: sessionId,
    seq,
    ts,
    op,
    payload,
  };
}

export function isFortivoiceRequestEnvelope(
  envelope: FortivoiceEnvelope,
): envelope is FortivoiceRequestEnvelope {
  return envelope.type === "req" && typeof envelope.req_id === "string" && envelope.req_id.length > 0;
}

export function createFortivoiceResponse(params: {
  request: FortivoiceRequestEnvelope;
  seq: number;
  payload: FortivoiceResponsePayload;
}): FortivoiceEnvelope {
  return {
    v: 1,
    type: "res",
    req_id: params.request.req_id,
    session_id: params.request.session_id ?? null,
    seq: params.seq,
    ts: nowIsoTimestamp(),
    op: params.request.op,
    payload: params.payload as unknown as Record<string, unknown>,
  };
}

export function fortivoiceOk(result: Record<string, unknown>): FortivoiceResponsePayload {
  return {
    ok: true,
    result,
  };
}

export function fortivoiceError(
  code: string,
  message: string,
  details?: unknown,
): FortivoiceResponsePayload {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function createSpeakAction(params: {
  text: string;
  messageId?: string;
  bargeIn?: boolean;
}): FortivoiceActionSpeak {
  return {
    type: "speak",
    message_id: params.messageId ?? randomUUID(),
    text: params.text,
    barge_in: params.bargeIn ?? true,
  };
}

export function parseSessionStartPayload(
  payload: Record<string, unknown>,
): FortivoiceSessionStartPayload {
  const call = payload.call;
  if (!isRecord(call)) {
    return {};
  }
  const directionRaw = readString(call, "direction");
  const direction = directionRaw === "inbound" || directionRaw === "outbound" ? directionRaw : undefined;
  return {
    callId: readString(call, "call_id"),
    from: readString(call, "from"),
    to: readString(call, "to"),
    direction,
  };
}

export function parseRealtimeUpdate(payload: Record<string, unknown>): FortivoiceRealtimeUpdate | null {
  const realtime = payload.realtime;
  if (!isRecord(realtime)) {
    return null;
  }
  const turnId = readString(realtime, "turn_id");
  const input = realtime.input;
  if (!turnId || !isRecord(input)) {
    return null;
  }
  const text = readString(input, "text") ?? "";
  return {
    turnId,
    inputType: readString(input, "type"),
    text,
  };
}

export function shouldProcessRealtimeInput(update: FortivoiceRealtimeUpdate): boolean {
  const text = update.text.trim();
  if (!text) {
    return false;
  }
  return update.inputType === "user_utterance" || update.inputType === "transcript_final";
}

export function normalizeFortivoiceTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("fortivoice:")) {
    return trimmed.slice("fortivoice:".length).trim() || undefined;
  }
  return trimmed;
}
