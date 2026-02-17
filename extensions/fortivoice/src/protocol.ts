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

export type FortivoiceResponseEnvelope = FortivoiceEnvelope & {
  type: "res";
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

export type FortivoiceAction =
  | FortivoiceActionSpeak
  | FortivoiceActionCollect
  | FortivoiceActionEnd;

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

const COLLECT_FIELD_TYPES = new Set(["string", "number", "integer", "boolean", "date", "datetime"]);
const TRANSFER_MODES = new Set(["warm", "cold"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function parseActionSpeak(value: Record<string, unknown>): FortivoiceActionSpeak | null {
  const text = readString(value, "text")?.trim();
  if (!text) {
    return null;
  }
  const messageId = readString(value, "message_id")?.trim();
  const bargeIn = readBoolean(value, "barge_in");
  const voice = readRecord(value, "voice");
  const voiceName = voice ? readString(voice, "name")?.trim() : undefined;

  const action = createSpeakAction({
    text,
    ...(messageId ? { messageId } : {}),
    ...(bargeIn !== undefined ? { bargeIn } : {}),
  });
  if (voiceName) {
    action.voice = { name: voiceName };
  }
  return action;
}

function parseActionCollect(value: Record<string, unknown>): FortivoiceActionCollect | null {
  const schema = readRecord(value, "schema");
  if (!schema || !Array.isArray(schema.fields)) {
    return null;
  }

  const fields: FortivoiceActionCollect["schema"]["fields"] = [];
  for (const field of schema.fields) {
    if (!isRecord(field)) {
      return null;
    }
    const key = readString(field, "key")?.trim();
    const type = readString(field, "type");
    if (!key || !type || !COLLECT_FIELD_TYPES.has(type)) {
      return null;
    }
    const required = readBoolean(field, "required");
    fields.push({
      key,
      type: type as FortivoiceActionCollect["schema"]["fields"][number]["type"],
      ...(required === undefined ? {} : { required }),
    });
  }

  return {
    type: "collect",
    schema: { fields },
  };
}

function parseActionEnd(value: Record<string, unknown>): FortivoiceActionEnd | null {
  const reason = readString(value, "reason")?.trim();
  if (!reason) {
    return null;
  }

  const transferRaw = readRecord(value, "transfer");
  let transfer: FortivoiceActionEnd["transfer"] | undefined;
  if (transferRaw) {
    const to = readString(transferRaw, "to")?.trim();
    const mode = readString(transferRaw, "mode");
    if (!to) {
      return null;
    }
    if (mode && !TRANSFER_MODES.has(mode)) {
      return null;
    }
    transfer = {
      to,
      ...(mode ? { mode: mode as "warm" | "cold" } : {}),
    };
  }

  return {
    type: "end",
    reason,
    ...(transfer ? { transfer } : {}),
  };
}

function parseAction(value: unknown): FortivoiceAction | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = readString(value, "type");
  if (type === "speak") {
    return parseActionSpeak(value);
  }
  if (type === "collect") {
    return parseActionCollect(value);
  }
  if (type === "end") {
    return parseActionEnd(value);
  }
  return null;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  const fencedJsonRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fencedJsonRegex)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function parseActionsEnvelope(value: unknown): FortivoiceAction[] | null {
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    return null;
  }
  const actions: FortivoiceAction[] = [];
  for (const action of value.actions) {
    const parsed = parseAction(action);
    if (!parsed) {
      return null;
    }
    actions.push(parsed);
  }
  return actions;
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
  return (
    envelope.type === "req" && typeof envelope.req_id === "string" && envelope.req_id.length > 0
  );
}

export function isFortivoiceResponseEnvelope(
  envelope: FortivoiceEnvelope,
): envelope is FortivoiceResponseEnvelope {
  return (
    envelope.type === "res" && typeof envelope.req_id === "string" && envelope.req_id.length > 0
  );
}

export function createFortivoiceRequest(params: {
  reqId?: string;
  seq: number;
  op: string;
  sessionId?: string | null;
  payload: Record<string, unknown>;
}): FortivoiceRequestEnvelope {
  return {
    v: 1,
    type: "req",
    req_id: params.reqId ?? randomUUID(),
    session_id: params.sessionId ?? null,
    seq: params.seq,
    ts: nowIsoTimestamp(),
    op: params.op,
    payload: params.payload,
  };
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

export function parseFortivoiceResponsePayload(
  payload: Record<string, unknown>,
): FortivoiceResponsePayload | null {
  const ok = payload.ok;
  if (ok === true) {
    const result = readRecord(payload, "result");
    if (!result) {
      return null;
    }
    return { ok: true, result };
  }
  if (ok === false) {
    const error = readRecord(payload, "error");
    if (!error) {
      return null;
    }
    const code = readString(error, "code");
    const message = readString(error, "message");
    if (!code || !message) {
      return null;
    }
    return fortivoiceError(code, message, error.details);
  }
  return null;
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
  const direction =
    directionRaw === "inbound" || directionRaw === "outbound" ? directionRaw : undefined;
  return {
    callId: readString(call, "call_id"),
    from: readString(call, "from"),
    to: readString(call, "to"),
    direction,
  };
}

export function parseRealtimeUpdate(
  payload: Record<string, unknown>,
): FortivoiceRealtimeUpdate | null {
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
  return (
    update.inputType === "user_utterance" ||
    update.inputType === "transcript_final" ||
    update.inputType === "tool_result"
  );
}

export function parseFortivoiceActionsFromAssistantText(text: string): FortivoiceAction[] | null {
  for (const candidate of extractJsonCandidates(text)) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(candidate);
    } catch {
      continue;
    }
    const actions = parseActionsEnvelope(parsedJson);
    if (actions) {
      return actions;
    }
  }
  return null;
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
