import { randomUUID } from "node:crypto";
import type { FortivoiceCallInfo } from "./types.js";
import { normalizeFortivoiceTarget } from "./protocol.js";

type QueuedMessage = {
  messageId: string;
  text: string;
  createdAt: number;
};

type SessionState = {
  sessionId: string;
  callId?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
  lastSeenAt: number;
};

type AccountState = {
  latestSessionId?: string;
  sessions: Map<string, SessionState>;
  callToSession: Map<string, string>;
  queuedBySession: Map<string, QueuedMessage[]>;
};

const accountStates = new Map<string, AccountState>();

function getAccountState(accountId: string): AccountState {
  let state = accountStates.get(accountId);
  if (!state) {
    state = {
      sessions: new Map(),
      callToSession: new Map(),
      queuedBySession: new Map(),
    };
    accountStates.set(accountId, state);
  }
  return state;
}

export function trackFortivoiceSession(params: {
  accountId: string;
  sessionId: string;
  call?: FortivoiceCallInfo;
}) {
  const state = getAccountState(params.accountId);
  const existing = state.sessions.get(params.sessionId);
  const next: SessionState = {
    sessionId: params.sessionId,
    callId: params.call?.callId ?? existing?.callId,
    from: params.call?.from ?? existing?.from,
    to: params.call?.to ?? existing?.to,
    direction: params.call?.direction ?? existing?.direction,
    lastSeenAt: Date.now(),
  };
  state.latestSessionId = params.sessionId;
  state.sessions.set(params.sessionId, next);
  if (next.callId) {
    state.callToSession.set(next.callId, params.sessionId);
  }
}

export function resolveFortivoiceSessionId(params: {
  accountId: string;
  target?: string | null;
}): string | undefined {
  const state = getAccountState(params.accountId);
  const normalizedTarget = params.target ? normalizeFortivoiceTarget(params.target) : undefined;

  if (!normalizedTarget) {
    return state.latestSessionId;
  }

  if (normalizedTarget.toLowerCase().startsWith("session:")) {
    const sessionId = normalizedTarget.slice("session:".length).trim();
    if (!sessionId) {
      return undefined;
    }
    return state.sessions.has(sessionId) ? sessionId : undefined;
  }

  if (normalizedTarget.toLowerCase().startsWith("call:")) {
    const callId = normalizedTarget.slice("call:".length).trim();
    if (!callId) {
      return undefined;
    }
    return state.callToSession.get(callId);
  }

  if (state.sessions.has(normalizedTarget)) {
    return normalizedTarget;
  }

  return state.callToSession.get(normalizedTarget);
}

export function queueFortivoiceText(params: {
  accountId: string;
  sessionId: string;
  text: string;
}): { messageId: string } {
  const state = getAccountState(params.accountId);
  const queue = state.queuedBySession.get(params.sessionId) ?? [];
  const messageId = `queued-${randomUUID()}`;
  queue.push({
    messageId,
    text: params.text,
    createdAt: Date.now(),
  });
  state.queuedBySession.set(params.sessionId, queue);
  return { messageId };
}

export function consumeFortivoiceQueuedText(params: {
  accountId: string;
  sessionId: string;
}): QueuedMessage[] {
  const state = getAccountState(params.accountId);
  const queue = state.queuedBySession.get(params.sessionId) ?? [];
  state.queuedBySession.delete(params.sessionId);
  return queue;
}

export function hasActiveFortivoiceSession(accountId: string): boolean {
  const state = getAccountState(accountId);
  return state.sessions.size > 0;
}

export function endFortivoiceSession(params: { accountId: string; sessionId: string }) {
  const state = getAccountState(params.accountId);
  state.sessions.delete(params.sessionId);
  state.queuedBySession.delete(params.sessionId);
  for (const [callId, sessionId] of state.callToSession.entries()) {
    if (sessionId === params.sessionId) {
      state.callToSession.delete(callId);
    }
  }
  if (state.latestSessionId === params.sessionId) {
    state.latestSessionId = Array.from(state.sessions.keys()).at(-1);
  }
}
