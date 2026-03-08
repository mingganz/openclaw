import type { OpenClawConfig } from "openclaw/plugin-sdk";
import fs from "node:fs";
import { z } from "zod";
import type { SkillEntry } from "../../../src/agents/skills/types.js";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../src/agents/agent-scope.js";
import {
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
} from "../../../src/agents/skills/workspace.js";
import { compileFaqKnowledgeFromMarkdown, type FaqKnowledgeEntry } from "./faq-knowledge.js";

const VoiceExecutionModeSchema = z.enum(["deterministic", "agentic"]);
const VoiceEscalationPolicySchema = z.enum(["never", "on_low_confidence", "always"]);
const VoiceAnswerModeSchema = z.enum(["knowledge", "template", "none"]);

const RawVoiceMetadataSchema = z
  .object({
    enabled: z.boolean(),
    intentExamples: z.array(z.string().min(1)).min(1),
    requiredSlots: z.array(z.string().min(1)).optional().default([]),
    optionalSlots: z.array(z.string().min(1)).optional().default([]),
    toolRequired: z.boolean().optional().default(false),
    missingSlotPrompts: z.record(z.string(), z.string()).optional().default({}),
    waitPrompt: z.string().optional(),
    executionMode: VoiceExecutionModeSchema.optional().default("deterministic"),
    escalationPolicy: VoiceEscalationPolicySchema.optional().default("on_low_confidence"),
    answerMode: VoiceAnswerModeSchema.optional().default("none"),
  })
  .strict();

export type VoiceExecutionMode = z.infer<typeof VoiceExecutionModeSchema>;
export type VoiceEscalationPolicy = z.infer<typeof VoiceEscalationPolicySchema>;
export type VoiceAnswerMode = z.infer<typeof VoiceAnswerModeSchema>;

export type VoiceAnswerData = {
  faqEntries?: FaqKnowledgeEntry[];
};

export type VoiceSkillManifest = {
  skillName: string;
  skillPath: string;
  intentExamples: string[];
  requiredSlots: string[];
  optionalSlots: string[];
  toolRequired: boolean;
  missingSlotPrompts: Record<string, string>;
  waitPrompt?: string;
  executionMode: VoiceExecutionMode;
  escalationPolicy: VoiceEscalationPolicy;
  answerMode: VoiceAnswerMode;
  answerData?: VoiceAnswerData;
};

function parseVoiceMetadataFromEntry(entry: SkillEntry) {
  const raw = entry.frontmatter.metadata;
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const openclaw = (parsed as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object") {
    return null;
  }
  const voice = (openclaw as Record<string, unknown>).voice;
  if (!voice || typeof voice !== "object") {
    return null;
  }
  return RawVoiceMetadataSchema.safeParse(voice);
}

function compileAnswerData(params: {
  entry: SkillEntry;
  answerMode: VoiceAnswerMode;
}): VoiceAnswerData | undefined {
  if (params.answerMode !== "knowledge") {
    return undefined;
  }
  const markdown = fs.readFileSync(params.entry.skill.filePath, "utf8");
  const faqEntries = compileFaqKnowledgeFromMarkdown(markdown);
  return faqEntries.length > 0 ? { faqEntries } : undefined;
}

function normalizeSkillAllowlist(allowlist?: string[]): Set<string> | null {
  const values = (allowlist ?? []).map((entry) => entry.trim()).filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

export function compileVoiceSkillManifest(params: {
  cfg: OpenClawConfig;
  skillAllowlist?: string[];
  workspaceDir?: string;
  onSkip?: (message: string) => void;
}): VoiceSkillManifest[] {
  const workspaceDir =
    params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  const skillEntries = filterWorkspaceSkillEntries(
    loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg }),
    params.cfg,
  );
  const allowlist = normalizeSkillAllowlist(params.skillAllowlist);
  const manifest: VoiceSkillManifest[] = [];

  for (const entry of skillEntries) {
    if (allowlist && !allowlist.has(entry.skill.name)) {
      continue;
    }
    const parsedVoice = parseVoiceMetadataFromEntry(entry);
    if (!parsedVoice) {
      continue;
    }
    if (!parsedVoice.success) {
      params.onSkip?.(
        `Skipping FortiVoice skill ${entry.skill.name}: invalid voice metadata (${parsedVoice.error.issues
          .map((issue) => issue.path.join(".") || issue.message)
          .join(", ")})`,
      );
      continue;
    }

    const voice = parsedVoice.data;
    if (!voice.enabled) {
      continue;
    }

    const answerData = compileAnswerData({
      entry,
      answerMode: voice.answerMode,
    });

    if (voice.answerMode === "knowledge" && !answerData?.faqEntries?.length) {
      params.onSkip?.(
        `Skipping FortiVoice skill ${entry.skill.name}: knowledge mode requires structured answer data`,
      );
      continue;
    }

    manifest.push({
      skillName: entry.skill.name,
      skillPath: entry.skill.filePath,
      intentExamples: voice.intentExamples.map((value) => value.trim()).filter(Boolean),
      requiredSlots: voice.requiredSlots.map((value) => value.trim()).filter(Boolean),
      optionalSlots: voice.optionalSlots.map((value) => value.trim()).filter(Boolean),
      toolRequired: voice.toolRequired,
      missingSlotPrompts: Object.fromEntries(
        Object.entries(voice.missingSlotPrompts).map(([key, value]) => [key.trim(), value.trim()]),
      ),
      waitPrompt: voice.waitPrompt?.trim() || undefined,
      executionMode: voice.executionMode,
      escalationPolicy: voice.escalationPolicy,
      answerMode: voice.answerMode,
      answerData,
    });
  }

  return manifest;
}
