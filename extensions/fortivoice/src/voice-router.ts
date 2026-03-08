import { z } from "zod";
import type {
  VoiceEscalationPolicy,
  VoiceExecutionMode,
  VoiceSkillManifest,
} from "./skill-metadata.js";
import type { VoiceSessionSnapshot } from "./voice-session-state.js";
import { findBestFaqAnswer } from "./faq-knowledge.js";

const ROUTER_TRUST_THRESHOLD = 0.9;
const ROUTER_CLARIFY_THRESHOLD = 0.65;
const ROUTER_TIMEOUT_MS = 4_500;

const RouterSlotUpdateSchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .strict();

const RouterPayloadSchema = z
  .object({
    skill: z.string(),
    confidence: z.number().min(0).max(1),
    slotUpdates: z.array(RouterSlotUpdateSchema).optional().default([]),
    answerKey: z.string().optional().default(""),
    clarificationQuestion: z.string().optional().default(""),
    notes: z.string().optional().default(""),
  })
  .strict();

export type VoiceRouteDecision = {
  decision: "answer_now" | "ask_slot" | "wait_and_execute" | "clarify" | "fallback_agent";
  skill?: string;
  confidence: number;
  slots: Record<string, string>;
  missingSlots: string[];
  toolRequired: boolean;
  executionMode?: VoiceExecutionMode;
  escalationPolicy?: VoiceEscalationPolicy;
  answerKey?: string;
  clarificationQuestion?: string;
  reason?: string;
};

type RouterResponsePayload = z.infer<typeof RouterPayloadSchema>;

type CompactVoiceSkill = {
  n: string;
  t?: 1;
  e?: "agentic";
  r?: string[];
  x?: string[];
  m?: Record<string, string>;
  f?: Array<{
    i: string;
    q: string[];
  }>;
};

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function resolveModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "gpt-4o-mini";
  }
  if (!trimmed.includes("/")) {
    return trimmed;
  }
  const [provider, id] = trimmed.split("/", 2);
  if (provider === "openai" && id) {
    return id;
  }
  throw new Error(`FortiVoice router currently supports OpenAI-compatible models only: ${trimmed}`);
}

function compactFaqId(id: string, index: number): string {
  const matched = /^FAQ-(\d+)$/i.exec(id.trim());
  if (!matched) {
    return String(index + 1);
  }
  return String(Number.parseInt(matched[1] ?? String(index + 1), 10));
}

function expandFaqId(skill: VoiceSkillManifest, answerKey: string): string {
  const trimmed = answerKey.trim();
  if (!trimmed) {
    return "";
  }
  if (/^FAQ-\d+$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const normalized = String(Number.parseInt(trimmed, 10));
  const matched = skill.answerData?.faqEntries?.find(
    (entry, index) => compactFaqId(entry.id, index) === normalized,
  );
  return matched?.id ?? trimmed;
}

function compactSkill(skill: VoiceSkillManifest): CompactVoiceSkill {
  const compact: CompactVoiceSkill = {
    n: skill.skillName,
  };
  if (skill.toolRequired) {
    compact.t = 1;
  }
  if (skill.executionMode === "agentic") {
    compact.e = "agentic";
  }
  if (skill.requiredSlots.length > 0) {
    compact.r = skill.requiredSlots;
  }
  if (skill.answerData?.faqEntries?.length) {
    compact.f = skill.answerData.faqEntries.map((entry, index) => ({
      i: compactFaqId(entry.id, index),
      q: entry.questionExamples.slice(0, 2),
    }));
    return compact;
  }
  if (skill.intentExamples.length > 0) {
    compact.x = skill.intentExamples.slice(0, 3);
  }
  if (Object.keys(skill.missingSlotPrompts).length > 0) {
    compact.m = skill.missingSlotPrompts;
  }
  return compact;
}

function summarizeManifest(manifest: VoiceSkillManifest[]) {
  return manifest.map((skill) => compactSkill(skill));
}

function buildRouterPrompt(params: {
  text: string;
  manifest: VoiceSkillManifest[];
  sessionState: VoiceSessionSnapshot;
}): string {
  return JSON.stringify({
    u: params.text,
    s: {
      p: params.sessionState.pendingSkill ?? "",
      l: params.sessionState.lastSelectedSkill ?? "",
      o: params.sessionState.pendingSlots,
    },
    k: summarizeManifest(params.manifest),
  });
}

function selectSkill(
  payload: RouterResponsePayload,
  manifest: VoiceSkillManifest[],
  sessionState: VoiceSessionSnapshot,
): VoiceSkillManifest | undefined {
  const direct = manifest.find((entry) => entry.skillName === payload.skill);
  if (direct) {
    return direct;
  }
  if (sessionState.pendingSkill) {
    return manifest.find((entry) => entry.skillName === sessionState.pendingSkill);
  }
  return undefined;
}

function mergeSlots(
  sessionState: VoiceSessionSnapshot,
  payload: RouterResponsePayload,
): Record<string, string> {
  const merged = { ...sessionState.pendingSlots };
  for (const update of payload.slotUpdates) {
    const slotName = normalizeText(update.name);
    const value = normalizeText(update.value);
    if (!slotName || !value) {
      continue;
    }
    merged[slotName] = value;
  }
  return merged;
}

function buildRouterJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      skill: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      slotUpdates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            value: { type: "string" },
          },
          required: ["name", "value"],
        },
      },
      answerKey: { type: "string" },
      clarificationQuestion: { type: "string" },
      notes: { type: "string" },
    },
    required: ["skill", "confidence", "slotUpdates", "answerKey", "clarificationQuestion", "notes"],
  };
}

