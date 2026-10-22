/**
 * Every probe verdict is named by the workflow that files its issue.
 *
 * ## The collision this exists to prevent recurring
 *
 * `.github/workflows/realtime-probe.yml` deduplicates by ISSUE TITLE, which is
 * what stops an hourly probe failing for a day from opening 24 issues. The
 * cost is that two causes sharing a title share a thread.
 *
 * That bit immediately. `UNCONFIGURED` started life folded into `BROKEN`, so
 * with no secrets set the first thing the monitor would ever have said was "a
 * realtime event is not arriving" — and a genuine outage weeks later would have
 * arrived as a comment on that issue, under that title, with the channel
 * having been healthy the whole time in between.
 *
 * The fix was a title per cause. This is what keeps it true: a fifth verdict
 * added to the script with no mention in the workflow falls through the `*)`
 * arm to the outage title, silently, and the next person to read the issue
 * list is told the channel is down.
 *
 * ## Why it checks "named" rather than "has a case arm"
 *
 * The `*)` default arm matches everything, so a structural check for "an arm
 * exists" can never fail. What can be checked is whether the workflow MENTIONS
 * the verdict at all — in a case arm, in the issue body, anywhere. That is a
 * weaker claim and a sufficient one: the point is to force a decision about a
 * new verdict's title, not to dictate where that decision is expressed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/realtime-probe.mjs');
const WORKFLOW = path.join(ROOT, '.github/workflows/realtime-probe.yml');

/**
 * The verdict states the script can actually emit.
 *
 * Read from the `verdict('X', …)` call sites rather than from the docblock: a
 * comment listing four outcomes stays green while the code emits a fifth, and
 * the call sites are what runs.
 */
function emittedVerdicts(): string[] {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // Deliberately on raw text. `tests/.../blankNonCode` loses a code unit per
    // non-BMP character and has no regex-literal state (#2106), and a comment
    // in this file that happened to contain `verdict('OK'` would only ADD a
    // state to the set — which makes a false positive here, not a false
    // absence. A stripper that mangles the file is the worse trade.
    const found = new Set<string>();
    for (const m of src.matchAll(/\bverdict\(\s*'([A-Z_]+)'/g)) found.add(m[1]);
    return [...found].sort();
}

describe('probe verdicts have somewhere to be reported', () => {
    it('finds the real population on both sides', () => {
        // Either file going missing, or the call convention changing, would
        // otherwise make every assertion below vacuous.
        expect(fs.existsSync(SCRIPT)).toBe(true);
        expect(fs.existsSync(WORKFLOW)).toBe(true);
        expect(emittedVerdicts().length).toBeGreaterThanOrEqual(4);
    });

    it('names every emitted verdict in the workflow', () => {
        const workflow = fs.readFileSync(WORKFLOW, 'utf8');
        const unnamed = emittedVerdicts().filter((v) => !workflow.includes(v));
        if (unnamed.length > 0) {
            throw new Error(
                `${unnamed.length} probe verdict(s) are emitted by the script and ` +
                    `mentioned nowhere in the workflow:\n` +
                    unnamed.map((v) => `  ${v}`).join('\n') +
                    `\n\nThe workflow deduplicates issues BY TITLE, so a verdict with no ` +
                    `title of its own falls through the \`*)\` arm and comments on the ` +
                    `outage issue. Give it a title in the \`case "$VERDICT"\` block, or ` +
                    `say in the issue body why it shares one.`,
            );
        }
        expect(unnamed).toEqual([]);
    });

    it('UNCONFIGURED and BROKEN get DIFFERENT titles — the case this was written for', () => {
        const workflow = fs.readFileSync(WORKFLOW, 'utf8');
        const titles = [...workflow.matchAll(/TITLE="([^"]+)"/g)].map((m) => m[1]);
        // Two distinct titles, not one — this is the assertion that fails if
        // somebody tidies the `case` block back into a single assignment.
        expect(new Set(titles).size).toBeGreaterThanOrEqual(2);
        expect(titles.some((t) => /not configured/i.test(t))).toBe(true);
        expect(titles.some((t) => /not arriving/i.test(t))).toBe(true);
    });

    it('UNCONFIGURED files its issue WITHOUT reddening the run', () => {
        // Two halves that have to hold together, and the failure mode of each
        // is the opposite of the other:
        //
        //   · the run must go green, or the CI-failure notifier files a second
        //     issue on top of this workflow's own — measured at ~24 comments a
        //     day on the notifier's thread while the probe is unconfigured;
        //   · the issue must still be filed, or the signal vanishes entirely,
        //     which is strictly worse than a duplicate.
        //
        // The script's own exit code is unchanged and asserted below: a human
        // running it still sees a failure.
        const wf = fs.readFileSync(WORKFLOW, 'utf8');
        expect(wf).toMatch(/if \[ "\$\{verdict:-BROKEN\}" = "UNCONFIGURED" \]; then[\s\S]{0,300}exit 0/);
        // And the issue step must not be gated on `failure()` alone, which
        // would skip it now that the step succeeds.
        expect(wf).toMatch(/if: failure\(\) \|\| steps\.probe\.outputs\.verdict == 'UNCONFIGURED'/);
    });

    it('a BROKEN verdict still fails the run', () => {
        // The exemption is for UNCONFIGURED only. A dark channel must still
        // redden the cron AND file its issue — that pairing is the one the
        // watch list in ci-failure-issue.yml argues for, and it stays.
        const wf = fs.readFileSync(WORKFLOW, 'utf8');
        const guardIdx = wf.indexOf('= "UNCONFIGURED" ]; then');
        const exitIdx = wf.indexOf('exit $status', guardIdx);
        expect(guardIdx).toBeGreaterThan(-1);
        // `exit $status` survives AFTER the UNCONFIGURED early-exit, so every
        // other non-zero verdict still propagates.
        expect(exitIdx).toBeGreaterThan(guardIdx);
    });

    it('OK and OFF exit 0, and everything else exits non-zero', () => {
        // The exit mapping is the other half: a verdict that exits 0 never
        // reaches the issue step at all, which is the opposite failure — a
        // dark channel reported as healthy. Asserted on the source because
        // running the script needs a live deployment.
        const src = fs.readFileSync(SCRIPT, 'utf8');
        expect(src).toMatch(/process\.exit\(\s*state === 'OK' \|\| state === 'OFF' \? 0 : 1\s*\)/);
        // The shape that was there before, and why it was replaced: it named
        // the FAILING state, so any new verdict defaulted to exit 0 — silence.
        expect(src).not.toMatch(/process\.exit\(state === 'BROKEN' \? 1 : 0\)/);
    });
});
