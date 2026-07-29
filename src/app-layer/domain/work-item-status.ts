/**
 * Work Item Status Constants — Shared Domain Logic
 *
 * Canonical definitions of work item status groupings.
 * Use these constants instead of ad-hoc inline arrays
 * to ensure consistency across:
 *   - backend query filters (repositories, monitors, jobs)
 *   - frontend filter presets (task list, dashboard)
 *   - audit/readiness scoring
 *   - notification processing
 *
 * The WorkItemStatus enum values are:
 *   OPEN | TRIAGED | IN_PROGRESS | BLOCKED | RESOLVED | CLOSED | CANCELED
 *
 * Status lifecycle:
 *   OPEN → TRIAGED → IN_PROGRESS → BLOCKED → IN_PROGRESS → RESOLVED → CLOSED
 *                                                                     → CANCELED
 *
 * @module app-layer/domain/work-item-status
 */

/**
 * Terminal statuses — items that have stopped moving and should be excluded
 * from active views, overdue calculations, and notification triggers.
 *
 * TERMINAL is not the same thing as COMPLETED — see
 * `COMPLETED_WORK_ITEM_STATUSES` below. A CANCELED item is terminal
 * (it will never move again) but it is NOT completed work.
 */
export const TERMINAL_WORK_ITEM_STATUSES = ['RESOLVED', 'CLOSED', 'CANCELED'] as const;

/**
 * Completed statuses — the strict subset of terminal statuses that
 * represent work that was actually DONE.
 *
 * The distinction is load-bearing, and conflating the two is a real bug
 * this module has already produced once (see
 * `docs/implementation-notes/2026-07-29-canceled-is-not-completed.md`):
 *
 *   - TERMINAL answers "should this still appear in active views, count
 *     as overdue, or fire a notification?" → CANCELED is terminal.
 *   - COMPLETED answers "did this work get done?" → CANCELED is NOT
 *     completed. Cancelling a spray job does not spray the field.
 *
 * `Task.completedAt` is stamped on COMPLETED, never on merely terminal.
 * Anything counting finished work — the dashboard "created vs completed"
 * trend, `metrics().trend.resolved30d`, the linked-task progress badges —
 * must partition on this constant, not on TERMINAL_WORK_ITEM_STATUSES.
 */
export const COMPLETED_WORK_ITEM_STATUSES = ['RESOLVED', 'CLOSED'] as const;

/**
 * Active/open statuses — items that are still in progress and should appear
 * in active views, overdue checks, dashboard counts, and notifications.
 *
 * This is the inverse of TERMINAL_WORK_ITEM_STATUSES.
 * Includes: OPEN, TRIAGED, IN_PROGRESS, BLOCKED
 */
export const ACTIVE_WORK_ITEM_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'PENDING_REVIEW'] as const;

/**
 * All valid work item statuses. Kept in sync with the Prisma WorkItemStatus
 * enum. PENDING_REVIEW (#6) is an ACTIVE (non-terminal) gate: a completed
 * field operation awaiting a reviewer's approval before it is RESOLVED.
 */
export const ALL_WORK_ITEM_STATUSES = [
    'OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'PENDING_REVIEW',
    'RESOLVED', 'CLOSED', 'CANCELED',
] as const;

export type WorkItemStatusValue = (typeof ALL_WORK_ITEM_STATUSES)[number];
export type TerminalWorkItemStatus = (typeof TERMINAL_WORK_ITEM_STATUSES)[number];
export type CompletedWorkItemStatus = (typeof COMPLETED_WORK_ITEM_STATUSES)[number];
export type ActiveWorkItemStatus = (typeof ACTIVE_WORK_ITEM_STATUSES)[number];

/**
 * Prisma-compatible filter for active/open items.
 * Usage: `where: { status: ACTIVE_STATUS_FILTER }`
 *
 * Prefer this over `{ in: ACTIVE_WORK_ITEM_STATUSES }` because
 * the notIn pattern is future-proof — new statuses added to
 * WorkItemStatus will automatically be included in active views
 * unless they are explicitly terminal.
 */
export const ACTIVE_STATUS_FILTER = {
    notIn: TERMINAL_WORK_ITEM_STATUSES as unknown as string[],
} as const;

/**
 * Check if a status string represents a terminal (no-longer-moving) state.
 *
 * Use this to decide whether an item drops out of active views / overdue
 * checks / notifications, or whether a closing `resolution` is required.
 * Do NOT use it to decide whether work was completed — use
 * `isCompletedStatus` for that.
 */
