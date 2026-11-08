/**
 * The SBOM presence audit is WIRED — #2884.
 *
 * `tests/unit/ci/release-sbom-audit.test.ts` executes the checker and proves
 * it can say no. This holds the other half, which that suite cannot see: that
 * anything RUNS it, on a cadence, and that its red run reaches a human.
 *
 * The split matters because #2884 is not a story about a broken detector. The
 * detector worked — `Attach SBOM` failed loud four times on 2026-11-08 — and
 * the signal still reached nobody, because every issue it produced self-closed
 * on an unrelated later success. A correct checker nobody invokes, or whose
 * failure nobody is told about, is the same outcome by a different route.
 *
 * Four things, each of which a reasonable tidy-up removes:
 *
 *  1. the workflow exists and names the checker;
 *  2. it has a SCHEDULE. The `workflow_run` leg alone cannot see a cancelled
 *     Release, an asset deleted out of band, or a failure whose issue has
 *     already been closed — which is the case that made this necessary;
 *  3. it is in `ci-failure-issue.yml`'s watchlist, so a red run becomes an
 *     issue. (`ci-failure-watchlist` DERIVES that set, so it would also catch
 *     an omission — this asserts the membership as a property of THIS
 *     workflow rather than of the list, so deleting the derivation does not
 *     take the claim with it);
 *  4. `cancel-in-progress` is false. A cancelled state check is a state check
 *     that did not run, which is this file's whole failure mode.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const ROOT = process.cwd();
const AUDIT_PATH = '.github/workflows/sbom-presence-audit.yml';
const NOTIFIER_PATH = '.github/workflows/ci-failure-issue.yml';
const CHECKER = 'scripts/ci/check-release-sboms.mjs';

function load(rel: string): Record<string, unknown> {
    return yaml.load(readFileSync(path.join(ROOT, rel), 'utf8')) as Record<string, unknown>;
}

const audit = load(AUDIT_PATH);
const auditSource = readFileSync(path.join(ROOT, AUDIT_PATH), 'utf8');

/** `on:` parses as the boolean `true` in YAML 1.1 — js-yaml does this too. */
const triggers = (audit.on ?? audit[true as unknown as string]) as Record<string, unknown>;

describe('the audit workflow is wired', () => {
    it('reports what it graded', () => {
        const names = Object.keys(triggers ?? {});
        console.log(
            `[sbom-audit-wiring] ${AUDIT_PATH}: triggers=${names.join(',') || '(none)'} `
            + `name="${String(audit.name)}" checker_referenced=${auditSource.includes(CHECKER)}`,
        );
        // A detector that parsed no triggers would pass every assertion below
        // over nothing.
        expect(names.length).toBeGreaterThan(0);
    });

    it('runs the checker that the unit suite executes', () => {
        // The same path, so the thing proved and the thing scheduled cannot
        // drift. A workflow running a DIFFERENT script would be green here and
        // unverified everywhere.
        expect(auditSource).toContain(CHECKER);
    });

    it('has a SCHEDULE, not only a workflow_run trigger', () => {
        // The `workflow_run` leg is the fast one and it is blind to exactly
        // the case #2884 records: a Release failure whose issue a later green
        // Release already closed. Nothing re-asks the question without a cron.
        expect(triggers).toHaveProperty('schedule');
        const schedule = triggers.schedule as { cron: string }[];
        expect(Array.isArray(schedule) && schedule.length).toBeTruthy();
        for (const entry of schedule) expect(entry.cron).toMatch(/\S/);
    });

    it('also runs after Release, so the blind window is minutes not a day', () => {
        const run = triggers.workflow_run as { workflows?: string[] } | undefined;
        expect(run?.workflows).toContain('Release');
    });

    it('never cancels itself', () => {
        // A cancelled state check and a passing one are indistinguishable from
        // the outside, and `concurrency.cancel-in-progress: true` is the
        // default a reader assumes. `Image tip check` carries the same line
        // for the same reason.
        const concurrency = audit.concurrency as { 'cancel-in-progress'?: boolean };
        expect(concurrency?.['cancel-in-progress']).toBe(false);
    });

    it('is watched by the CI-failure notifier, so a red run reaches somebody', () => {
        // Asserted as a property of THIS workflow. `ci-failure-watchlist`
        // derives the whole set and would catch an omission too — but that
        // guard is about the LIST, and a change that replaced its derivation
        // with a curated array would take this claim with it. Two anchors,
        // because curation is what failed in #805.
        const notifier = load(NOTIFIER_PATH);
        const notifierTriggers = (notifier.on
            ?? notifier[true as unknown as string]) as Record<string, unknown>;
        const watched = (notifierTriggers.workflow_run as { workflows: string[] }).workflows;
        expect(watched).toContain(String(audit.name));
    });
});

describe('the checker is reachable from the repo root', () => {
    it('exists at the path the workflow names', () => {
        // A workflow naming a script that does not exist fails at RUN time,
        // which for a daily cron means a red run nobody reads as "the probe
        // is broken" rather than "the probe found something".
        expect(() => readFileSync(path.join(ROOT, CHECKER), 'utf8')).not.toThrow();
    });
});
