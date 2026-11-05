/**
 * A promotion's campaign window is a pair of DAYS, and both definitions of
 * "the window is open" must agree about them (#2752).
 *
 * ## Why the arms are enumerated rather than sampled
 *
 * `derivePromotionStatus` has four outcomes and `visibleWhere` three OR arms
 * per end, so a test set that exercises one arm can confirm a claim that is
 * only true there. That is not hypothetical: `agrent backend-2` lost half a
 * day to exactly it on #2745 — two pre-existing tests moved under their
 * mutation, which read as two independent confirmations, and both drove the
 * single branch where the claim held.
 *
 * So every arm below is named and reached: null, before, on-the-first-day,
 * mid-window, ON-THE-LAST-DAY, and after. The last-day case is the defect.
 */
import { derivePromotionStatus } from '@/app-layer/usecases/promotion-admin';
import { dayKeyToInstant, farmTodayFloor } from '@/lib/calendar-day-key';
import { CreatePromotionSchema } from '@/app-layer/schemas/promotion-admin.schemas';

const PUBLISHED = new Date('2026-01-01T00:00:00Z');
const at = (iso: string) => new Date(iso);

/** The window as the operator picked it: 2 Nov to 30 Nov 2026, inclusive. */
const WINDOW = {
    publishedAt: PUBLISHED,
    validFrom: dayKeyToInstant('2026-11-02'),
    validTo: dayKeyToInstant('2026-11-30'),
};

describe('derivePromotionStatus — every arm, by name', () => {
    it('DRAFT while unpublished, whatever the window says', () => {
        expect(derivePromotionStatus({ ...WINDOW, publishedAt: null }, at('2026-11-15T12:00:00+02:00')))
            .toBe('DRAFT');
    });

    it('SCHEDULED the day BEFORE it starts', () => {
        expect(derivePromotionStatus(WINDOW, at('2026-11-01T23:30:00+02:00'))).toBe('SCHEDULED');
    });

    it('LIVE from the FIRST MINUTE of its first day', () => {
        // `validFrom > now` with a day-labelling instant would hold until 02:00
        // Sofia, so this arm is the first-day half of the same defect.
        expect(derivePromotionStatus(WINDOW, at('2026-11-02T00:01:00+02:00'))).toBe('LIVE');
    });

    it('LIVE mid-window', () => {
        expect(derivePromotionStatus(WINDOW, at('2026-11-15T12:00:00+02:00'))).toBe('LIVE');
    });

    it('LIVE on the LAST MINUTE of its last day — THE defect', () => {
        // This is what #2752 is. `validTo < now` reported EXPIRED from the very
        // start of the 30th, so a campaign was never live on the day the
        // operator chose as its last.
        expect(derivePromotionStatus(WINDOW, at('2026-11-30T23:59:00+02:00'))).toBe('LIVE');
    });

    it('EXPIRED the day AFTER it ends', () => {
        expect(derivePromotionStatus(WINDOW, at('2026-12-01T00:01:00+02:00'))).toBe('EXPIRED');
    });

    it('LIVE with NO window at all — the null arms', () => {
        expect(derivePromotionStatus(
            { publishedAt: PUBLISHED, validFrom: null, validTo: null },
            at('2026-11-15T12:00:00+02:00'),
        )).toBe('LIVE');
    });

    it('LIVE with only a START, past — the validTo-null arm', () => {
        expect(derivePromotionStatus(
            { publishedAt: PUBLISHED, validFrom: dayKeyToInstant('2026-01-05'), validTo: null },
            at('2026-11-15T12:00:00+02:00'),
        )).toBe('LIVE');
    });

    it('LIVE with only an END, today — the validFrom-null arm on the boundary', () => {
        expect(derivePromotionStatus(
            { publishedAt: PUBLISHED, validFrom: null, validTo: dayKeyToInstant('2026-11-15') },
            at('2026-11-15T22:00:00+02:00'),
        )).toBe('LIVE');
    });
});

describe('the two definitions of "open" agree at every boundary', () => {
    // `derivePromotionStatus` labels a row in the console; `visibleWhere`
    // decides whether a farm can see it. They cannot share an expression —
    // four states against a boolean — so they share the FLOOR, and this is
    // what holds them together. Before #2752 they were both wrong in the same
    // direction, which is why nobody noticed: they agreed by accident.
    const MOMENTS = [
        '2026-11-01T23:30:00+02:00',
        '2026-11-02T00:01:00+02:00',
        '2026-11-15T12:00:00+02:00',
        '2026-11-30T23:59:00+02:00',
        '2026-12-01T00:01:00+02:00',
    ];

    it.each(MOMENTS)('agree at %s', (iso) => {
        const now = at(iso);
        const floor = farmTodayFloor(now);
        // The same predicate `visibleWhere` emits, evaluated in memory.
        const visible =
            WINDOW.publishedAt !== null
            && (WINDOW.validFrom === null || WINDOW.validFrom <= floor)
            && (WINDOW.validTo === null || WINDOW.validTo >= floor);
        expect(derivePromotionStatus(WINDOW, now) === 'LIVE').toBe(visible);
    });
});

describe('the wire format is a DAY KEY, refused when it is not', () => {
    const base = { companyId: 'c-1', title: 'Offer', category: 'fertilizer' as const };

    it('accepts YYYY-MM-DD', () => {
        const p = CreatePromotionSchema.parse({ ...base, validFrom: '2026-11-02', validTo: '2026-11-30' });
        expect(p.validFrom).toBe('2026-11-02');
        expect(p.validTo).toBe('2026-11-30');
    });

    it('REFUSES a full instant — the shape the console used to send', () => {
        // The old client sent `validFrom.toISOString()`. Accepting it would let
        // the per-client local-midnight conversion back in silently.
        expect(() => CreatePromotionSchema.parse({ ...base, validFrom: '2026-11-01T22:00:00.000Z' }))
            .toThrow();
    });

    it('REFUSES a partial or malformed day', () => {
        for (const bad of ['2026-11', '26-11-02', '2026/11/02', '2026-11-2']) {
            expect(() => CreatePromotionSchema.parse({ ...base, validFrom: bad })).toThrow();
        }
    });

    it('orders the window by STRING comparison, which is calendar order', () => {
        expect(() => CreatePromotionSchema.parse({ ...base, validFrom: '2026-11-30', validTo: '2026-11-02' }))
            .toThrow(/end date must not precede/i);
        // and the equal case is allowed — a one-day campaign
        expect(CreatePromotionSchema.parse({ ...base, validFrom: '2026-11-02', validTo: '2026-11-02' }).validTo)
            .toBe('2026-11-02');
    });
});
