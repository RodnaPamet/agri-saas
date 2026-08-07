/**
 * The dose / PHI / REI structural gate (PR 4 of 5, task C6).
 *
 * ════════════════════════════════════════════════════════════════════
 *  THE HARD RULE (product policy, not a style preference)
 * ════════════════════════════════════════════════════════════════════
 *
 *  "A dose rate, PHI (pre-harvest interval), or re-entry interval may
 *  appear in an article ONLY with a БАБХ (Bulgarian Food Safety Agency)
 *  registration number attached."
 *
 *  We do not have a licensed БАБХ registration dataset, so in practice
 *  this repository authors NO dose/PHI/REI content at all — this gate
 *  exists to CATCH a violation (including one a future contributor adds
 *  by accident), not to permit one. Content that genuinely needs a dose
 *  to be useful should say so in prose and point the reader at the
 *  official БАБХ register instead of guessing.
 *
 *  Both languages, both unit systems: Bulgarian farming quotes doses in
 *  декар (дка = 0.1 ha) far more than hectares, so a detector that only
 *  recognises `/ha` would miss most real Bulgarian dose text.
 *
 *  This module is wired into every content-authoring surface this PR
 *  touches — `ingestGlobalCorpus` (scripts/rag/corpus.ts) and
 *  `importKnowledge` (scripts/import-knowledge.ts) — so it fires at
 *  RUNTIME (not just as a CI text scan) and would catch a violation in
 *  content added later through those same paths. It is ALSO exercised
 *  directly by the CI guardrail `tests/guardrails/dose-phi-rei-gate.test.ts`,
 *  which scans the actual shipped corpora without needing a database.
 * ════════════════════════════════════════════════════════════════════
 */

/**
 * Dose-rate unit shapes: a number followed by a mass/volume unit, a
 * slash, and an area unit — in EITHER language, EITHER metric-area
 * convention (English agronomy text overwhelmingly uses hectares;
 * Bulgarian farming overwhelmingly uses декар/дка = 0.1 ha, so both
 * MUST be covered independently, not just as a language pair).
 *
 *   2 l/ha        200 ml/dka        150 г/дка        3 кг/ха
 *   0.5 л/дка     400 g/ha          150мл/дка        2.5 л/ха
 */
// NOTE: no trailing `\b` — JS `\b` is ASCII-word-boundary-only, so it never
// fires after a Cyrillic letter (Cyrillic isn't in `\w` for a non-unicode
// regex), which would silently defeat every Cyrillic unit here (дка/ха).
const DOSE_UNIT_PATTERN =
    /\d+(?:[.,]\d+)?\s*(?:ml|l|kg|g|mg|мл|л|кг|г|мг)\s*\/\s*(?:ha|dka|acre|ха|дка)/i;

/**
 * `%` used as a spray/working-solution concentration — deliberately
 * scoped to a nearby solution/concentration keyword so it does NOT
 * false-positive on ordinary agronomy percentages this corpus legitimately
 * uses (grain moisture at harvest, germination rate, humidity, etc.).
 * Both languages.
 */
const PERCENT_SOLUTION_PATTERN =
    /\d+(?:[.,]\d+)?\s*%\s*(?:working\s+)?(?:solution|concentration|spray\s+solution|разтвор|работен\s+разтвор|каша|концентрация)/i;

/** Pre-harvest interval — English + Bulgarian (карантинен срок). */
const PHI_PATTERN =
    /\bPHI\b|pre-?harvest\s+interval|days?\s+before\s+harvest|карантинен\s+срок|дни\s+преди\s+прибиране/i;

/**
 * Re-entry interval — English + Bulgarian. The brief's own wording uses
 * "въстановителен" (missing the "з" of the correct "възстановителен");
 * both spellings are matched — `з?` is optional, not `въ?з` (which would
 * only ever match the correct spelling) — since a real violation would
 * not reliably use the corrected form.
 */
