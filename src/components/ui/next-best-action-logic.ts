/**
 * Pure priority-chain resolution for `<NextBestActionCard>` (v2-PR-11).
 *
 * Lives in its own React-free module so guard tests can import it
 * without dragging in CVA / Dub utils / next/link via the
 * containing component file.
 *
 * The chain order IS the contract — see
 * `tests/guards/next-best-action-discipline.test.ts`.
 */

export interface NextBestActionInput {
    /**
     * % of applicable practices implemented (0–100). Optional — callers
     * that don't surface compliance (e.g. the farm dashboard, which
     * hides the practices page) omit it; absent is treated as fully
     * covered so the low-coverage nudge never fires for them.
     */
    coveragePercent?: number;
    /** Number of evidence rows past their next-review date. */
    overdueEvidence: number;
    /**
     * Number of tasks past dueAt with non-terminal status. Optional —
     * callers that hide the tasks page omit it; absent is treated as 0.
     */
    overdueTasks?: number;
    /** Number of risks with inherent score ≥ 15 (high severity). */
    highRisks: number;
}

export interface NextBestAction {
    /** Stable id used by the ratchet to assert priority order. */
    id:
        | "overdue-evidence"
        | "overdue-tasks"
        | "high-risks"
        | "low-coverage"
        | "readiness-check";
    label: string;
    description: string;
    href: string;
}

export function resolveNextBestAction(
    input: NextBestActionInput,
    tenantHref: (path: string) => string,
): NextBestAction {
    if (input.overdueEvidence > 0) {
        return {
            id: "overdue-evidence",
            label: "Refresh overdue evidence",
            description: `${input.overdueEvidence} evidence record${input.overdueEvidence === 1 ? "" : "s"} past review date.`,
            href: tenantHref("/evidence?filter=expiring"),
        };
    }
    if ((input.overdueTasks ?? 0) > 0) {
        const overdueTasks = input.overdueTasks ?? 0;
        return {
            id: "overdue-tasks",
            label: "Resolve overdue tasks",
            description: `${overdueTasks} task${overdueTasks === 1 ? "" : "s"} past due. Address them before the next audit.`,
            href: tenantHref("/farm-tasks?filter=overdue"),
        };
    }
    if (input.highRisks > 0) {
        return {
            id: "high-risks",
            label: "Review high-severity risks",
            description: `${input.highRisks} risk${input.highRisks === 1 ? "" : "s"} with inherent score ≥ 15. Review treatment plans.`,
            href: tenantHref("/risks?filter=high"),
        };
    }
    if ((input.coveragePercent ?? 100) < 80) {
        const coveragePercent = input.coveragePercent ?? 100;
        return {
            id: "low-coverage",
            label: "Improve practice coverage",
            description: `Coverage is ${Math.round(coveragePercent)}%. Reach 80% to meet the readiness baseline.`,
            href: tenantHref("/clauses"),
        };
    }
    return {
        id: "readiness-check",
        label: "Run a readiness check",
        description:
            "Everything looks good. Generate a readiness report to confirm.",
        href: tenantHref("/audits/readiness"),
    };
}
