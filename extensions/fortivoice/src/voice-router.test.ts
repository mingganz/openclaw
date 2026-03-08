import { describe, expect, it } from "vitest";
import type { VoiceSkillManifest } from "./skill-metadata.js";
import { routeVoiceTurn } from "./voice-router.js";

const manifest: VoiceSkillManifest[] = [
  {
    skillName: "answer_faq",
    skillPath: "/tmp/answer-faq/SKILL.md",
    intentExamples: ["what are your hours", "where are you located"],
    requiredSlots: [],
    optionalSlots: [],
    toolRequired: false,
    missingSlotPrompts: {},
    executionMode: "deterministic",
    escalationPolicy: "on_low_confidence",
    answerMode: "knowledge",
    answerData: {
      faqEntries: [
        {
          id: "FAQ-001",
          title: "Business Hours",
          questionExamples: ["What are your hours?", "When are you open?"],
          answer: "We are open weekdays.",
        },
      ],
    },
  },
  {
    skillName: "weather",
    skillPath: "/tmp/weather/SKILL.md",
    intentExamples: ["what is the weather today", "weather in ottawa"],
    requiredSlots: ["city"],
    optionalSlots: [],
    toolRequired: true,
    missingSlotPrompts: { city: "What city should I check?" },
    waitPrompt: "One moment while I check that.",
    executionMode: "deterministic",
    escalationPolicy: "on_low_confidence",
    answerMode: "none",
  },
];

function mockFetchWithPayload(payload: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(payload),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;
}

describe("routeVoiceTurn", () => {
  it("returns answer_now for FAQ", async () => {
    const decision = await routeVoiceTurn({
      text: "What are your hours?",
      manifest,
      sessionState: { pendingSlots: {} },
      apiKey: "test-key",
      fetchImpl: mockFetchWithPayload({
        skill: "answer_faq",
        confidence: 0.97,
        slotUpdates: [],
        answerKey: "FAQ-001",
        clarificationQuestion: "",
        notes: "faq match",
      }),
    });

    expect(decision.decision).toBe("answer_now");
    expect(decision.skill).toBe("answer_faq");
    expect(decision.answerKey).toBe("FAQ-001");
  });

  it("maps compact FAQ ids back to the stored FAQ entry id", async () => {
    const decision = await routeVoiceTurn({
      text: "What are your hours?",
      manifest,
      sessionState: { pendingSlots: {} },
      apiKey: "test-key",
      fetchImpl: mockFetchWithPayload({
        skill: "answer_faq",
        confidence: 0.97,
        slotUpdates: [],
        answerKey: "1",
        clarificationQuestion: "",
        notes: "faq match",
      }),
    });

    expect(decision.decision).toBe("answer_now");
    expect(decision.answerKey).toBe("FAQ-001");
  });

  it("returns ask_slot when weather city is missing", async () => {
    const decision = await routeVoiceTurn({
      text: "What is the weather today?",
      manifest,
      sessionState: { pendingSlots: {} },
      apiKey: "test-key",
      fetchImpl: mockFetchWithPayload({
        skill: "weather",
        confidence: 0.95,
        slotUpdates: [],
        answerKey: "",
        clarificationQuestion: "",
        notes: "missing city",
      }),
    });

    expect(decision.decision).toBe("ask_slot");
    expect(decision.missingSlots).toEqual(["city"]);
  });

  it("returns wait_and_execute when weather city is present", async () => {
    const decision = await routeVoiceTurn({
      text: "What is the weather in Ottawa?",
      manifest,
      sessionState: { pendingSlots: {} },
      apiKey: "test-key",
      fetchImpl: mockFetchWithPayload({
        skill: "weather",
        confidence: 0.96,
        slotUpdates: [{ name: "city", value: "Ottawa" }],
        answerKey: "",
        clarificationQuestion: "",
        notes: "ready",
      }),
    });

    expect(decision.decision).toBe("wait_and_execute");
    expect(decision.slots.city).toBe("Ottawa");
  });

  it("uses pending skill context for slot carry-over", async () => {
    const decision = await routeVoiceTurn({
      text: "Ottawa",
      manifest,
      sessionState: {
        pendingSkill: "weather",
        lastSelectedSkill: "weather",
        pendingSlots: {},
      },
      apiKey: "test-key",
      fetchImpl: mockFetchWithPayload({
        skill: "",
        confidence: 0.91,
        slotUpdates: [{ name: "city", value: "Ottawa" }],
        answerKey: "",
        clarificationQuestion: "",
        notes: "slot follow-up",
      }),
    });

    expect(decision.skill).toBe("weather");
    expect(decision.decision).toBe("wait_and_execute");
    expect(decision.slots.city).toBe("Ottawa");
  });

  it("falls back to the full agent on low confidence", async () => {
    const decision = await routeVoiceTurn({
      text: "I need help with my account",
      manifest,
      sessionState: { pendingSlots: {} },
      apiKey: "test-key",
      fetchImpl: mockFetchWithPayload({
        skill: "answer_faq",
        confidence: 0.41,
        slotUpdates: [],
        answerKey: "",
        clarificationQuestion: "",
        notes: "unclear",
      }),
    });

    expect(decision.decision).toBe("fallback_agent");
  });

  it("sends the OpenAI router schema with slotUpdates", async () => {
    let requestBody = "";
    const fetchImpl = (async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  skill: "answer_faq",
                  confidence: 0.99,
                  slotUpdates: [],
                  answerKey: "FAQ-001",
                  clarificationQuestion: "",
                  notes: "faq match",
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    await routeVoiceTurn({
      text: "What are your hours?",
      manifest,
      sessionState: { pendingSlots: {} },
      apiKey: "test-key",
      fetchImpl,
    });

    expect(requestBody).toContain('"slotUpdates"');
    expect(requestBody).not.toContain('"required":["skill","confidence","slots"');
    expect(requestBody).toContain('\\"u\\":\\"What are your hours?\\"');
    expect(requestBody).toContain('\\"f\\":[{\\"i\\":\\"1\\"');
    expect(requestBody).not.toContain('"title"');
    expect(requestBody).not.toContain('"faqOptions"');
    expect(requestBody).not.toContain('"intentExamples"');
  });
});
