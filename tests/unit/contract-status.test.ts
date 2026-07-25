/**
 * Unit tests for `src/app-layer/domain/contract-status.ts`.
 *
 * The pure state machine behind the grain-contract lifecycle. Mirrors
 * `work-item-status.test.ts` in shape.
 *
 * Two invariants get explicit coverage because they are the ones a
 * future "simplify" PR would plausibly break:
 *   1. the graph matches the lifecycle documented on the Prisma enum
 *      (DRAFT → ACTIVE → DELIVERED → SETTLED, CANCELLED terminal from
 *      any pre-SETTLED state), and
 *   2. `from === to` is LEGAL here — the deliberate divergence from
 *      `checkWorkItemTransition`, which rejects a no-op.
 */

import {
    ALL_CONTRACT_STATUSES,
    CONTRACTED_COMMITMENT_STATUSES,
    CONTRACT_TRANSITIONS,
    checkContractTransition,
    formatContractTransitionError,
    type ContractStatusValue,
} from '@/app-layer/domain/contract-status';

describe('ALL_CONTRACT_STATUSES', () => {
    it('covers every ContractStatus the schema declares', () => {
        // Kept in sync by hand (the module stays Prisma-free so it can be
        // required from a node env). If the enum grows, this fails first.
        expect([...ALL_CONTRACT_STATUSES]).toEqual([
            'DRAFT',
            'ACTIVE',
            'DELIVERED',
            'SETTLED',
            'CANCELLED',
        ]);
    });

    it('gives every status an entry in the transition table', () => {
        for (const s of ALL_CONTRACT_STATUSES) {
            expect(CONTRACT_TRANSITIONS[s]).toBeInstanceOf(Set);
        }
        expect(Object.keys(CONTRACT_TRANSITIONS).sort()).toEqual(
            [...ALL_CONTRACT_STATUSES].sort(),
        );
    });

    it('never points at a status outside the enum', () => {
        for (const [from, targets] of Object.entries(CONTRACT_TRANSITIONS)) {
            for (const to of targets) {
                expect(ALL_CONTRACT_STATUSES).toContain(to);
                expect(to).not.toBe(from); // no self-loops in the table
            }
        }
    });
});

describe('checkContractTransition', () => {
    it.each([
        ['DRAFT', 'ACTIVE'],
        ['DRAFT', 'CANCELLED'],
        ['ACTIVE', 'DELIVERED'],
        ['ACTIVE', 'CANCELLED'],
        ['DELIVERED', 'SETTLED'],
        ['DELIVERED', 'CANCELLED'],
    ])('allows the documented move %s → %s', (from, to) => {
        expect(checkContractTransition(from, to)).toBeNull();
    });

    it.each([
        ['DRAFT', 'DELIVERED'],
        ['DRAFT', 'SETTLED'],
        ['ACTIVE', 'SETTLED'],
        ['ACTIVE', 'DRAFT'],
        ['DELIVERED', 'ACTIVE'],
        ['DELIVERED', 'DRAFT'],
        ['SETTLED', 'DRAFT'],
        ['SETTLED', 'ACTIVE'],
        ['SETTLED', 'DELIVERED'],
        ['SETTLED', 'CANCELLED'],
        ['CANCELLED', 'DRAFT'],
        ['CANCELLED', 'ACTIVE'],
        ['CANCELLED', 'DELIVERED'],
        ['CANCELLED', 'SETTLED'],
    ])('rejects %s → %s', (from, to) => {
        expect(checkContractTransition(from, to)).toEqual({
            kind: 'illegal',
            from,
            to,
        });
    });

    it('treats a no-op as LEGAL (diverges from checkWorkItemTransition)', () => {
        // updateContract is a general PATCH and ContractFormModal submits
        // the whole form, so an unchanged status rides along on every
        // edit. Rejecting it would make a SETTLED or CANCELLED contract
        // permanently uneditable.
        for (const s of ALL_CONTRACT_STATUSES) {
            expect(checkContractTransition(s, s)).toBeNull();
        }
    });

    it('flags an unknown source status', () => {
        expect(checkContractTransition('BOGUS', 'ACTIVE')).toEqual({
            kind: 'unknown_from',
            from: 'BOGUS',
        });
    });

    it('flags an unknown target status', () => {
        expect(checkContractTransition('DRAFT', 'BOGUS')).toEqual({
            kind: 'unknown_to',
            to: 'BOGUS',
        });
    });

    it('leaves both terminal states with no way out', () => {
        for (const terminal of ['SETTLED', 'CANCELLED'] as ContractStatusValue[]) {
            expect(CONTRACT_TRANSITIONS[terminal].size).toBe(0);
            const escapes = ALL_CONTRACT_STATUSES.filter(
                (to) => to !== terminal && checkContractTransition(terminal, to) === null,
            );
            expect(escapes).toEqual([]);
        }
    });

    it('makes every non-terminal status cancellable', () => {
        for (const s of ['DRAFT', 'ACTIVE', 'DELIVERED'] as ContractStatusValue[]) {
            expect(checkContractTransition(s, 'CANCELLED')).toBeNull();
        }
    });
});

describe('formatContractTransitionError', () => {
    it('names both ends of an illegal move and lists what IS allowed', () => {
        const msg = formatContractTransitionError({
            kind: 'illegal',
            from: 'DRAFT',
            to: 'SETTLED',
        });
        expect(msg).toMatch(/DRAFT/);
        expect(msg).toMatch(/SETTLED/);
        expect(msg).toMatch(/ACTIVE, CANCELLED/);
    });

    it('says "terminal" rather than listing an empty set', () => {
        expect(
            formatContractTransitionError({ kind: 'illegal', from: 'SETTLED', to: 'DRAFT' }),
        ).toMatch(/none \(terminal\)/);
    });

    it('renders the unknown-status variants', () => {
        expect(
            formatContractTransitionError({ kind: 'unknown_from', from: 'X' }),
        ).toMatch(/Unknown current contract status "X"/);
        expect(
            formatContractTransitionError({ kind: 'unknown_to', to: 'Y' }),
        ).toMatch(/Unknown target contract status "Y"/);
    });
});

describe('CONTRACTED_COMMITMENT_STATUSES', () => {
    it('is exactly the live book: ACTIVE + DELIVERED', () => {
        expect([...CONTRACTED_COMMITMENT_STATUSES]).toEqual(['ACTIVE', 'DELIVERED']);
    });

    it('excludes DRAFT, CANCELLED and SETTLED', () => {
        // The portfolio "contracted tonnes" headline is built on this set.
        // Including any of these three is what made it grow-only.
        for (const excluded of ['DRAFT', 'CANCELLED', 'SETTLED']) {
            expect(CONTRACTED_COMMITMENT_STATUSES).not.toContain(excluded);
        }
    });

    it('only names real statuses', () => {
        for (const s of CONTRACTED_COMMITMENT_STATUSES) {
            expect(ALL_CONTRACT_STATUSES).toContain(s);
        }
    });
});
