/**
 * What the news-tag backfill decides, tested without a database.
 *
 * `scripts/backfill-news-tags.ts` is a shell: read, print, write. Every
 * decision is in `planNewsTagBackfill`, so this is where the script is
 * actually verified — the same split
 * `tests/unit/backfill-token-encryption.test.ts` uses.
 *
 * Two of these cases exist because the obvious implementation gets them
 * wrong, and both failures are silent:
 *
 *   · **selecting only empty rows.** The vocabulary GROWS. «Пазар» arrived
 *     after the first items were tagged, so those rows hold a tag set derived
 *     from a smaller vocabulary. They have tags, so an empty-only pass skips
 *     them, and they stay permanently short of a tag they qualify for with
 *     nothing to indicate it.
 *   · **counting `untagged` off the update list.** An article that matches
 *     nothing produces no update, so reading the count from the updates gives
 *     zero — on the first run it is merely wrong, and on a second run it
 *     reports a perfectly-tagged corpus. That number is the one the owner
 *     asked to see first, because it judges the tagger rather than the run.
 */
import {
    planNewsTagBackfill,
    sameTags,
    type BackfillCandidate,
} from '@/lib/news/tag-backfill-plan';
import { deriveTags } from '@/lib/news/categorize';

function row(over: Partial<BackfillCandidate> & { id: string }): BackfillCandidate {
    return {
        title: 'Нещо се случи',
        summary: null,
        tags: [],
        source: 'agri.bg',
        ...over,
    };
}

/** A title that reliably tags, taken from the tagger rather than assumed. */
const WHEAT_PRICES = 'Цените на пшеницата се повишиха';