function parseRouterContent(content: string): RouterResponsePayload {
  const parsedJson = JSON.parse(content);
  const parsed = RouterPayloadSchema.safeParse(parsedJson);
  if (parsed.success) {
    return parsed.data;
  }

  // Backward-compatible local fallback for older mocked payloads during tests.
  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    !Array.isArray(parsedJson) &&
    typeof parsedJson.skill === "string" &&
    typeof parsedJson.confidence === "number"
  ) {
    const rawSlots = parsedJson.slots;
    const slotUpdates =
      rawSlots && typeof rawSlots === "object" && !Array.isArray(rawSlots)
        ? Object.entries(rawSlots).map(([name, value]) => ({
            name,
            value: String(value ?? ""),
          }))
        : [];
    const normalized = RouterPayloadSchema.safeParse({
      skill: parsedJson.skill,
      confidence: parsedJson.confidence,
      slotUpdates,
      answerKey: typeof parsedJson.answerKey === "string" ? parsedJson.answerKey : "",
      clarificationQuestion:
        typeof parsedJson.clarificationQuestion === "string"
          ? parsedJson.clarificationQuestion
          : "",
      notes: typeof parsedJson.notes === "string" ? parsedJson.notes : "",
    });
    if (normalized.success) {
      return normalized.data;
    }
  }

  throw new Error(
    `router returned invalid JSON payload: ${parsed.error.issues
      .map((issue) => issue.path.join(".") || issue.message)
      .join(", ")}`,
  );
}

function missingRequiredSlots(skill: VoiceSkillManifest, slots: Record<string, string>): string[] {
  return skill.requiredSlots.filter((slotName) => !normalizeText(slots[slotName] ?? ""));
}

function buildFallbackDecision(reason: string): VoiceRouteDecision {
  return {
    decision: "fallback_agent",
    confidence: 0,
    slots: {},
    missingSlots: [],
    toolRequired: false,
    reason,
  };
}

export function shouldEscalate(params: {
  confidence: number;
  skill?: VoiceSkillManifest;
}): boolean {
  if (!params.skill) {
    return true;
  }
  if (params.skill.escalationPolicy === "always") {
    return true;
  }
  if (params.skill.executionMode === "agentic") {
    return true;
  }
  return params.confidence < ROUTER_CLARIFY_THRESHOLD;
}

