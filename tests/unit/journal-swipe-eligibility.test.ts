/**
 * `journalSwipeKind` — which write a swipe performs, if any (#2175).
 *
 * This is the security-relevant half of the gesture: it decides whether a
 * DESTRUCTIVE control is offered at all. The server refuses independently, so
 * a wrong answer here is a usability failure rather than a hole — but the two
 * directions cost very different things, which is what these cases pin.
 */
import { journalSwipeKind } from '@/app/t/[tenantSlug]/(app)/journal/swipe-eligibility';

const WRITER = { canWrite: true };
const READER = { canWrite: false };

const treatment = (over: { parcelCount?: number; mayDelete?: boolean } = {}) => ({
    id: 'entry-1',
    treatment: { parcelCount: 3, ...over },
});

describe('journalSwipeKind', () => {
    it('sends a folded TREATMENT row to the treatment withdrawal', () => {
        // Not the entry delete, which would leave every printed register line
        // in place — the register builds those rows from `operationParcel` and
        // never reads `LogEntry` for them.
        expect(journalSwipeKind(treatment(), WRITER)).toBe('treatment');
    });

    it('sends a FREE-HAND row to the entry delete', () => {
        expect(journalSwipeKind({ id: 'entry-2', treatment: null }, WRITER)).toBe('entry');
        expect(journalSwipeKind({ id: 'entry-3' }, WRITER)).toBe('entry');
    });

    it('treats parcelCount 0 as free-hand, not as a treatment', () => {
        // A free-hand entry folds to itself and reports `parcelCount: 0`, which
        // the journal list documents as a real answer rather than a missing
        // one. Reading the presence of the object instead of the count would
        // route it to a withdrawal of a treatment that does not exist.
        expect(journalSwipeKind(treatment({ parcelCount: 0 }), WRITER)).toBe('entry');
    });

    it('REFUSES a treatment whose mayDelete is false', () => {
        // Either not the creator (403) or recorded by more than one person
        // (409, which refuses admins too). Both would answer the swipe with an
        // error after the farmer had already committed to it.
        expect(journalSwipeKind(treatment({ mayDelete: false }), WRITER)).toBeNull();
    });

    it('PERMITS a treatment whose mayDelete is ABSENT', () => {
        // A row cached before the field existed. Absence must not read as
        // denial: this list is on the persistent SWR allowlist, so denying
        // would hide the control from the person who recorded the treatment,
        // and the server re-checks regardless.
        expect(journalSwipeKind(treatment({ mayDelete: undefined }), WRITER)).toBe('treatment');
    });

    it('distinguishes ABSENT from false — the whole point of the === check', () => {
        // A `!mayDelete` test would collapse these two into one answer. If this
        // ever fails identically for both, the check has been loosened.
        const absent = journalSwipeKind(treatment({ mayDelete: undefined }), WRITER);
        const denied = journalSwipeKind(treatment({ mayDelete: false }), WRITER);
        expect(absent).not.toBe(denied);
    });

    it('offers a treatment swipe even to a caller who cannot write', () => {
        // Deliberate: `mayDelete` is the server's own verdict for THIS caller
        // and already accounts for role. Ignoring it in favour of the page's
        // coarse `canWrite` would re-derive a decision the server made, which
        // is the drift this flag exists to prevent.
        expect(journalSwipeKind(treatment(), READER)).toBe('treatment');
    });

    it('REFUSES an entry delete to a caller who cannot write', () => {
        expect(journalSwipeKind({ id: 'entry-4', treatment: null }, READER)).toBeNull();
    });

    it('REFUSES an optimistic row, which the server has never seen', () => {
        // Its id is a client temp handle; the delete would 404.
        expect(journalSwipeKind({ id: 'optimistic-1730000000', treatment: null }, WRITER)).toBeNull();
        // Spread FIRST: `treatment()` carries its own id, so the opposite
        // order silently restores it and the case asserts nothing.
        expect(journalSwipeKind({ ...treatment(), id: 'optimistic-1730000000' }, WRITER)).toBeNull();
    });
});
