import { describe, expect, it } from "vitest";
import {
  createFortivoiceResponse,
  fortivoiceError,
  fortivoiceOk,
  isFortivoiceRequestEnvelope,
  parseFortivoiceEnvelope,
  parseRealtimeUpdate,
  shouldProcessRealtimeInput,
} from "./protocol.js";
import {
  consumeFortivoiceQueuedText,
  queueFortivoiceText,
  resolveFortivoiceSessionId,
  trackFortivoiceSession,
} from "./state.js";

describe("fortivoice protocol", () => {
  it("parses a request envelope and builds a response", () => {
    const parsed = parseFortivoiceEnvelope(
      JSON.stringify({
        v: 1,
        type: "req",
        req_id: "r1",
        session_id: "s1",
        seq: 1,
        ts: "2026-02-11T00:00:00.000Z",
        op: "session.update",
        payload: {
          realtime: {
            turn_id: "t1",
            input: {
              type: "user_utterance",
              text: "hello",
            },
          },
        },
      }),
    );

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("Expected parsed envelope");
    }
    expect(isFortivoiceRequestEnvelope(parsed)).toBe(true);
    if (!isFortivoiceRequestEnvelope(parsed)) {
      throw new Error("Expected request envelope");
    }

    const response = createFortivoiceResponse({
      request: parsed,
      seq: 2,
      payload: fortivoiceOk({ actions: [] }),
    });

    expect(response.type).toBe("res");
    expect(response.req_id).toBe("r1");
    expect(response.payload).toEqual({ ok: true, result: { actions: [] } });
  });

  it("extracts realtime input and filters to user/final utterances", () => {
    const update = parseRealtimeUpdate({
      realtime: {
        turn_id: "t1",
        input: {
          type: "user_utterance",
          text: "hello there",
        },
      },
    });

    expect(update).not.toBeNull();
    if (!update) {
      throw new Error("Expected realtime update");
    }
    expect(shouldProcessRealtimeInput(update)).toBe(true);

    const partial = parseRealtimeUpdate({
      realtime: {
        turn_id: "t2",
        input: {
          type: "transcript_partial",
          text: "partial",
        },
      },
    });

    expect(partial).not.toBeNull();
    if (!partial) {
      throw new Error("Expected realtime update");
    }
    expect(shouldProcessRealtimeInput(partial)).toBe(false);
  });

  it("tracks sessions and queues outbound text", () => {
    trackFortivoiceSession({
      accountId: "default",
      sessionId: "session-1",
      call: {
        callId: "call-1",
      },
    });

    expect(resolveFortivoiceSessionId({ accountId: "default", target: "call:call-1" })).toBe(
      "session-1",
    );

    const queued = queueFortivoiceText({
      accountId: "default",
      sessionId: "session-1",
      text: "hello world",
    });

    expect(queued.messageId).toContain("queued-");

    const batch = consumeFortivoiceQueuedText({
      accountId: "default",
      sessionId: "session-1",
    });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.text).toBe("hello world");
  });

  it("builds an error response payload", () => {
    expect(fortivoiceError("bad_request", "broken")).toEqual({
      ok: false,
      error: {
        code: "bad_request",
        message: "broken",
      },
    });
  });
});
