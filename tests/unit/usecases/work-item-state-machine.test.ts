/**
 * Audit Coherence S8 (2026-05-24) — pure-function unit tests for
 * the work-item state machine + transition checker.
 *
 * No DB, no usecase plumbing — these tests pin the legal-graph
 * shape so a future PR can't quietly widen or narrow the machine
 * without an explicit assertion change.
 */
import {
    WORK_ITEM_TRANSITIONS,
    checkWorkItemTransition,
    formatTransitionError,
    isTerminalStatus,
    isActiveStatus,
    isCompletedStatus,
    ALL_WORK_ITEM_STATUSES,
    TERMINAL_WORK_ITEM_STATUSES,
    COMPLETED_WORK_ITEM_STATUSES,
} from '@/app-layer/domain/work-item-status';

describe('WORK_ITEM_TRANSITIONS — legal graph', () => {
    it('exposes a key per WorkItemStatus value', () => {
        for (const s of ALL_WORK_ITEM_STATUSES) {
            expect(WORK_ITEM_TRANSITIONS).toHaveProperty(s);
        }
        expect(Object.keys(WORK_ITEM_TRANSITIONS).length).toBe(
            ALL_WORK_ITEM_STATUSES.length,
        );
    });

    it('terminal statuses (CLOSED, CANCELED) have an empty out-set', () => {
        expect(WORK_ITEM_TRANSITIONS.CLOSED.size).toBe(0);
        expect(WORK_ITEM_TRANSITIONS.CANCELED.size).toBe(0);
    });

    it('OPEN can short-circuit to RESOLVED or CANCELED', () => {
        const out = WORK_ITEM_TRANSITIONS.OPEN;
        expect(out.has('RESOLVED')).toBe(true);
        expect(out.has('CANCELED')).toBe(true);
        expect(out.has('TRIAGED')).toBe(true);
    });

    it('RESOLVED can go to CLOSED or re-open to IN_PROGRESS', () => {
        const out = WORK_ITEM_TRANSITIONS.RESOLVED;
        expect(out.has('CLOSED')).toBe(true);
        expect(out.has('IN_PROGRESS')).toBe(true);
        // RESOLVED → OPEN is intentionally illegal — re-opening goes
        // through IN_PROGRESS to keep the lifecycle forward-moving.
        expect(out.has('OPEN')).toBe(false);
    });
});

describe('checkWorkItemTransition', () => {
    it('returns null on a legal transition', () => {
        expect(checkWorkItemTransition('OPEN', 'TRIAGED')).toBeNull();
        expect(checkWorkItemTransition('IN_PROGRESS', 'RESOLVED')).toBeNull();
        expect(checkWorkItemTransition('RESOLVED', 'CLOSED')).toBeNull();
    });

    it('flags a no-op (same status) as a precise error variant', () => {
        const err = checkWorkItemTransition('IN_PROGRESS', 'IN_PROGRESS');
        expect(err).toEqual({ kind: 'no_op', status: 'IN_PROGRESS' });
    });

    it('flags an illegal transition between two known statuses', () => {
        const err = checkWorkItemTransition('CLOSED', 'OPEN');
        expect(err).toEqual({ kind: 'illegal', from: 'CLOSED', to: 'OPEN' });
    });

    it('flags CANCELED as a hard terminal — no transitions out', () => {
        for (const s of ALL_WORK_ITEM_STATUSES) {
            if (s === 'CANCELED') continue;
            const err = checkWorkItemTransition('CANCELED', s);
            expect(err?.kind).toBe('illegal');
        }
    });

    it('flags an unknown from-status', () => {
        const err = checkWorkItemTransition('NEW', 'OPEN');
        expect(err).toEqual({ kind: 'unknown_from', from: 'NEW' });
    });

    it('flags an unknown to-status', () => {
        const err = checkWorkItemTransition('OPEN', 'DONE_DONE');
        expect(err).toEqual({ kind: 'unknown_to', to: 'DONE_DONE' });
    });
});

describe('formatTransitionError', () => {
    it('renders a precise message for every error kind', () => {
        expect(formatTransitionError({ kind: 'no_op', status: 'OPEN' })).toMatch(
            /already OPEN/,
        );
        expect(
            formatTransitionError({ kind: 'illegal', from: 'CLOSED', to: 'OPEN' }),
        ).toMatch(/Illegal work-item transition: CLOSED → OPEN/);
        expect(
            formatTransitionError({ kind: 'unknown_from', from: 'NEW' }),
        ).toMatch(/Unknown current status "NEW"/);
        expect(
            formatTransitionError({ kind: 'unknown_to', to: 'DONE_DONE' }),
        ).toMatch(/Unknown target status "DONE_DONE"/);
    });
});

describe('isTerminalStatus / isActiveStatus — terminal/active partitioning', () => {
    it('partitions ALL_WORK_ITEM_STATUSES cleanly', () => {
        for (const s of ALL_WORK_ITEM_STATUSES) {
            // Every status is exactly one of terminal or active —
            // never both, never neither.
            const t = isTerminalStatus(s);
            const a = isActiveStatus(s);
            expect(t !== a).toBe(true);
        }
    });

    it('classifies the three terminal statuses', () => {
        expect(isTerminalStatus('RESOLVED')).toBe(true);
        expect(isTerminalStatus('CLOSED')).toBe(true);
        expect(isTerminalStatus('CANCELED')).toBe(true);
    });
});

describe('isCompletedStatus — completed is a STRICT subset of terminal', () => {
    it('accepts exactly RESOLVED and CLOSED', () => {
        // Break: adding CANCELED here re-merges the two concepts and
        // puts cancelled work back into every "done" tally in the
        // product — the dashboard trend, resolved30d, and the
        // linked-task progress badges.
        expect(isCompletedStatus('RESOLVED')).toBe(true);
        expect(isCompletedStatus('CLOSED')).toBe(true);
        expect(isCompletedStatus('CANCELED')).toBe(false);
        expect(isCompletedStatus('UNKNOWN')).toBe(false);
    });

    it('is implied by, but does not imply, isTerminalStatus', () => {
        // The containment is the invariant worth pinning: every
        // completed status is terminal, and at least one terminal
        // status is not completed. A refactor that made the two
        // predicates equal would satisfy the first half alone.
        for (const s of ALL_WORK_ITEM_STATUSES) {
            if (isCompletedStatus(s)) expect(isTerminalStatus(s)).toBe(true);
        }
        expect(COMPLETED_WORK_ITEM_STATUSES.length).toBeLessThan(
            TERMINAL_WORK_ITEM_STATUSES.length,
        );
        expect(ALL_WORK_ITEM_STATUSES.filter((s) => isTerminalStatus(s) && !isCompletedStatus(s)))
            .toEqual(['CANCELED']);
    });

    it('never classifies an active status as completed', () => {
        // PENDING_REVIEW is the trap: a field op whose work is
        // physically finished but not yet approved. It is NOT
        // completed — the reviewer still has to accept it.
        for (const s of ALL_WORK_ITEM_STATUSES) {
            if (isActiveStatus(s)) expect(isCompletedStatus(s)).toBe(false);
        }
        expect(isCompletedStatus('PENDING_REVIEW')).toBe(false);
    });
});
