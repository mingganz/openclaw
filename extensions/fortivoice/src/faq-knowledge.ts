export type FaqKnowledgeEntry = {
  id: string;
  title: string;
  questionExamples: string[];
  answer: string;
};

type ScoredFaqEntry = {
  entry: FaqKnowledgeEntry;
  score: number;
};

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function computeSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  if (left.includes(right) || right.includes(left)) {
    return 0.92;
  }

  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

export function compileFaqKnowledgeFromMarkdown(markdown: string): FaqKnowledgeEntry[] {
  const sectionRegex = /^##\s+(FAQ-\d+)\s+—\s+(.+)$/gm;
  const sections: Array<{ id: string; title: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(markdown)) !== null) {
    sections.push({
      id: match[1] ?? "",
      title: (match[2] ?? "").trim(),
      start: match.index,
      end: sectionRegex.lastIndex,
    });
  }

  const entries: FaqKnowledgeEntry[] = [];
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const nextStart = sections[i + 1]?.start ?? markdown.length;
    const block = markdown.slice(section.start, nextStart);
    const questionBlockMatch = /\*\*Question examples\*\*([\s\S]*?)\*\*Answer\*\*/.exec(block);
    const answerBlockMatch = /\*\*Answer\*\*([\s\S]*?)$/.exec(block);
    const questionExamples = (questionBlockMatch?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
    const answer = (answerBlockMatch?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!section.id || questionExamples.length === 0 || !answer) {
      continue;
    }
    entries.push({
      id: section.id,
      title: section.title,
      questionExamples,
      answer,
    });
  }
  return entries;
}

export function findBestFaqAnswer(
  entries: FaqKnowledgeEntry[],
  utterance: string,
): FaqKnowledgeEntry | null {
  const normalizedUtterance = normalizeText(utterance);
  if (!normalizedUtterance) {
    return null;
  }

  let best: ScoredFaqEntry | null = null;
  for (const entry of entries) {
    const scores = entry.questionExamples.map((example) =>
      computeSimilarity(normalizedUtterance, normalizeText(example)),
    );
    scores.push(computeSimilarity(normalizedUtterance, normalizeText(entry.title)));
    const score = Math.max(...scores, 0);
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }

  return best && best.score >= 0.5 ? best.entry : null;
}
