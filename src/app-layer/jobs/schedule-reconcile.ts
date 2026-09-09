/**
 * Which repeatable schedulers Redis holds that the code no longer defines.
 *
 * `registerAll` upserts; it has never removed. So a schedule deleted from the
 * code keeps firing in production forever, and the only removal path is
 * `scripts/scheduler.ts --clean`, which the deploy command never passes
 * (`deploy/docker-compose.vm.yml`: `node dist/scheduler.mjs && node
 * dist/worker.mjs`). Refs #803.
 *
 * Kept PURE and separate from the BullMQ I/O so it is testable — the script
 * that owns this logic exports nothing, which is why #803's requested test
 * could not be written against it.
 *
 * @module app-layer/jobs/schedule-reconcile
 */

/** Thrown when the known-set is empty, which would make removal unbounded. */
export class EmptyKnownSetError extends Error {
    constructor() {
        super(
            'refusing to reconcile against an empty known-schedule set: ' +
                'this would remove EVERY scheduler in Redis. ALL_SCHEDULE_NAMES ' +
                'should never be empty; a build or import problem is more likely ' +
                'than every schedule having been deleted.',
        );
        this.name = 'EmptyKnownSetError';
    }
}

/**
 * Names present in Redis but absent from the code.
 *
 * @param existing scheduler names currently registered (from `getJobSchedulers`)
 * @param known    every name the code defines, ENVIRONMENT-INDEPENDENT —
 *                 pass `ALL_SCHEDULE_NAMES`, never `SCHEDULED_JOBS`. A
 *                 key-gated schedule is missing from the latter when its key
 *                 is absent, and removing on that basis deletes live
 *                 schedules on a rotated key.
 * @throws EmptyKnownSetError when `known` is empty.
 */
export function schedulersToRemove(
    existing: readonly (string | undefined)[],
    known: readonly string[],
): string[] {
    // An empty selection must never be authoritative. Without this, a refactor
    // that empties ALL_SCHEDULE_NAMES turns the reconcile from "remove the
    // orphans" into "remove everything", and the deploy that does it looks
    // exactly like a deploy that had no orphans to remove.
    if (known.length === 0) throw new EmptyKnownSetError();

    const knownSet = new Set(known);
    const seen = new Set<string>();
    const orphans: string[] = [];

    for (const name of existing) {
        // BullMQ types `name` as optional; a nameless scheduler cannot be
        // matched against the code, and removing it by empty string would be a
        // guess. Skip it and let it show up in `--list`.
        if (!name) continue;
        if (knownSet.has(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        orphans.push(name);
    }

    return orphans;
}