export function isTerminalStatus(status: string): status is TerminalWorkItemStatus {
    return (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

/**
 * Check if a status string represents COMPLETED work (RESOLVED | CLOSED).
 *
 * The predicate behind `Task.completedAt` and every "done" tally in the
 * product. Strictly narrower than `isTerminalStatus`: CANCELED returns
 * `false` here and `true` there, and that gap is the entire point.
 */
export function isCompletedStatus(status: string): status is CompletedWorkItemStatus {
    return (COMPLETED_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

/**
 * Check if a status string represents an active/in-progress state.
 */
export function isActiveStatus(status: string): status is ActiveWorkItemStatus {
    return (ACTIVE_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

// ─────────────────────────────────────────────────────────────────────
// Audit Coherence S8 (2026-05-24) — explicit work-item state machine.
//
// Pre-S8, `setTaskStatus` / `setIssueStatus` accepted any string and
// wrote it through to the row. That left a few illegal shapes
// representable by the API: skipping OPEN entirely, re-opening a
// CLOSED row, re-opening a CANCELED row, sending RESOLVED back to
// OPEN. The lifecycle comment at the top of this file documented
// the intended graph; this table makes it executable.
//
// `assertLegalTransition(from, to)` is the canonical guard — usecases
// MUST call it before writing the new status. A `from === to` no-op
// is rejected by the same gate (no audit row for "I'm sending the
// same status I already had").
//
// Legal transitions captured below:
//   OPEN → TRIAGED · IN_PROGRESS · BLOCKED · RESOLVED · CANCELED
//          (RESOLVED short-circuit allows "fixed during triage")
//   TRIAGED → IN_PROGRESS · BLOCKED · RESOLVED · CANCELED
//   IN_PROGRESS → BLOCKED · RESOLVED · CANCELED · TRIAGED
//                 (move back to TRIAGED is "needs re-scoping")
//   BLOCKED → IN_PROGRESS · TRIAGED · CANCELED
//   RESOLVED → CLOSED · IN_PROGRESS
//              (re-open is allowed before close — common when QA
//               or auditors reject the resolution)
//   CLOSED → (terminal — no transitions out)
//   CANCELED → (terminal — no transitions out)
// ─────────────────────────────────────────────────────────────────────
export const WORK_ITEM_TRANSITIONS: Record<
    WorkItemStatusValue,
    ReadonlySet<WorkItemStatusValue>
> = {
    // CLOSED is now reachable directly from every active status. The
    // UI retired RESOLVED as a redundant intermediate (it stays in the
    // enum + the graph for legacy RESOLVED rows, which can still
    // advance to CLOSED), so an active task closes in one step.
    OPEN: new Set(['TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'PENDING_REVIEW', 'RESOLVED', 'CLOSED', 'CANCELED']),
    TRIAGED: new Set(['IN_PROGRESS', 'BLOCKED', 'PENDING_REVIEW', 'RESOLVED', 'CLOSED', 'CANCELED']),
    IN_PROGRESS: new Set(['BLOCKED', 'PENDING_REVIEW', 'RESOLVED', 'CLOSED', 'CANCELED', 'TRIAGED']),
    BLOCKED: new Set(['IN_PROGRESS', 'TRIAGED', 'PENDING_REVIEW', 'CLOSED', 'CANCELED']),
    // #6 review gate: a completed field op awaits approval here. Approve →
    // RESOLVED; request changes → IN_PROGRESS. Can also be closed/canceled.
    PENDING_REVIEW: new Set(['RESOLVED', 'IN_PROGRESS', 'CLOSED', 'CANCELED']),
    RESOLVED: new Set(['CLOSED', 'IN_PROGRESS']),
    CLOSED: new Set(),
    CANCELED: new Set(),
};

export type WorkItemTransitionError =
    | { kind: 'unknown_from'; from: string }
    | { kind: 'unknown_to'; to: string }
    | { kind: 'no_op'; status: string }
    | { kind: 'illegal'; from: string; to: string };

/**
 * Pure-function transition check. Returns `null` on a legal
 * transition, or a discriminated error variant the caller can
 * forward to `badRequest()` with a precise message.
 */
export function checkWorkItemTransition(
    from: string,
    to: string,
): WorkItemTransitionError | null {
    if (!(from in WORK_ITEM_TRANSITIONS)) {
        return { kind: 'unknown_from', from };
    }
    if (!(to in WORK_ITEM_TRANSITIONS)) {
        return { kind: 'unknown_to', to };
    }
    if (from === to) {
        return { kind: 'no_op', status: from };
    }
    const allowed = WORK_ITEM_TRANSITIONS[from as WorkItemStatusValue];
    if (!allowed.has(to as WorkItemStatusValue)) {
        return { kind: 'illegal', from, to };
    }
    return null;
}

/**
 * Render a transition error into a human-readable message.
 * Used by the usecase shim to keep the wording consistent across
 * task + issue setStatus paths.
 */
export function formatTransitionError(
    err: WorkItemTransitionError,
): string {
    switch (err.kind) {
        case 'unknown_from':
            return `Unknown current status "${err.from}"; cannot validate transition.`;
        case 'unknown_to':
            return `Unknown target status "${err.to}".`;
        case 'no_op':
            return `Status is already ${err.status}.`;
        case 'illegal':
            return `Illegal work-item transition: ${err.from} → ${err.to}.`;
    }
}
