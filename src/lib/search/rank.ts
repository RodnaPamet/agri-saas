/**
 * Pure ranking helpers for the unified search.
 *
 * Pulled out of the usecase so the scoring rules are unit-
 * testable without touching Prisma. The function here is the
 * ONLY place that decides hit ordering — the API contract
 * promises score-DESC ordering, so a future change to the rule
 * lands in one place and propagates everywhere.
 *
 * Scoring rule (higher is better):
 *
 *   exact match on normalised title/code      → 100
 *   prefix match on normalised title/code     →  60
 *   substring match in normalised title       →  30
 *   substring match in normalised subtitle    →  10
 *   plus per-type baseline so ties break by
 *   "user is more likely to want a control
 *    than an evidence row"                    → +0..4
 *
 * Numbers are arbitrary but spaced so the bands are visually
 * obvious in test snapshots (a substring hit can't accidentally
 * outrank an exact hit even if the type baseline is high).
 */

import type { SearchHit, SearchHitType } from './types';

// ─── Per-type baseline ────────────────────────────────────────────────

/**
 * Tiebreak hint when two hits across different kinds match the
 * query equally well. Bias toward the entities operators search
 * for most often in the palette (controls > policies >
 * frameworks > evidence). Magnitudes are tiny relative to the
 * match-quality bands so ranking is dominated by relevance, not
 * type bias.
 */
const TYPE_BASELINE: Record<SearchHitType, number> = {
    control: 7,
    task: 5,
    policy: 4,
    asset: 2,
    framework: 1,
    evidence: 0,
    knowledge: 0,
};

// ─── Normalise ────────────────────────────────────────────────────────

function normalise(s: string | null | undefined): string {
    return (s ?? '').trim().toLowerCase();
}

// ─── Rank ─────────────────────────────────────────────────────────────

export interface RankInput {
    type: SearchHitType;
    title: string;
    subtitle?: string | null;
    /** Optional code (control code, framework key) — exact-match candidate. */
    code?: string | null;
}

export function computeRankScore(query: string, input: RankInput): number {
    const q = normalise(query);
    if (!q) return 0;
    const title = normalise(input.title);
    const subtitle = normalise(input.subtitle);
    const code = normalise(input.code);

    let score = 0;
    // Exact match on either the code or the title — strongest signal.
    if (code === q || title === q) {
        score += 100;
    } else if (code.startsWith(q) || title.startsWith(q)) {
        // Prefix — strong signal for "I started typing what I want".
        score += 60;
    } else if (title.includes(q)) {
        score += 30;
    } else if (subtitle.includes(q)) {
        score += 10;
    }
    return score + TYPE_BASELINE[input.type];
}

// ─── Sort + cap ────────────────────────────────────────────────────────

/**
 * Sort hits by score DESC with deterministic id tiebreaker. The
 * id tiebreak makes two equally-scored hits land in a stable
 * order across requests — useful for snapshot tests, useful for
 * users who can predict where the second-best match will sit.
 */
export function sortHits(hits: ReadonlyArray<SearchHit>): SearchHit[] {
    return [...hits].sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.type !== b.type) return TYPE_BASELINE[b.type] - TYPE_BASELINE[a.type];
        return a.id.localeCompare(b.id);
    });
}

/**
 * Apply per-type cap AFTER ranking, so the highest-scoring hits
 * within each type survive even when the underlying DB returned
 * more rows than the cap allows.
 */
export function capPerType(
    hits: ReadonlyArray<SearchHit>,
    limit: number,
): { kept: SearchHit[]; perTypeCounts: Record<SearchHitType, number>; truncated: boolean } {
    const counts: Record<SearchHitType, number> = {
        control: 0,
        policy: 0,
        framework: 0,
        evidence: 0,
        asset: 0,
        task: 0,
        knowledge: 0,
    };
    const kept: SearchHit[] = [];
    let truncated = false;
    // Iterate in score-DESC order (caller pre-sorts).
    for (const hit of hits) {
        if (counts[hit.type] < limit) {
            counts[hit.type] += 1;
            kept.push(hit);
        } else {
            truncated = true;
        }
    }
    return { kept, perTypeCounts: counts, truncated };
}