const REI_PATTERN =
    /\bREI\b|re-?entry\s+interval|re-?entry\s+period|в[ъ]?з?становителен\s*(?:период|срок)?|влизане\s+в\s+третиран/i;

/**
 * A БАБХ (or generic) registration-number marker near the regulated
 * content — the ONE thing that may legally accompany a dose/PHI/REI.
 * Matches "БАБХ ... № ..." / "№ ... БАБХ" in either order, or a bare
 * "рег. №" / "registration no." marker. The trailing token MUST contain
 * a digit (`\d`) — without that, a phrase like "a registration number
 * from the official register" (no actual number, just the WORD
 * "number") would falsely satisfy this check and hand a violation an
 * unearned escape hatch. This was caught by this repo's own content:
 * see the mutation-proof test.
 */
const REG_TOKEN = '[\\w./-]*\\d[\\w./-]*';
const REGISTRATION_NUMBER_PATTERN = new RegExp(
    `(?:БАБХ|BABH)[^\\n]{0,60}?№\\s*${REG_TOKEN}` +
        `|№\\s*${REG_TOKEN}[^\\n]{0,60}?(?:БАБХ|BABH)` +
        `|рег(?:истрационен)?\\.?\\s*№\\s*${REG_TOKEN}` +
        `|registration\\s*(?:no\\.?|number)\\s*[:#]?\\s*${REG_TOKEN}`,
    'i',
);

export interface RegulatedContentViolation {
    /** Which regulated-content class matched. */
    kind: 'dose' | 'phi' | 'rei';
    /** The exact substring that matched, for a legible error. */
    matched: string;
}

/**
 * Scan free text for a dose rate / PHI / re-entry interval that appears
 * WITHOUT an adjacent БАБХ registration number. Pure function — no I/O,
 * safe to unit-test directly and to run in CI without a database.
 */
export function scanForUnregisteredRegulatedContent(text: string): RegulatedContentViolation[] {
    if (!text) return [];

    const hasRegistrationNumber = REGISTRATION_NUMBER_PATTERN.test(text);
    if (hasRegistrationNumber) return [];

    const violations: RegulatedContentViolation[] = [];

    const doseMatch = text.match(DOSE_UNIT_PATTERN) ?? text.match(PERCENT_SOLUTION_PATTERN);
    if (doseMatch) violations.push({ kind: 'dose', matched: doseMatch[0] });

    const phiMatch = text.match(PHI_PATTERN);
    if (phiMatch) violations.push({ kind: 'phi', matched: phiMatch[0] });

    const reiMatch = text.match(REI_PATTERN);
    if (reiMatch) violations.push({ kind: 'rei', matched: reiMatch[0] });

    return violations;
}

/**
 * Throws when `text` carries a dose rate, PHI, or re-entry interval with
 * no БАБХ registration number attached. `context` is a short label (e.g.
 * a `sourceRef` or article slug) folded into the error so a CI failure or
 * a runtime ingestion refusal is attributable to the offending entry.
 */
export function assertNoUnregisteredRegulatedContent(text: string, context: string): void {
    const violations = scanForUnregisteredRegulatedContent(text);
    if (violations.length === 0) return;

    const summary = violations
        .map((v) => `${v.kind.toUpperCase()} ("${v.matched.trim()}")`)
        .join(', ');
    throw new Error(
        `REFUSED: "${context}" carries regulated content [${summary}] without a БАБХ ` +
            `registration number attached. A dose rate, PHI, or re-entry interval may only ` +
            `appear alongside a real БАБХ registration number — this product has no licensed ` +
            `registration dataset, so this content must not be authored. Rewrite it as ` +
            `agronomy (BBCH stage, scouting threshold, cultural practice, timing without a ` +
            `rate) or point the reader at the official БАБХ register instead of stating a ` +
            `dose/PHI/REI. See scripts/rag/dose-phi-guard.ts.`,
    );
}
