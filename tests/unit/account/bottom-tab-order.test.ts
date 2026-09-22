/**
 * The bottom-row arrangement validates SHAPE, never vocabulary — and `null`
 * survives as a distinct state from `[]`.
 *
 * Both are load-bearing and neither is obvious from the column:
 *
 *  • A server-side allowlist of known tabs would mean every new client tab
 *    waits on a server deploy before anyone could put it in their bar, and the
 *    web and native release cycles are not coupled. An id from a newer app
 *    must store fine and simply not render on an older client.
 *
 *  • `null` means "never chosen, use the default order"; `[]` means
 *    "deliberately cleared". Collapsing them makes a new user
 *    indistinguishable from one who emptied their bar, and the two want
 *    opposite behaviour. That is why the column is `Json?` rather than a
 *    Prisma `String[]`, which cannot be nullable.
 */
import {
    BottomTabOrderSchema,
    parseBottomTabOrder,
    MAX_BOTTOM_TABS,
} from '@/lib/account/bottom-tabs';

describe('BottomTabOrderSchema — shape only', () => {
    it('accepts an id the server has never heard of', () => {
        // The whole point. A tab shipped by a newer client must save.
        expect(BottomTabOrderSchema.safeParse(['/dashboard', '/a-tab-from-2027']).success).toBe(true);
    });

    it('accepts multi-segment suffixes', () => {
        // `/grain/contracts` is real — these are opaque strings, not one path
        // segment.
        expect(BottomTabOrderSchema.safeParse(['/grain/contracts']).success).toBe(true);
    });

    it('keeps null and [] as different values', () => {
        const cleared = BottomTabOrderSchema.safeParse([]);
        const never = BottomTabOrderSchema.safeParse(null);
        expect(cleared.success).toBe(true);
        expect(never.success).toBe(true);
        expect(cleared.success && cleared.data).toEqual([]);
        expect(never.success && never.data).toBeNull();
    });

    it('preserves ORDER — it is a display order, not a set', () => {
        const r = BottomTabOrderSchema.safeParse(['/journal', '/dashboard', '/exchange']);
        expect(r.success && r.data).toEqual(['/journal', '/dashboard', '/exchange']);
    });

    it('rejects duplicates', () => {
        expect(BottomTabOrderSchema.safeParse(['/dashboard', '/dashboard']).success).toBe(false);
    });

    it('rejects empty and whitespace-only ids', () => {
        expect(BottomTabOrderSchema.safeParse(['']).success).toBe(false);
        expect(BottomTabOrderSchema.safeParse(['   ']).success).toBe(false);
    });

    it('caps the length', () => {
        const tooMany = Array.from({ length: MAX_BOTTOM_TABS + 1 }, (_, i) => `/t${i}`);
        expect(BottomTabOrderSchema.safeParse(tooMany).success).toBe(false);
        const atCap = Array.from({ length: MAX_BOTTOM_TABS }, (_, i) => `/t${i}`);
        expect(BottomTabOrderSchema.safeParse(atCap).success).toBe(true);
    });

    it('rejects non-arrays and non-string members', () => {
        expect(BottomTabOrderSchema.safeParse('/dashboard').success).toBe(false);
        expect(BottomTabOrderSchema.safeParse([1, 2]).success).toBe(false);
        expect(BottomTabOrderSchema.safeParse(undefined).success).toBe(false);
    });
});

describe('parseBottomTabOrder — reading a Json column back', () => {
    it('returns the list when it is one', () => {
        expect(parseBottomTabOrder(['/dashboard'])).toEqual(['/dashboard']);
        expect(parseBottomTabOrder([])).toEqual([]);
    });

    it('degrades anything else to null rather than throwing', () => {
        // The column is Json. A hand-edited row, or a value written by some
        // future shape, must fall back to the default bar — not break every
        // render for that user.
        expect(parseBottomTabOrder(null)).toBeNull();
        expect(parseBottomTabOrder('nonsense')).toBeNull();
        expect(parseBottomTabOrder({ tabs: [] })).toBeNull();
        expect(parseBottomTabOrder([1, 2])).toBeNull();
    });
});
