import { describe, expect, it } from "vitest";
import {
  createFortivoiceRequest,
  createFortivoiceResponse,
  fortivoiceError,
  fortivoiceOk,
  isFortivoiceRequestEnvelope,
  isFortivoiceResponseEnvelope,
  parseFortivoiceActionsFromAssistantText,
  parseFortivoiceEnvelope,
  parseFortivoiceResponsePayload,
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
    expect(isFortivoiceResponseEnvelope(response)).toBe(true);
  });

  it("creates outbound system.hello request with phone number", () => {
    const request = createFortivoiceRequest({
      reqId: "hello-1",
      seq: 1,
      op: "system.hello",
      sessionId: null,
      payload: {
        client: {
          name: "openclaw-fortivoice",
          version: "1.2.3",
          phone: "+14155550123",
        },
        supports: {
          ops: ["system.ping", "session.start", "session.update", "session.end"],
        },
      },
    });

    expect(request).toMatchObject({
      v: 1,
      type: "req",
      req_id: "hello-1",
      session_id: null,
      seq: 1,
      op: "system.hello",
      payload: {
        client: {
          phone: "+14155550123",
        },
      },
    });
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

    const toolResult = parseRealtimeUpdate({
      realtime: {
        turn_id: "t3",
        input: {
          type: "tool_result",
          text: '{"status":"ok"}',
        },
      },
    });
    expect(toolResult).not.toBeNull();
    if (!toolResult) {
      throw new Error("Expected realtime update");
    }
    expect(shouldProcessRealtimeInput(toolResult)).toBe(true);
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

  it("parses ok/error response payload envelopes", () => {
    expect(parseFortivoiceResponsePayload({ ok: true, result: { accepted: true } })).toEqual({
      ok: true,
      result: { accepted: true },
    });
    expect(
      parseFortivoiceResponsePayload({ ok: false, error: { code: "denied", message: "no" } }),
    ).toEqual({
      ok: false,
      error: {
        code: "denied",
        message: "no",
      },
    });
    expect(parseFortivoiceResponsePayload({ ok: true })).toBeNull();
  });

  it("parses structured FortiVoice actions from assistant JSON block", () => {
    const parsed = parseFortivoiceActionsFromAssistantText(`\`\`\`json
{"actions":[{"type":"speak","message_id":"m1","text":"Please share your details."},{"type":"collect","schema":{"fields":[{"key":"full_name","type":"string","required":true},{"key":"email","type":"string","required":true}]}},{"type":"end","reason":"collection_complete"}]}
\`\`\``);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual([
      {
        type: "speak",
        message_id: "m1",
        text: "Please share your details.",
        barge_in: true,
      },
      {
        type: "collect",
        schema: {
          fields: [
            { key: "full_name", type: "string", required: true },
            { key: "email", type: "string", required: true },
          ],
        },
      },
      {
        type: "end",
        reason: "collection_complete",
      },
    ]);
  });

  it("returns null when assistant text does not contain valid action envelope", () => {
    expect(parseFortivoiceActionsFromAssistantText("Sure, I can help with that.")).toBeNull();
    expect(parseFortivoiceActionsFromAssistantText('{"actions":[{"type":"collect"}]}')).toBeNull();
  });
});
