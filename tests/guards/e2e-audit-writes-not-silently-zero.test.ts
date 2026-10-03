/**
 * A green E2E shard must not be able to hide a dead audit subsystem. (#1289)
 *
 * ## What this protects
 *
 * The audit extension logs `audit.write_failed` and SWALLOWS, deliberately:
 * the business write has already committed and failing it afterwards would be
 * worse (#1269). The consequence is that at the CI gate a working audit
 * subsystem and a completely dead one are the SAME OBSERVATION. On main
 * `e1acca2c5` they were — 275 attempted audit writes on shard 1, 85 on shard
 * 2, zero successes, 28 models, and every run green. #1288 fixed the cause.
 *
 * `scripts/check-e2e-audit-writes.mjs`, run as a step inside the `e2e-shard`
 * job, is what stops it recurring. This file holds both halves of that:
 *
 *   • the WIRING — the step is still in the job, still reads the log the test
 *     step writes, and still asserts against markers the code emits;
 *   • the LOGIC — the script is EXECUTED here against real files, because a
 *     checker that cannot fail is the defect it exists to prevent.
 *
 * ## What it deliberately does NOT prove
 *
 * That the CI step RAN. Nothing in jest can prove that, and the defect in
 * #1288 was reachable only from the bundled Next runtime — jest resolves the
 * module fine, which is exactly why
 * `tests/integration/audit-write-failure-is-loud.test.ts` and
 * `before-commit-audit-queue.test.ts` both stayed green throughout the
 * outage. Read a pass here as "the gate is wired and has teeth", never as
 * "audit writes succeeded".
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

interface Step {
    name?: string;
    id?: string;
    if?: string;
    run?: string;
    'continue-on-error'?: boolean | string;
}
interface Workflow {
    jobs?: Record<string, { steps?: Step[] }>;
}

const wf = yaml.load(read('.github/workflows/ci.yml')) as Workflow;
const shardSteps = (): Step[] => wf.jobs?.['e2e-shard']?.steps ?? [];

const SCRIPT_REL = 'scripts/check-e2e-audit-writes.mjs';
const RUN_STEP = 'Run E2E tests';
// Located by the script it invokes, not by its name: a step name is prose and
// renaming it must not read as the gate having been deleted.
const gateStep = (): Step | undefined => shardSteps().find((s) => (s.run ?? '').includes(SCRIPT_REL));

const FAILURE_MARKER = 'audit.write_failed';
const CONTROL_MARKER = 'pii.middleware_registered';

// ── Executing the real script against real files ──
// A tmpdir rather than checked-in fixtures: the inputs are three lines long,
// and a fixture file that drifts from what the script reads is one more thing
// to keep honest.
const ESC = String.fromCharCode(27);
const CONTROL_LINE = `[WebServer] {"level":30,"component":"pii-middleware","msg":"${CONTROL_MARKER}"}`;
const FAILURE_LINE = `[WebServer] {"level":50,"component":"audit-middleware","tenantId":"t1","model":"Parcel","operation":"create","msg":"${FAILURE_MARKER}"}`;

let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-write-gate-'));
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

const runGate = (contents: string | null, name = 'e2e.log'): { status: number; out: string } => {
    const file = path.join(tmp, name);
    if (contents === null) {
        fs.rmSync(file, { force: true });
    } else {
        fs.writeFileSync(file, contents, 'utf8');
    }
    const res = spawnSync(process.execPath, [path.join(ROOT, SCRIPT_REL), file], {
        encoding: 'utf8',
    });
    return { status: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
};

describe('the E2E audit-write gate is wired into the job', () => {
    it('the guard is reading the real job', () => {
        // Without this every `find` below returns undefined and each assertion
        // would be written against nothing. The job is `e2e-shard`; `e2e` is
        // the one-step aggregate, and reading it instead would silently
        // examine an empty step list.
        expect(shardSteps().length).toBeGreaterThan(5);
        expect(shardSteps().find((s) => s.name === RUN_STEP)).toBeDefined();
    });

    it('the gate runs as a STEP of e2e-shard, not as a new job', () => {
        // A new top-level job would be both a branch-protection change and a
        // check that can pass by being SKIPPED — a skipped required check
        // counts as passing. A step inside an already-required job fails that
        // job, which is the whole point.
        expect(gateStep()).toBeDefined();
        const jobsInvoking = Object.entries(wf.jobs ?? {})
            .filter(([, job]) => (job.steps ?? []).some((s) => (s.run ?? '').includes(SCRIPT_REL)))
            .map(([name]) => name);
        expect(jobsInvoking).toEqual(['e2e-shard']);
    });

    it('it reads exactly the file the test step tees to', () => {
        // Derived on BOTH sides: the producer's path and the consumer's path
        // must be the same expression, not two similar-looking literals. A
        // drifted path yields an unreadable log, which is the vacuity case.
        const written = (shardSteps().find((s) => s.name === RUN_STEP)?.run ?? '').match(
            /tee "([^"]+)"/,
        )?.[1];
        const readBack = (gateStep()?.run ?? '').match(
            /check-e2e-audit-writes\.mjs "([^"]+)"/,
        )?.[1];
        expect(written).toBeTruthy();
        expect(readBack).toBeTruthy();
        expect(readBack).toBe(written);
    });

    it('nothing lets the gate pass by not running or not failing', () => {
        const step = gateStep();
        // `always()` / `failure()` would be wrong in the other direction, but
        // the fatal shapes are `continue-on-error` (fails nothing) and a
        // condition that cannot be true on a green shard.
        expect(step?.['continue-on-error']).not.toBe(true);
        expect(step?.['continue-on-error']).not.toBe('true');
        // No `if:` at all is the intended shape: the default condition runs
        // the step only when every previous step succeeded — a green shard,
        // which is the case this gate is about.
        if (step?.if !== undefined) {
            expect(step.if).not.toMatch(/failure\(\)|cancelled\(\)/);
        }
    });

    it('the tee cannot mask a non-zero exit', () => {
        // A pipeline reports its LAST command and `tee` essentially always
        // succeeds. Without pipefail a timed-out suite writes a truncated log
        // and reports success, and this gate would then be reading a partial
        // file about a run nobody failed.
        expect(shardSteps().find((s) => s.name === RUN_STEP)?.run).toMatch(/set -o pipefail/);
    });
});

describe("the gate's markers are ones the code actually emits", () => {
    // The anti-drift assertions. Both markers are string literals in a log
    // call; rename either and the gate's count silently empties — "zero
    // failures" and "my needle is stale" are the same bytes. So the needles
    // are asserted against their emitters rather than restated here.
    it('the failure marker is emitted by the audit extension', () => {
        expect(read('src/lib/prisma.ts')).toContain(`'${FAILURE_MARKER}'`);
        expect(read(SCRIPT_REL)).toContain(`'${FAILURE_MARKER}'`);
    });

    it('the control marker is emitted once per process by the same module', () => {
        expect(read('src/lib/prisma.ts')).toContain(`'${CONTROL_MARKER}'`);
        expect(read(SCRIPT_REL)).toContain(`'${CONTROL_MARKER}'`);
    });

    it('the control can still REACH the log it is counted in', () => {
        // The control is emitted by the Next server, not by Playwright. It
        // lands in the step's stdout only because `webServer` is piped; flip
        // that to 'ignore' and the control goes to 0 — which this gate reports
        // as a failure rather than a pass, but the cause would be here.
        const cfg = read('playwright.config.ts');
        expect(cfg).toMatch(/stdout:\s*'pipe'/);
    });
});

describe('the gate has teeth (the script is executed, not described)', () => {
    it('FAILS on a log containing audit.write_failed', () => {
        const { status, out } = runGate(
            [CONTROL_LINE, FAILURE_LINE, FAILURE_LINE, '  92 passed (6.8m)', ''].join('\n'),
        );
        expect(status).toBe(1);
        expect(out).toContain(FAILURE_MARKER);
    });

    it('passes on a clean log that carries the control', () => {
        const { status, out } = runGate([CONTROL_LINE, '  92 passed (6.8m)', ''].join('\n'));
        expect(status).toBe(0);
        expect(out).toContain('PASS');
    });

    it('FAILS on an EMPTY log — the vacuity case the control exists for', () => {
        // The half that is easy to get wrong. "Zero failures" is exactly what
        // an empty log reports, so a count-only check passes here.
        const { status } = runGate('');
        expect(status).toBe(1);
    });

    it('FAILS on a MISSING log', () => {
        const { status } = runGate(null, 'never-written.log');
        expect(status).toBe(1);
    });

    it('FAILS on a log with no failures AND no control', () => {
        // A real run's output replaced by something that is not it: tests
        // ran, the server's stream is absent. Zero is unmeasured, not clean.
        const { status, out } = runGate(['Running 94 tests using 1 worker', ''].join('\n'));
        expect(status).toBe(1);
        expect(out).toContain('positive control absent');
    });

    it('sees a failure wrapped in ANSI colour codes', () => {
        // Playwright's list reporter colours its output. A colour code landing
        // inside the marker would make a present failure unfindable — a zero
        // that is wrong in the reassuring direction.
        const { status } = runGate(
            [
                `${ESC}[36m${CONTROL_LINE}${ESC}[0m`,
                `${ESC}[31m[WebServer] {"msg":"audit${ESC}[0m.write_failed"}`,
                '',
            ].join('\n'),
        );
        expect(status).toBe(1);
    });

    it('does not count a near-miss token as a failure', () => {
        // `audit.write_failed` as a REGEX matches `auditXwrite_failed`, because
        // `.` is any character. The script counts with indexOf for this reason;
        // a false positive here would red a healthy run.
        const { status } = runGate(
            [CONTROL_LINE, '[WebServer] {"msg":"auditXwrite_failed"}', ''].join('\n'),
        );
        expect(status).toBe(0);
    });
});