async function callOpenAiRouter(params: {
  text: string;
  manifest: VoiceSkillManifest[];
  sessionState: VoiceSessionSnapshot;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<RouterResponsePayload> {
  const apiKey = params.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for the FortiVoice router");
  }
  const baseUrl = (params.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveModelId(params.model),
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fortivoice_route",
          strict: true,
          schema: buildRouterJsonSchema(),
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Route telephony requests to skills using only the provided compact metadata. " +
            "Return strict JSON matching the schema. " +
            "Input JSON keys: u=utterance, s=session state, k=skills. " +
            "Session keys: p=pending skill, l=last selected skill, o=collected slots. " +
            "Skill keys: n=name, t=toolRequired(1=true), e=execution mode, r=required slots, x=intent examples, m=missing-slot prompts, f=faq options. " +
            "FAQ option keys: i=short faq id, q=question examples. " +
            "Prefer the pending skill when the caller is answering a previous slot question. " +
            "If the selected skill is answer_faq, set answerKey to the short FAQ id from i. " +
            "If the request is ambiguous but narrow, provide a short clarificationQuestion. " +
            "Do not answer the caller directly.",
        },
        {
          role: "user",
          content: buildRouterPrompt(params),
        },
      ],
    }),
    signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
  });

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }
    throw new Error(`router failed with HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  return parseRouterContent(content);
}

export async function routeVoiceTurn(params: {
  text: string;
  manifest: VoiceSkillManifest[];
  sessionState: VoiceSessionSnapshot;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<VoiceRouteDecision> {
  const text = normalizeText(params.text);
  if (!text) {
    return buildFallbackDecision("empty_input");
  }
  if (params.manifest.length === 0) {
    return buildFallbackDecision("no_voice_skills");
  }

  let payload: RouterResponsePayload;
  try {
    payload = await callOpenAiRouter({
      text,
      manifest: params.manifest,
      sessionState: params.sessionState,
      model: params.model ?? "gpt-4o-mini",
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      fetchImpl: params.fetchImpl,
    });
  } catch (error) {
    return buildFallbackDecision(error instanceof Error ? error.message : "router_failed");
  }

  const skill = selectSkill(payload, params.manifest, params.sessionState);
  if (!skill) {
    if (payload.confidence >= ROUTER_CLARIFY_THRESHOLD && payload.clarificationQuestion.trim()) {
      return {
        decision: "clarify",
        confidence: payload.confidence,
        slots: {},
        missingSlots: [],
        toolRequired: false,
        clarificationQuestion: payload.clarificationQuestion.trim(),
        reason: payload.notes.trim() || "router_clarify",
      };
    }
    return buildFallbackDecision("router_skill_not_found");
  }

  const slots = mergeSlots(params.sessionState, payload);
  const missingSlots = missingRequiredSlots(skill, slots);
  const confidence = payload.confidence;
  let answerKey = expandFaqId(skill, payload.answerKey);
  if (!answerKey && skill.answerData?.faqEntries?.length) {
    answerKey = findBestFaqAnswer(skill.answerData.faqEntries, text)?.id ?? "";
  }

  if (confidence < ROUTER_CLARIFY_THRESHOLD) {
    return {
      decision: "fallback_agent",
      skill: skill.skillName,
      confidence,
      slots,
      missingSlots,
      toolRequired: skill.toolRequired,
      executionMode: skill.executionMode,
      escalationPolicy: skill.escalationPolicy,
      answerKey: answerKey || undefined,
      reason: payload.notes.trim() || "low_confidence",
    };
  }

  if (missingSlots.length > 0) {
    return {
      decision: "ask_slot",
      skill: skill.skillName,
      confidence,
      slots,
      missingSlots,
      toolRequired: skill.toolRequired,
      executionMode: skill.executionMode,
      escalationPolicy: skill.escalationPolicy,
      answerKey: answerKey || undefined,
      reason: payload.notes.trim() || "missing_slots",
    };
  }

  if (skill.toolRequired) {
    return {
      decision: "wait_and_execute",
      skill: skill.skillName,
      confidence,
      slots,
      missingSlots: [],
      toolRequired: true,
      executionMode: skill.executionMode,
      escalationPolicy: skill.escalationPolicy,
      answerKey: answerKey || undefined,
      reason: payload.notes.trim() || "tool_required",
    };
  }

  if (confidence < ROUTER_TRUST_THRESHOLD && payload.clarificationQuestion.trim()) {
    return {
      decision: "clarify",
      skill: skill.skillName,
      confidence,
      slots,
      missingSlots: [],
      toolRequired: false,
      executionMode: skill.executionMode,
      escalationPolicy: skill.escalationPolicy,
      clarificationQuestion: payload.clarificationQuestion.trim(),
      answerKey: answerKey || undefined,
      reason: payload.notes.trim() || "clarify",
    };
  }

  return {
    decision: "answer_now",
    skill: skill.skillName,
    confidence,
    slots,
    missingSlots: [],
    toolRequired: false,
    executionMode: skill.executionMode,
    escalationPolicy: skill.escalationPolicy,
    answerKey: answerKey || undefined,
    reason: payload.notes.trim() || "answer_now",
  };
}
