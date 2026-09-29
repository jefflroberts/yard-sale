export function normalizeFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

const IGNORED_TOKENS = new Set([
  "a",
  "an",
  "and",
  "for",
  "generic",
  "of",
  "ornate",
  "the",
  "unbranded",
  "unknown",
  "with",
]);

const TOKEN_ALIASES: Record<string, string> = {
  decoration: "decor",
  decorative: "decor",
  tabletop: "top",
};

export function fingerprintSimilarity(left: string, right: string): number {
  const leftTokens = fingerprintTokens(left);
  const rightTokens = fingerprintTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (shared < 3) return 0;

  const containment = shared / Math.min(leftTokens.size, rightTokens.size);
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = shared / union;
  return containment * 0.65 + jaccard * 0.35;
}

const FALLBACK_MATCH_THRESHOLD = 0.72;

// Backstop for rescans the agent failed to link. Every token of the shorter fingerprint must appear in
// the longer one, so "ripper deck" never absorbs "vallely elephant deck" despite a high overlap score.
export function findFallbackMatch<T extends { id: string; fingerprint: string }>(
  fingerprint: string,
  known: T[],
  excludedIds: Set<string>,
): T | undefined {
  const tokens = fingerprintTokens(fingerprint);
  return known
    .filter((candidate) => !excludedIds.has(candidate.id))
    .map((candidate) => ({ candidate, score: fingerprintSimilarity(fingerprint, candidate.fingerprint) }))
    .filter(({ candidate, score }) => score >= FALLBACK_MATCH_THRESHOLD && tokensNested(tokens, fingerprintTokens(candidate.fingerprint)))
    .sort((left, right) => right.score - left.score)[0]?.candidate;
}

function tokensNested(left: Set<string>, right: Set<string>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  return [...smaller].every((token) => larger.has(token));
}

function fingerprintTokens(value: string): Set<string> {
  return new Set(
    normalizeFingerprint(value)
      .split(" ")
      .map((token) => TOKEN_ALIASES[token] ?? token)
      .filter((token) => token && !IGNORED_TOKENS.has(token)),
  );
}
