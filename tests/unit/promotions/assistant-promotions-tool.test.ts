/**
 * `list_promotions` and the block it builds — #2665.
 *
 * Owner ruling 2026-11-05: a promotion reaches the farmer as a SERVER-BUILT
 * block beside the answer, never as text the model wrote. "Marked as a
 * promotion and kept separate from its advice" — so the separation is
 * structural, and the prompt rule is a backstop against duplication rather
 * than the control.
 *
 * Two regulations shape what is asserted here, and neither is satisfied by a
 * prompt:
 *
 *   · DSA Art 26 — a recipient must be able to tell, clearly and in real time,
 *     that something is an advertisement and ON WHOSE BEHALF. So the
 *     advertiser's name must come from the disclosure, which is the authority
 *     on that string, and not from the promotion row.
 *   · Reg. (EC) 1107/2009 Art 66 — prescribed safety wording for plant
 *     protection advertising. So a ПРЗ with no resolvable wording must not
 *     reach a farmer at all.
 */
const promotionDisclosures = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('@/app-layer/usecases/promotion-disclosure', () => ({
    promotionDisclosures: (...a: unknown[]) => promotionDisclosures(...a),
    isPppDisclosureConfigured: () => false,
}));

const listPromotionsForAssistant = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('@/app-layer/usecases/promotions', () => ({
    listPromotionsForAssistant: (...a: unknown[]) => listPromotionsForAssistant(...a),
}));

import { ASSISTANT_TOOLS, runTool } from '@/app-layer/ai/assistant/tools';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });

/** One row as `listPromotionsForAssistant` returns it. */
const row = (id: string, product: string) => ({
    id,
    company: 'ROW NAME — must not be used',
    product,
    details: 'виж офертата',
    validTo: '2026-12-01T00:00:00.000Z',
});

const disclosure = (id: string, advertiser: string, safetyWording: string | null = null) => ({
    id,
    advertiser,
    isPpp: safetyWording !== null,
    safetyWording,
});

beforeEach(() => {
    jest.clearAllMocks();
    promotionDisclosures.mockResolvedValue([]);
    listPromotionsForAssistant.mockResolvedValue({ rows: [], hasMore: false });
});

describe('the tool is declared the way the registry expects', () => {
    it('is registered, builds a promotion block, and offers NO link', () => {
        const tool = ASSISTANT_TOOLS.list_promotions;
        expect(tool).toBeDefined();
        expect(tool?.buildsPromotionBlock).toBe(true);
        // A platform catalogue has no tenant-relative route, so a link would
        // be wrong rather than merely missing.
        expect(tool?.link).toBeUndefined();
    });

    it('takes ONLY `product` — every other argument is refused', () => {
        /*
         * The omissions are the decision. No `limit`, no date range, no
         * "include expired": each would be a way for the model to widen an
         * advertising read past the three filters in the usecase's `where`.
         */
        const args = ASSISTANT_TOOLS.list_promotions?.args;
        expect(args?.safeParse({ product: 'тор' }).success).toBe(true);
        expect(args?.safeParse({}).success).toBe(true);
        expect(args?.safeParse({ limit: 50 }).success).toBe(false);
        expect(args?.safeParse({ includeExpired: true }).success).toBe(false);
        expect(args?.safeParse({ product: 'a' }).success).toBe(false);
    });
});

describe('the block carries the DISCLOSURE, not the row', () => {
    it('the advertiser name comes from the disclosure — DSA Art 26', async () => {
        listPromotionsForAssistant.mockResolvedValue({ rows: [row('p1', 'НПК 15-15-15')], hasMore: false });
        promotionDisclosures.mockResolvedValue([disclosure('p1', 'Агрохим ООД')]);

        const out = await runTool(ctx, 'list_promotions', '{}');

        expect(out.promotions).toHaveLength(1);
        // Art 26 asks on whose behalf. The disclosure module is the authority
        // on that string; the row's own company name is deliberately ignored,
        // so a second producer of one legally-named value cannot drift.
        expect(out.promotions?.[0]?.company).toBe('Агрохим ООД');
        expect(out.promotions?.[0]?.company).not.toContain('ROW NAME');
    });

    it('a ПРЗ carries its Art 66 safety wording', async () => {
        listPromotionsForAssistant.mockResolvedValue({ rows: [row('p1', 'Хербицид X')], hasMore: false });
        promotionDisclosures.mockResolvedValue([
            disclosure('p1', 'Агрохим ООД', 'Прочетете етикета преди употреба.'),
        ]);

        const out = await runTool(ctx, 'list_promotions', '{}');

        expect(out.promotions?.[0]?.safetyWording).toBe('Прочетете етикета преди употреба.');
    });

    it('a non-ПРЗ carries NULL wording, not an empty string', async () => {
        // "No wording applies" and "the wording is missing" are different
        // states and only the second is a fault — the disclosure module's own
        // distinction, preserved rather than flattened.
        listPromotionsForAssistant.mockResolvedValue({ rows: [row('p1', 'Семена')], hasMore: false });
        promotionDisclosures.mockResolvedValue([disclosure('p1', 'Агрохим ООД', null)]);

        const out = await runTool(ctx, 'list_promotions', '{}');

        expect(out.promotions?.[0]?.safetyWording).toBeNull();
    });
});

describe('an undisclosable promotion never reaches a farmer', () => {
    it('a row with NO disclosure is dropped — the second fail-closed step', async () => {
        /*
         * `promotionDisclosures` documents that it "returns FEWER rows than
         * asked for" and that a missing id means "do not show this promotion",
         * never "show it without the disclosure".
         *
         * The usecase's `where` already excludes a ПРЗ whose wording is
         * unconfigured; this is the independent second step, for a disclosure
         * that cannot be resolved for any OTHER reason. An advert reaching a
         * farmer with no disclosure beside it is the one outcome neither step
         * may permit, so neither is trusted to be the only one.
         */
        listPromotionsForAssistant.mockResolvedValue({
            rows: [row('p1', 'Разкрито'), row('p2', 'Неразкрито')],
            hasMore: false,
        });
        // Only p1 comes back.
        promotionDisclosures.mockResolvedValue([disclosure('p1', 'Агрохим ООД')]);

        const out = await runTool(ctx, 'list_promotions', '{}');

        expect(out.promotions).toHaveLength(1);
        expect(out.promotions?.[0]?.id).toBe('p1');
        // CONTROL: p2's row WAS returned by the usecase, so the drop is the
        // join's doing and not an empty read.
        expect(listPromotionsForAssistant).toHaveBeenCalled();
        expect(JSON.stringify(out.content)).toContain('Неразкрито');
    });

    it('NO promotions at all means the field is ABSENT, not an empty array', async () => {
        // The `links` convention: a client need not distinguish empty from
        // missing.
        listPromotionsForAssistant.mockResolvedValue({ rows: [], hasMore: false });
        const out = await runTool(ctx, 'list_promotions', '{}');
        expect(out.promotions).toBeUndefined();
    });

    it('every row undisclosable also means ABSENT', async () => {
        listPromotionsForAssistant.mockResolvedValue({ rows: [row('p1', 'x')], hasMore: false });
        promotionDisclosures.mockResolvedValue([]);
        const out = await runTool(ctx, 'list_promotions', '{}');
        expect(out.promotions).toBeUndefined();
    });
});
