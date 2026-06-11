export interface GroundingCheck {
  ok: boolean;
  /** Values claimed in the result that never appeared in any observation. */
  ungrounded: string[];
}

/**
 * Deterministic anti-fabrication check, run in code rather than left to a
 * model's judgment: every concrete value in a done(success=true) result —
 * URLs, emails, currency amounts — must appear verbatim somewhere in the
 * observed page texts. Conservative by design: it only checks value shapes
 * with near-zero false-positive risk.
 */
export function checkDataGrounding(result: string, observedTexts: string[]): GroundingCheck {
  const haystack = normalize(observedTexts);
  const candidates = new Set<string>();

  for (const match of result.matchAll(/https?:\/\/[^\s)"'>\]]+/g)) {
    candidates.add(match[0].replace(/[.,;]$/, ''));
  }
  for (const match of result.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) {
    candidates.add(match[0]);
  }
  for (const match of result.matchAll(/[$€£₹]\s?\d[\d,]*(?:\.\d+)?/g)) {
    candidates.add(match[0]);
  }

  const ungrounded = [...candidates].filter(
    (candidate) => !haystack.includes(normalize([candidate]).trim()),
  );
  return { ok: ungrounded.length === 0, ungrounded };
}

function normalize(texts: string[]): string {
  return texts.join('\n').replace(/\s+/g, ' ').toLowerCase();
}
