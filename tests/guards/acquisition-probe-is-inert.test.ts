/**
 * The acquisition probe is INERT without its environment variable — #2381.
 *
 * ## Why this needs asserting rather than reading
 *
 * The probe counts Prisma query events to answer "how many Postgres
 * acquisitions does one stream open make", because under `@prisma/adapter-pg`
 * every query is its own acquisition and the count is not derivable from the
 * code (a `Promise.all` inside `resolveFlags`, and `readFlagTable` possibly
 * cached).
 *
 * It lives in the PRODUCTION client construction path. So "off by default" is a
 * load-bearing safety property, and the two states that matter —
 *
 *   · inert: no listener, no timer, no `log:` on the client
 *   · attached but silent: a listener running and writing nothing
 *
 * — produce the SAME absent output file. An absent file cannot tell them apart,
 * which is why `attachAcquisitionProbe` returns a boolean and why this file
 * asserts on it rather than on the file.
 *
 * ## The enabled path runs in a CHILD process
 *
 * The module reads `process.env.ACQUISITION_PROBE_OUT` once at import time —
 * deliberately, so a variable set later cannot switch the probe on mid-process.
 * That makes the enabled path untestable in-process, so it is driven by a real
 * node subprocess with the variable set.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { ACQUISITION_PROBE_ON, attachAcquisitionProbe } from '@/lib/db/acquisition-probe';

const PROBE = join(process.cwd(), 'src/lib/db/acquisition-probe.ts');

/** A client double that records whether anything subscribed. */
function spyClient() {
    const subscriptions: string[] = [];
    return {
        subscriptions,
        $on(event: 'query', _cb: (e: { duration: number }) => void) {
            subscriptions.push(event);
        },
    };
}

describe('inert without ACQUISITION_PROBE_OUT', () => {
    it('the jest process has the variable unset, so these assertions mean something', () => {
        // The control. If a stray variable were set in the test environment,
        // every assertion below would be testing the enabled path while reading
        // as though it proved the disabled one.
        expect(process.env.ACQUISITION_PROBE_OUT).toBeUndefined();
    });

    it('reports itself off', () => {
        expect(ACQUISITION_PROBE_ON).toBe(false);
    });

    it('subscribes to NOTHING, and says it declined', () => {
        const client = spyClient();
        const attached = attachAcquisitionProbe(client);
        // Both halves: no subscription, AND a false return. The return value is
        // what `prisma.ts` throws on, so a probe that silently declined while
        // `log:` was set would otherwise emit events nobody reads.
        expect(attached).toBe(false);
        expect(client.subscriptions).toEqual([]);
    });

    it('can be called repeatedly without ever subscribing', () => {
        const client = spyClient();
        for (let i = 0; i < 5; i++) expect(attachAcquisitionProbe(client)).toBe(false);
        expect(client.subscriptions).toEqual([]);
    });
});

describe('enabled, driven in a real subprocess', () => {
    function run(events: number[]): { attached: boolean; lines: Record<string, unknown>[]; dir: string } {
        const dir = mkdtempSync(join(tmpdir(), 'acq-probe-'));
        const out = join(dir, 'acq.jsonl');
        const script =
            `const { attachAcquisitionProbe, ACQUISITION_PROBE_ON } = await import(${JSON.stringify(pathToFileURL(PROBE).href)});`
            + `let cb = null;`
            + `const client = { $on: (_e, f) => { cb = f; } };`
            + `const attached = attachAcquisitionProbe(client);`
            + `for (const ms of ${JSON.stringify(events)}) cb({ duration: ms });`
            // Wait past one flush interval, then let the process exit on its
            // own. No process.exit(): if the probe's timer were not unref'd the
            // child would hang here, and the test would time out rather than
            // pass — which is how the unref is asserted.
            + `await new Promise((r) => setTimeout(r, 600));`
            + `console.log(JSON.stringify({ attached, on: ACQUISITION_PROBE_ON }));`;
        const stdout = execFileSync(
            'npx',
            ['tsx', '--input-type=module', '-e', script],
            {
                cwd: process.cwd(),
                encoding: 'utf-8',
                env: { ...process.env, ACQUISITION_PROBE_OUT: out },
                timeout: 120_000,
            },
        );
        const verdict = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() as string) as {
            attached: boolean;
        };
        const lines = existsSync(out)
            ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
            : [];
        return { attached: verdict.attached, lines, dir };
    }

    it('attaches, and buffers many events into ONE line rather than writing per event', () => {
        const { attached, lines, dir } = run([1, 2, 3, 4, 5, 6, 7, 8]);
        try {
            expect(attached).toBe(true);
            // ONE line for eight events. This is the assertion that the probe
            // is not doing synchronous disk I/O on the request path — at 1,000
            // VUs that would be the instrument blocking the event loop it
            // exists to exonerate.
            expect(lines).toHaveLength(1);
            expect(lines[0].queries).toBe(8);
            expect(lines[0].totalMs).toBe(36);
            expect(lines[0].maxMs).toBe(8);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('records NO query text and NO parameters — the keys are exactly five', () => {
        const { lines, dir } = run([5]);
        try {
            // Prisma's query event carries `params`, which holds real column
            // values. A probe that wrote them is one environment variable away
            // from writing them somewhere that is not a throwaway load host.
            // Asserted as an exact key set, so a later addition has to edit
            // this test and say why.
            expect(Object.keys(lines[0]).sort()).toEqual(['maxMs', 'pid', 'queries', 't', 'totalMs']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes nothing at all when no query arrives', () => {
        // An interval with zero queries emits no line, so the output's line
        // count is a measure of activity rather than of elapsed time.
        const { attached, lines, dir } = run([]);
        try {
            expect(attached).toBe(true);
            expect(lines).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