describe('the backfill plan', () => {
    it('control: the fixture really does tag, so the suite is not vacuous', () => {
        // Every case below depends on this title producing tags. If the
        // vocabulary changed under it, these tests would all pass by agreeing
        // that nothing happens.
        const tags = deriveTags(WHEAT_PRICES, null);

        expect(tags).toContain('wheat');
        expect(tags).toContain('prices');
    });

    it('an untagged article gains its first tags', () => {
        const plan = planNewsTagBackfill([row({ id: 'a', title: WHEAT_PRICES, tags: [] })]);

        expect(plan.gainedFirst).toBe(1);
        expect(plan.changed).toBe(0);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0]).toMatchObject({ id: 'a', from: [] });
        expect(plan.updates[0].to).toContain('wheat');
    });

    it('an already-correct article produces NO update', () => {
        const correct = deriveTags(WHEAT_PRICES, null);
        const plan = planNewsTagBackfill([row({ id: 'a', title: WHEAT_PRICES, tags: correct })]);

        expect(plan.updates).toHaveLength(0);
        expect(plan.gainedFirst).toBe(0);
        expect(plan.changed).toBe(0);
    });

    it('a PARTIALLY tagged article is corrected — the vocabulary-growth case', () => {
        // This is the row an empty-only pass skips forever. Tagged this
        // morning with the then-current vocabulary, now short of «Пазар».
        const stale = ['wheat'];
        const plan = planNewsTagBackfill([
            row({ id: 'a', title: 'Пазарът на пшеница се възстановява', tags: stale }),
        ]);

        expect(plan.changed).toBe(1);
        expect(plan.gainedFirst).toBe(0);
        expect(plan.updates[0].from).toEqual(['wheat']);
        expect(plan.updates[0].to).toContain('trade');
        expect(plan.updates[0].to).toContain('wheat');
    });

    it('is idempotent: applying the plan leaves nothing for a second run', () => {
        // The script is safe to re-run, and that claim is worth a test rather
        // than a docblock. Re-planning the OUTPUT must be empty.
        const items = [
            row({ id: 'a', title: WHEAT_PRICES }),
            row({ id: 'b', title: 'Пазарът на царевица', tags: ['maize'] }),
            row({ id: 'c', title: 'Нищо особено днес' }),
        ];
        const first = planNewsTagBackfill(items);
        const applied = items.map((item) => {
            const update = first.updates.find((u) => u.id === item.id);
            return update ? { ...item, tags: update.to } : item;
        });

        const second = planNewsTagBackfill(applied);

        expect(first.updates.length).toBeGreaterThan(0);
        expect(second.updates).toHaveLength(0);
    });

    it('counts untagged over the CORPUS, not over the updates', () => {
        // An article matching nothing yields no update. Counting off the
        // update list would report 0 untagged here, and would keep reporting 0
        // on every subsequent run of a corpus half of which matches nothing.
        const plan = planNewsTagBackfill([
            row({ id: 'a', title: WHEAT_PRICES }),
            row({ id: 'b', title: 'Нищо особено днес' }),
            row({ id: 'c', title: 'Общо събрание в село' }),
        ]);

        expect(plan.total).toBe(3);
        expect(plan.untagged).toBe(2);
        expect(plan.updates).toHaveLength(1);
    });

    it('untagged stays correct on a SECOND run, when there are no updates left', () => {
        // The sharpest version of the case above: after applying, the update
        // list is empty, and a plan that derived `untagged` from it would
        // declare a fully-tagged corpus.
        const items = [row({ id: 'b', title: 'Нищо особено днес' })];
        const plan = planNewsTagBackfill(items);

        expect(plan.updates).toHaveLength(0);
        expect(plan.untagged).toBe(1);
    });

    it('distribution counts ARTICLES per tag, and an article can carry several', () => {
        const plan = planNewsTagBackfill([
            row({ id: 'a', title: WHEAT_PRICES }),
            row({ id: 'b', title: 'Цените на царевицата паднаха' }),
        ]);

        // Both are price stories; one wheat, one maize.
        expect(plan.distribution.get('prices')).toBe(2);
        expect(plan.distribution.get('wheat')).toBe(1);
        expect(plan.distribution.get('maize')).toBe(1);
    });

    it('untaggedBySource attributes the gap to a feed', () => {
        const plan = planNewsTagBackfill([
            row({ id: 'a', title: 'Нищо особено', source: 'feed-one' }),
            row({ id: 'b', title: 'Общо събрание', source: 'feed-one' }),
            row({ id: 'c', title: WHEAT_PRICES, source: 'feed-two' }),
        ]);

        expect(plan.untaggedBySource.get('feed-one')).toBe(2);
        expect(plan.untaggedBySource.has('feed-two')).toBe(false);
    });

    it('an empty table plans nothing and divides by nothing', () => {
        const plan = planNewsTagBackfill([]);

        expect(plan).toMatchObject({ total: 0, untagged: 0, gainedFirst: 0, changed: 0 });
        expect(plan.updates).toHaveLength(0);
    });

    it('the summary is read, not just the title', () => {
        // The pull stores a summary and the tagger takes both. A planner that
        // passed only the title would under-tag every article whose subject is
        // named in the body — and would look correct on any fixture whose
        // title happens to carry the keyword.
        const plan = planNewsTagBackfill([
            row({ id: 'a', title: 'Новини от сектора', summary: WHEAT_PRICES }),
        ]);

        expect(plan.updates[0].to).toContain('wheat');
    });
});

describe('sameTags', () => {
    it('is order-sensitive, which is safe only because deriveTags sorts', () => {
        // Documented rather than defended: if `deriveTags` ever stopped
        // sorting, this would report spurious updates — a re-run that never
        // settles. The control is the idempotency test above, which would fail.
        expect(sameTags(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameTags(['b', 'a'], ['a', 'b'])).toBe(false);
        expect(sameTags([], [])).toBe(true);
        expect(sameTags(['a'], [])).toBe(false);
        expect(sameTags([], ['a'])).toBe(false);
    });

    it('control: deriveTags does return sorted output', () => {
        const tags = deriveTags('Пазарът на пшеница и цените на царевицата', null);

        expect(tags).toEqual([...tags].sort());
        expect(tags.length).toBeGreaterThan(1);
    });
});
