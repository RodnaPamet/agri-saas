/**
 * Contract Status — Shared Domain Logic
 *
 * Canonical definitions of the grain-contract lifecycle: the legal
 * transition graph, and the status set that counts as a real tonnage
 * COMMITMENT for portfolio rollups.
 *
 * Mirrors `./work-item-status.ts` — same executable-state-machine shape,
 * same `check*` / `format*` pair, and (deliberately) no `@prisma/client`
 * import so this module stays requireable from a jest node env and from
 * client code that only needs the literals.
 *
 * The lifecycle documented on the `ContractStatus` enum
 * (`prisma/schema/enums.prisma`) is:
 *
 *   DRAFT → ACTIVE (signed) → DELIVERED (volume moved) → SETTLED (paid)
 *   CANCELLED is terminal from any pre-SETTLED state.
 *
 * Before this module existed, `updateContract` did a bare
 * `data.status = input.status`, so the API happily accepted
 * SETTLED → DRAFT, DRAFT → SETTLED (skipping signature AND delivery),
 * and re-opening a CANCELLED contract. The enum comment described the
 * graph; this file makes it enforceable.
 *
 * @module app-layer/domain/contract-status
 */

/** Every valid ContractStatus. Kept in sync with the Prisma enum. */
export const ALL_CONTRACT_STATUSES = [
    'DRAFT',
    'ACTIVE',
    'DELIVERED',
    'SETTLED',
    'CANCELLED',
] as const;

export type ContractStatusValue = (typeof ALL_CONTRACT_STATUSES)[number];

/** Every valid ContractType. Kept in sync with the Prisma enum. */
export const ALL_CONTRACT_TYPES = ['SALE', 'PURCHASE'] as const;

export type ContractTypeValue = (typeof ALL_CONTRACT_TYPES)[number];

/**
 * Statuses that represent a LIVE tonnage commitment for the portfolio
 * "contracted tonnes" rollup.
 *
 * Excluded, and why:
 *   - `DRAFT`     — unsigned. An operator's scratch row is not a
 *                   commitment; counting it lets the headline grow just
 *                   by someone opening the create modal.
 *   - `CANCELLED` — void. A cancelled contract commits nothing.
 *   - `SETTLED`   — closed out (delivered AND paid). Real history, but
 *                   it never leaves the table, so including it made the
 *                   group-operator's headline a monotonically-growing
 *                   lifetime total rather than "what we're on the hook
 *                   for now". Prior-season settlements dominated it
 *                   within a year.
 *
 * `DELIVERED` IS included: the volume has physically moved but the
 * contract is not yet settled, so it is still on the books — this set
 * is "in-flight plus fulfilled-but-unsettled".
 *
 * A lifetime-total or per-season view is a different question and wants
 * its own explicit field, not a redefinition of this one.
 */
export const CONTRACTED_COMMITMENT_STATUSES = ['ACTIVE', 'DELIVERED'] as const;

export type ContractedCommitmentStatus =
    (typeof CONTRACTED_COMMITMENT_STATUSES)[number];

/**
 * Statuses that count as a real commitment made against a SEASON'S
 * harvest, for the portfolio's per-season contracted-vs-produced rollup.
 *
 * WIDER than `CONTRACTED_COMMITMENT_STATUSES` on purpose — the two
 * answer different questions:
 *
 *   - live book   ("what am I on the hook for right now?")
 *                 → ACTIVE + DELIVERED. SETTLED is closed out.
 *   - season roll ("how much of the 2026 harvest did I sell forward?")
 *                 → ACTIVE + DELIVERED + SETTLED.
 *
 * Using the live-book set for the season view would be actively
 * misleading: a COMPLETED season's contracts are mostly SETTLED, so
 * coverage would collapse toward 0% precisely for the seasons an
 * operator is reviewing. Both sets exclude DRAFT (unsigned) and
 * CANCELLED (void) — that discipline is common to every "contracted"
 * figure in the product.
 */
export const CONTRACTED_SEASON_STATUSES = [
    'ACTIVE',
    'DELIVERED',
    'SETTLED',
] as const;

export type ContractedSeasonStatus = (typeof CONTRACTED_SEASON_STATUSES)[number];

/**
 * Legal transitions out of each status.
 *
 *   DRAFT     → ACTIVE · CANCELLED
 *   ACTIVE    → DELIVERED · CANCELLED
 *   DELIVERED → SETTLED · CANCELLED
 *   SETTLED   → (terminal — paid and closed)
 *   CANCELLED → (terminal — void)
 *
 * Deliberately strict: no skipping ACTIVE (a contract cannot be
 * delivered before it is signed), no skipping DELIVERED (cannot settle
 * volume that never moved), and no resurrection out of either terminal
 * state. Recording a contract that is ALREADY mid-lifecycle is a
 * create-time concern — `createContract` accepts any status as the
 * opening state, exactly like `WORK_ITEM_TRANSITIONS` leaves creation
 * unconstrained.
 */
export const CONTRACT_TRANSITIONS: Record<
    ContractStatusValue,
    ReadonlySet<ContractStatusValue>
> = {
    DRAFT: new Set(['ACTIVE', 'CANCELLED']),
    ACTIVE: new Set(['DELIVERED', 'CANCELLED']),
    DELIVERED: new Set(['SETTLED', 'CANCELLED']),
    SETTLED: new Set(),
    CANCELLED: new Set(),
};

export type ContractTransitionError =
    | { kind: 'unknown_from'; from: string }
    | { kind: 'unknown_to'; to: string }
    | { kind: 'illegal'; from: string; to: string };

/**
 * Pure-function transition check. Returns `null` on a legal transition,
 * or a discriminated error variant the caller forwards to
 * `badRequest()` via `formatContractTransitionError`.
 *
 * **`from === to` is LEGAL here** — the one intentional divergence from
 * `checkWorkItemTransition`, which rejects a no-op. Work items move
 * through a dedicated `setTaskStatus` endpoint where re-sending the
 * current status is meaningless. A contract's status rides the general
 * `PATCH /grain/contracts/:id` body, and `ContractFormModal` submits
 * the whole form — so every "fix a typo in the counterparty" edit
 * re-sends the unchanged status. Rejecting the no-op would make routine
 * edits of a SETTLED or CANCELLED contract impossible.
 */
export function checkContractTransition(
    from: string,
    to: string,
): ContractTransitionError | null {
    if (!(from in CONTRACT_TRANSITIONS)) {
        return { kind: 'unknown_from', from };
    }
    if (!(to in CONTRACT_TRANSITIONS)) {
        return { kind: 'unknown_to', to };
    }
    // No-op: legal, and the caller skips the write. See the note above.
    if (from === to) return null;

    const allowed = CONTRACT_TRANSITIONS[from as ContractStatusValue];
    if (!allowed.has(to as ContractStatusValue)) {
        return { kind: 'illegal', from, to };
    }
    return null;
}

/** Render a transition error into a human-readable 400 message. */
export function formatContractTransitionError(
    err: ContractTransitionError,
): string {
    switch (err.kind) {
        case 'unknown_from':
            return `Unknown current contract status "${err.from}"; cannot validate transition.`;
        case 'unknown_to':
            return `Unknown target contract status "${err.to}".`;
        case 'illegal':
            return `Illegal contract transition: ${err.from} → ${err.to}. Allowed from ${err.from}: ${
                [...CONTRACT_TRANSITIONS[err.from as ContractStatusValue]].join(', ') || 'none (terminal)'
            }.`;
    }
}
