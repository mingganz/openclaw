import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileVoiceSkillManifest } from "./skill-metadata.js";

const tempDirs: string[] = [];

async function writeSkill(params: { workspaceDir: string; dirName: string; body: string }) {
  const skillDir = path.join(params.workspaceDir, "skills", params.dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), params.body, "utf8");
}

describe("compileVoiceSkillManifest", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("includes only eligible voice-enabled skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fortivoice-manifest-"));
    tempDirs.push(workspaceDir);

    await writeSkill({
      workspaceDir,
      dirName: "answer-faq",
      body: `---
name: answer_faq
description: FAQ skill
metadata: { "openclaw": { "voice": { "enabled": true, "intentExamples": ["what are your hours"], "requiredSlots": [], "optionalSlots": [], "toolRequired": false, "missingSlotPrompts": {}, "executionMode": "deterministic", "escalationPolicy": "on_low_confidence", "answerMode": "knowledge" } } }
---

# Approved FAQ Knowledge Base

## FAQ-001 — Hours

**Question examples**

- What are your hours?

**Answer**
We are open weekdays.
`,
    });
    await writeSkill({
      workspaceDir,
      dirName: "internal-only",
      body: `---
name: internal_only
description: Not voice enabled
---

# Internal
`,
    });
    await writeSkill({
      workspaceDir,
      dirName: "bad-voice",
      body: `---
name: bad_voice
description: Broken voice metadata
metadata: { "openclaw": { "voice": { "enabled": true, "intentExamples": [] } } }
---

# Broken
`,
    });

    const skipped: string[] = [];
    const manifest = compileVoiceSkillManifest({
      cfg: {},
      workspaceDir,
      skillAllowlist: ["answer_faq", "internal_only", "bad_voice"],
      onSkip: (message) => skipped.push(message),
    });

    expect(manifest.map((entry) => entry.skillName)).toEqual(["answer_faq"]);
    expect(manifest[0]?.answerData?.faqEntries?.[0]?.id).toBe("FAQ-001");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("bad_voice");
  });
});
