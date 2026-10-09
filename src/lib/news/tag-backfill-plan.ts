/**
 * What a news-tag backfill WOULD do, decided without touching a database.
 *
 * `scripts/backfill-news-tags.ts` is a thin shell around this: read rows, call
 * `planNewsTagBackfill`, print it, and — only with `--apply` — write the
 * updates it names. Every decision that can be wrong lives here, where it can
 * be tested, which is the same split
 * `tests/unit/backfill-token-encryption.test.ts` uses for its own script.
 *
 * The one judgement worth stating up front: **this recomputes the column, it
 * does not fill in blanks.** The obvious implementation selects rows where
 * `tags` is empty, and it is wrong, because the vocabulary grows. «Пазар»
 * (`trade`) was added after the first items were tagged, so rows written
 * before it carry a tag set derived from a smaller vocabulary — they HAVE
 * tags, just not every tag they qualify for, and an empty-only pass would
 * leave them stale invisibly. Recomputing is safe because `deriveTags` is pure
 * and total, which also makes this idempotent and makes it the mechanism for
 * applying any future vocabulary change.
 *
 * @module lib/news/tag-backfill-plan
 */
import { deriveTags } from './categorize';

/** The fields a plan needs. A subset of `MarketNewsItem`, by design. */
export interface BackfillCandidate {
    id: string;
    title: string;
    summary: string | null;
    tags: string[];
    source: string;
}

export interface PlannedUpdate {
    id: string;
    from: string[];
    to: string[];
}

export interface BackfillPlan {
    /** Every row whose tags differ from what the current vocabulary derives. */
    updates: PlannedUpdate[];
    total: number;
    /** Was `[]`, now has something — the backfill doing its job. */
    gainedFirst: number;
    /** Already tagged, and the set differs — a vocabulary change landing. */
    changed: number;
    /** Derives to no tags at all. The number that judges the tagger. */
    untagged: number;
    /** Tag → how many articles carry it. An article can carry several. */
    distribution: Map<string, number>;
    /** Source → untagged count. A concentration is a vocabulary gap. */
    untaggedBySource: Map<string, number>;
}

/** Order-sensitive equality. `deriveTags` returns sorted, so this is safe. */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function planNewsTagBackfill(items: readonly BackfillCandidate[]): BackfillPlan {
    const updates: PlannedUpdate[] = [];
    const distribution = new Map<string, number>();
    const untaggedBySource = new Map<string, number>();
    let gainedFirst = 0;
    let changed = 0;
    let untagged = 0;

    for (const item of items) {
        const to = deriveTags(item.title, item.summary);
        for (const tag of to) distribution.set(tag, (distribution.get(tag) ?? 0) + 1);

        // Counted over the whole table, not over the updates — "how much of the
        // corpus does the vocabulary reach?" is a question about the corpus. A
        // row that was already correctly untagged still counts as untagged, and
        // reading this off the update list would under-report it to zero on a
        // second run.
        if (to.length === 0) {
            untagged += 1;
            untaggedBySource.set(item.source, (untaggedBySource.get(item.source) ?? 0) + 1);
        }

        if (sameTags(item.tags, to)) continue;
        updates.push({ id: item.id, from: item.tags, to });
        if (item.tags.length === 0) gainedFirst += 1;
        else changed += 1;
    }

    return {
        updates,
        total: items.length,
        gainedFirst,
        changed,
        untagged,
        distribution,
        untaggedBySource,
    };
}
