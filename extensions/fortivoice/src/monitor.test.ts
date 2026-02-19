import { describe, expect, it } from "vitest";
import { inferFortivoiceCollectActionFromPlainReply } from "./monitor.js";

describe("fortivoice monitor", () => {
  it("infers collect(city) when weather follow-up asks for city", () => {
    const action = inferFortivoiceCollectActionFromPlainReply({
      latestUserText: "What is the weather today?",
      assistantText: "Which city?",
    });

    expect(action).toEqual({
      type: "collect",
      schema: {
        fields: [{ key: "city", type: "string", required: true }],
      },
    });
  });

  it("does not infer collect when prompt is unrelated to weather", () => {
    const action = inferFortivoiceCollectActionFromPlainReply({
      latestUserText: "Can you summarize my notes?",
      assistantText: "Which city?",
    });

    expect(action).toBeNull();
  });

  it("does not infer collect when assistant is not asking for city", () => {
    const action = inferFortivoiceCollectActionFromPlainReply({
      latestUserText: "What is the weather today?",
      assistantText: "The weather is sunny right now.",
    });

    expect(action).toBeNull();
  });
});
