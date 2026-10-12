/**
 * The exhaustive truth table for `subjectMayCancelErasure` (#1667).
 *
 * ## Why a pure-function test when an integration one exists
 *
 * The integration half (`p5-6b-erasure`) proves the predicate agrees with what
 * `cancelAccountDeletion` actually does, which is the property that matters.
 * It can only reach the states a real sequence of calls can produce, and the
 * divergence that prompted all this came from a state nobody had sequenced:
 * ask to leave, THEN be terminated.
 *
 * So this enumerates all 24 combinations and asserts the set that comes back
 * true — against a list typed from the rule in prose, not from the
 * implementation. Asserting `cancellable === (a && b && c && d)` would be a
 * restatement of the code and would survive any change to it.
 */
import {
    subjectMayCancelErasure,
    type ErasureCancellability,
} from '@/app-layer/usecases/account-erasure';

const WHEN = new Date('2026-10-01T00:00:00Z');
const INITIATORS = [null, 'SELF', 'MODERATION'] as const;

/** All 2 × 3 × 2 × 2 combinations of the four deciding columns. */
function everyState(): Array<{ label: string; row: ErasureCancellability }> {
    const out: Array<{ label: string; row: ErasureCancellability }> = [];
    for (const requested of [null, WHEN]) {
        for (const by of INITIATORS) {
            for (const terminated of [null, WHEN]) {
                for (const pseudonymised of [null, WHEN]) {
                    out.push({
                        label: [
                            `requested=${requested ? 'set' : 'null'}`,
                            `by=${by ?? 'null'}`,
                            `terminated=${terminated ? 'set' : 'null'}`,
                            `pseudonymised=${pseudonymised ? 'set' : 'null'}`,
                        ].join(' '),
                        row: {
                            deletionRequestedAt: requested,
                            deletionRequestedBy: by,
                            terminatedAt: terminated,
                            pseudonymisedAt: pseudonymised,
                        },
                    });
                }
            }
        }
    }
    return out;
}

/**
 * The ONLY states in which a person may stop their own erasure, written out
 * from the rule rather than computed: a request is pending, nobody has
 * finalised the account, nothing is pseudonymised yet, and the request is not
 * moderation's. A NULL initiator is a pre-#1671 self-service request.
 */
const EXPECTED_TRUE = [
    'requested=set by=null terminated=null pseudonymised=null',
    'requested=set by=SELF terminated=null pseudonymised=null',
];

describe('subjectMayCancelErasure — the whole table (#1667)', () => {
    it('covers 24 states', () => {
        // The denominator. An `everyState` that silently returned fewer rows
        // would make the set assertion below pass for free.
        expect(everyState()).toHaveLength(24);
    });

    it('exactly two of the 24 are cancellable, and they are these two', () => {
        const actual = everyState()
            .filter(({ row }) => subjectMayCancelErasure(row))
            .map(({ label }) => label);
        expect(actual.sort()).toEqual([...EXPECTED_TRUE].sort());
    });

    // ── the four states agrent-ios named, spelled out ────────────────
    const row = (p: Partial<ErasureCancellability>): ErasureCancellability => ({
        deletionRequestedAt: null,
        deletionRequestedBy: null,
        terminatedAt: null,
        pseudonymisedAt: null,
        ...p,
    });

    it('nothing pending — nothing to stop', () => {
        expect(subjectMayCancelErasure(row({}))).toBe(false);
    });

    it('SELF — theirs, so yes', () => {
        expect(
            subjectMayCancelErasure(row({ deletionRequestedAt: WHEN, deletionRequestedBy: 'SELF' })),
        ).toBe(true);
    });

    it('MODERATION — not theirs, so no', () => {
        expect(
            subjectMayCancelErasure(
                row({ deletionRequestedAt: WHEN, deletionRequestedBy: 'MODERATION' }),
            ),
        ).toBe(false);
    });

    it('SELF then terminated — no, and this is the case that was wrong', () => {
        // `requestAccountDeletionOnTx` early-returns on an existing request
        // and never writes the initiator, so the row stays SELF through a
        // termination. The initiator alone therefore says "cancellable" and
        // `terminatedAt` is the only signal that says otherwise.
        expect(
            subjectMayCancelErasure(
                row({
                    deletionRequestedAt: WHEN,
                    deletionRequestedBy: 'SELF',
                    terminatedAt: WHEN,
                }),
            ),
        ).toBe(false);
    });

    it('already pseudonymised — past the point of no return', () => {
        expect(
            subjectMayCancelErasure(
                row({
                    deletionRequestedAt: WHEN,
                    deletionRequestedBy: 'SELF',
                    pseudonymisedAt: WHEN,
                }),
            ),
        ).toBe(false);
    });
});
