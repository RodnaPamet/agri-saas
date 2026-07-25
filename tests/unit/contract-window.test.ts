/**
 * Unit tests for `src/lib/grain/contract-window.ts`.
 *
 * The delivery-window signal is shared by the list badge and the nightly
 * sweep, so a disagreement between them would show a farmer a green row
 * while emailing them that it is overdue. These tests pin the predicate
 * both sides call.
 *
 * The two invariants that matter:
 *   1. **ACTIVE only.** A DRAFT is unsigned, CANCELLED is void, and
 *      DELIVERED / SETTLED are fulfilled — none of them can be late.
 *   2. **Calendar days, not elapsed hours.** A contract must not flip
 *      state because the sweep ran at 07:30 instead of 06:00.
 */

import {
    CLOSING_SOON_DAYS,
    daysUntil,
    deriveContractWindowState,
} from '@/lib/grain/contract-window';

const at = (iso: string) => new Date(iso);

describe('daysUntil', () => {
    it('counts whole calendar days', () => {
        expect(daysUntil(at('2026-08-15T00:00:00Z'), at('2026-08-01T00:00:00Z'))).toBe(14);
    });

    it('is zero on the last day of the window (still in time)', () => {
        expect(daysUntil(at('2026-08-01T00:00:00Z'), at('2026-08-01T23:59:00Z'))).toBe(0);
    });

    it('ignores the time of day — a sweep at 07:30 sees the same day count as one at midnight', () => {
        const end = at('2026-08-15T09:00:00Z');
        expect(daysUntil(end, at('2026-08-01T00:01:00Z'))).toBe(14);
        expect(daysUntil(end, at('2026-08-01T07:30:00Z'))).toBe(14);
        expect(daysUntil(end, at('2026-08-01T23:59:00Z'))).toBe(14);
    });

    it('goes negative once past', () => {
        expect(daysUntil(at('2026-08-01T00:00:00Z'), at('2026-08-04T00:00:00Z'))).toBe(-3);
    });
});

describe('deriveContractWindowState', () => {
    const now = at('2026-08-01T12:00:00Z');

    it('flags an ACTIVE contract past its window as overdue', () => {
        expect(
            deriveContractWindowState('ACTIVE', at('2026-07-25T00:00:00Z'), now),
        ).toEqual({ state: 'overdue', daysRemaining: -7 });
    });

    it('flags an ACTIVE contract inside the warning window as closing soon', () => {
        expect(
            deriveContractWindowState('ACTIVE', at('2026-08-10T00:00:00Z'), now),
        ).toEqual({ state: 'closing-soon', daysRemaining: 9 });
    });

    it('says nothing for a window beyond the warning threshold', () => {
        expect(
            deriveContractWindowState('ACTIVE', at('2026-12-01T00:00:00Z'), now),
        ).toBeNull();
    });

    it('includes the boundary day itself', () => {
        const boundary = at('2026-08-01T00:00:00Z');
        boundary.setUTCDate(boundary.getUTCDate() + CLOSING_SOON_DAYS);
        expect(deriveContractWindowState('ACTIVE', boundary, now)?.state).toBe(
            'closing-soon',
        );
    });

    it('treats the last day of the window as closing-soon, not overdue', () => {
        expect(
            deriveContractWindowState('ACTIVE', at('2026-08-01T00:00:00Z'), now),
        ).toEqual({ state: 'closing-soon', daysRemaining: 0 });
    });

    it.each(['DRAFT', 'CANCELLED', 'DELIVERED', 'SETTLED'])(
        'never flags a %s contract, however late',
        (status) => {
            // Two years past its window and still silent — a cancelled
            // deal has nobody waiting on it, and a delivered one is done.
            expect(
                deriveContractWindowState(status, at('2024-01-01T00:00:00Z'), now),
            ).toBeNull();
        },
    );

    it.each([
        ['null', null],
        ['undefined', undefined],
    ])('says nothing when deliveryEnd is %s', (_label, end) => {
        // Absence of a date is not a deadline of zero.
        expect(deriveContractWindowState('ACTIVE', end as any, now)).toBeNull();
    });

    it('says nothing for an unparseable date rather than throwing', () => {
        expect(deriveContractWindowState('ACTIVE', 'not-a-date', now)).toBeNull();
    });

    it('accepts an ISO string as well as a Date (the wire shape)', () => {
        expect(
            deriveContractWindowState('ACTIVE', '2026-07-25T00:00:00.000Z', now),
        ).toEqual({ state: 'overdue', daysRemaining: -7 });
    });

    it('honours a custom warning window', () => {
        const end = at('2026-08-20T00:00:00Z'); // 19 days out
        expect(deriveContractWindowState('ACTIVE', end, now)).toBeNull();
        expect(deriveContractWindowState('ACTIVE', end, now, 30)?.state).toBe(
            'closing-soon',
        );
    });

    it('prefers overdue over closing-soon', () => {
        // Past the end date the contract is late, not approaching —
        // even with a generous window.
        expect(
            deriveContractWindowState('ACTIVE', at('2026-07-30T00:00:00Z'), now, 365)
                ?.state,
        ).toBe('overdue');
    });
});
