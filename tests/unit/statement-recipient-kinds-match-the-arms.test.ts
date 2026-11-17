/**
 * `STATEMENT_RECIPIENT_KINDS` must describe `resolveContentRecipient`'s actual
 * arms — #2996.
 *
 * The constant exists so #2996's view can ask "was a statement ever possible
 * for this subject kind" without re-reading the branches. That makes it a
 * SECOND SPELLING of those branches, and a second spelling is a divergence
 * waiting to happen unless something compares them — which is the whole
 * reason the view it feeds exists.
 *
 * So this runs the real function over EVERY `ReportSubjectKind`, with a row
 * present for each resolvable kind, and asserts non-null exactly on the
 * members of the constant. A new arm with no constant entry fails here, and so
 * does a constant entry with no arm.
 */
const findUnique = jest.fn();
jest.mock('@/lib/prisma', () => {
    const model = () => ({ findUnique: (...a: unknown[]) => findUnique(...a) });
    return {
        __esModule: true,
        default: {
            exchangeListing: model(),
            exchangeMessage: model(),
            channelPost: model(),
        },
        prisma: {
            exchangeListing: model(),
            exchangeMessage: model(),
            channelPost: model(),
        },
    };
});

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { ReportSubjectKind } from '@prisma/client';

import {
    resolveContentRecipient,
    STATEMENT_RECIPIENT_KINDS,
} from '@/app-layer/usecases/statement-queue';

const ALL_SUBJECT_KINDS = Object.keys(ReportSubjectKind) as string[];

beforeEach(() => {
    findUnique.mockReset();
    // Every lookup finds its row, whichever column the arm selects. So a null
    // result means "no arm", never "no row" — which is the distinction the
    // whole test turns on.
    findUnique.mockResolvedValue({
        sellerUserId: 'u1',
        senderUserId: 'u1',
        authorUserId: 'u1',
    });
});

describe('STATEMENT_RECIPIENT_KINDS', () => {
    it('prints its denominator', () => {
        // [statement-recipient-kinds] subject kinds=7 with an arm=3
        console.log(
            `[statement-recipient-kinds] subject kinds=${ALL_SUBJECT_KINDS.length} with an arm=${STATEMENT_RECIPIENT_KINDS.length}`,
        );
        // A floor, so an emptied enum or an emptied constant fails rather than
        // passing over nothing.
        expect(ALL_SUBJECT_KINDS.length).toBeGreaterThanOrEqual(7);
        expect(STATEMENT_RECIPIENT_KINDS.length).toBeGreaterThanOrEqual(3);
    });

    it('names exactly the kinds the resolver resolves', async () => {
        const resolved: string[] = [];
        for (const kind of ALL_SUBJECT_KINDS) {
            const who = await resolveContentRecipient(kind, 'subject-1');
            if (who !== null) resolved.push(kind);
        }
        expect(resolved.sort()).toEqual([...STATEMENT_RECIPIENT_KINDS].sort());
    });

    it('CONTROL — a missing ROW is null too, so the test above needs its rows', async () => {
        // Proves the harness: without the `mockResolvedValue` above, every
        // kind would resolve to null and "names exactly the kinds" would pass
        // only if the constant were empty. This is the assertion that makes
        // the previous one mean "has an arm" rather than "found a row".
        findUnique.mockResolvedValue(null);
        for (const kind of STATEMENT_RECIPIENT_KINDS) {
            await expect(resolveContentRecipient(kind, 'gone')).resolves.toBeNull();
        }
    });

    it('is NOT silently the same list as REMOVABLE_SUBJECT_KINDS', async () => {
        // They hold the same three values today and answer different
        // questions. This asserts the RELATIONSHIP #2955's guard establishes —
        // removable is a SUBSET — rather than equality, so a future arm on a
        // non-removable kind is a passing change here and a failing one in any
        // test that assumed equality.
        const { REMOVABLE_SUBJECT_KINDS } = await import('@/app-layer/usecases/moderation');
        for (const k of REMOVABLE_SUBJECT_KINDS) {
            expect(STATEMENT_RECIPIENT_KINDS as readonly string[]).toContain(k);
        }
    });
});
