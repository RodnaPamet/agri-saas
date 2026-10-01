/**
 * The sweep announces its mutation, and this reader believes it only while the
 * sweep is alive. (#1171 mode 1)
 *
 * ## Why these are executing tests
 *
 * The thing most likely to rot here is AGREEMENT between two implementations
 * of one path: the writer is `scripts/selector-teeth.mjs` (ESM, run as a CLI)
 * and the reader is TypeScript loaded by jest. That is the shape of #786 —
 * two code paths over one contract, only one of them maintained. A guard
 * comparing the two files' source text would pass while they computed
 * different paths, so the first test below has the SCRIPT write a marker and
 * this reader read it, in one run.
 *
 * `SELECTOR_TEETH_MARKER` keeps every case hermetic. Without it these tests
 * would write to the git common directory — the location a REAL sweep uses —
 * and could clobber a live claim.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    assertNoForeignMutation,
    markerPath,
    readActiveMutation,
    MARKER_BASENAME,
} from '../helpers/selector-teeth-marker';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/selector-teeth.mjs');

let tmpDir: string;
let marker: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ['SELECTOR_TEETH_MARKER', 'SELECTOR_TEETH_OWNER', 'SELECTOR_TEETH_ALLOW_CONCURRENT']) {
        saved[k] = process.env[k];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teeth-marker-'));
    marker = path.join(tmpDir, MARKER_BASENAME);
    process.env.SELECTOR_TEETH_MARKER = marker;
    delete process.env.SELECTOR_TEETH_OWNER;
    delete process.env.SELECTOR_TEETH_ALLOW_CONCURRENT;
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a marker as if a live sweep had — `process.pid` is this jest worker. */
function writeLiveMarker(extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(
        marker,
        JSON.stringify({
            pid: process.pid,
            file: 'tests/guards/example.test.ts',
            selector: 'pickRows',
            gut: '[]',
            line: 42,
            startedAt: new Date().toISOString(),
            ...extra,
        }),
    );
}

describe('the writer and this reader agree (the drift this would otherwise be)', () => {
    let child: ChildProcess | undefined;

    afterEach(() => {
        child?.kill('SIGKILL');
        child = undefined;
    });

    it("reads a marker the SCRIPT wrote, at the path the SCRIPT computed", async () => {
        // The script writes `process.pid`, so it has to stay alive for the
        // marker to be live — killing it is also how the staleness test below
        // gets a genuinely dead pid rather than a made-up one.
        const src = `
            import { writeMarker, markerPath } from ${JSON.stringify(SCRIPT)};
            writeMarker({ file: 'tests/guards/from-script.test.ts', selector: 'edges', gut: 'new Set()', line: 7 });
            console.log('READY ' + markerPath() + ' ' + process.pid);
            setInterval(() => {}, 1000);
        `;
        child = spawn(process.execPath, ['--input-type=module', '-e', src], {
            env: { ...process.env, SELECTOR_TEETH_MARKER: marker },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const line = await new Promise<string>((resolve, reject) => {
            let buf = '';
            const t = setTimeout(() => reject(new Error(`script never signalled READY; stderr: ${buf}`)), 20_000);
            child!.stdout!.on('data', (d) => {
                buf += String(d);
                const m = buf.match(/READY (\S+) (\d+)/);
                if (m) { clearTimeout(t); resolve(m[0]); }
            });
            child!.stderr!.on('data', (d) => { buf += String(d); });
            child!.on('exit', (c) => { clearTimeout(t); reject(new Error(`script exited ${c}: ${buf}`)); });
        });

        const [, scriptPath, scriptPid] = line.match(/READY (\S+) (\d+)/)!;

        // THE agreement assertion: the path this reader computes is the path
        // the writer wrote to, computed independently in the other language.
        expect(markerPath()).toBe(scriptPath);

        const active = readActiveMutation();
        expect(active).not.toBeNull();
        expect(active!.pid).toBe(Number(scriptPid));
        expect(active!.file).toBe('tests/guards/from-script.test.ts');
        expect(active!.selector).toBe('edges');
        expect(active!.gut).toBe('new Set()');

        // ...and a reader refuses while it is held.
        expect(() => assertNoForeignMutation('probe')).toThrow(/from-script\.test\.ts/);

        // Now kill it: a dead owner must read as ABSENT, with a real corpse
        // rather than an invented pid.
        child.kill('SIGKILL');
        await new Promise<void>((r) => child!.on('exit', () => r()));
        expect(fs.existsSync(marker)).toBe(true); // the file is still there…
        expect(readActiveMutation()).toBeNull(); // …and is not an answer
        expect(() => assertNoForeignMutation('probe')).not.toThrow();
    }, 30_000);

    it('control: the two basenames are the same literal', () => {
        // Cheap, and it catches a rename in one file before the slow test above
        // has to.
        const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
        expect(scriptSrc).toContain(`MARKER_BASENAME = '${MARKER_BASENAME}'`);
    });
});

describe('readActiveMutation — every ambiguous case reads as absent', () => {
    it('no marker at all', () => {
        expect(readActiveMutation()).toBeNull();
    });

    it('unparseable content', () => {
        fs.writeFileSync(marker, 'not json{');
        expect(readActiveMutation()).toBeNull();
    });

    it.each([
        ['no pid', { pid: undefined }],
        ['a non-numeric pid', { pid: 'abc' }],
        ['no file', { file: undefined }],
    ])('a malformed marker (%s)', (_label, extra) => {
        writeLiveMarker(extra as Record<string, unknown>);
        expect(readActiveMutation()).toBeNull();
    });

    it('a dead owner — the sweep cannot always clear its own marker', () => {
        // It spends almost all its wall clock inside a blocking spawnSync,
        // where node cannot deliver a signal, so a SIGTERM can kill it with
        // the marker on disk. Treating that as live would make one interrupted
        // sweep block every test run in the repo until someone noticed.
        const dead = findDeadPid();
        writeLiveMarker({ pid: dead });

        // Prove the marker is WELL-FORMED before asserting it reads as absent,
        // or this test passes through the malformed branch and says nothing
        // about staleness — which is exactly what it did until the fixture was
        // fixed (see findDeadPid).
        const onDisk = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: unknown };
        expect(typeof onDisk.pid).toBe('number');
        expect(onDisk.pid).toBe(dead);

        expect(readActiveMutation()).toBeNull();
    });

    it('control: a LIVE owner is NOT read as stale', () => {
        // Without this, the test above passes for a reader that always
        // returns null — which is a reader with no teeth at all.
        writeLiveMarker();
        expect(readActiveMutation()).not.toBeNull();
        expect(readActiveMutation()!.selector).toBe('pickRows');
    });
});

describe('assertNoForeignMutation', () => {
    it('refuses, naming the file, the selector and the gut', () => {
        writeLiveMarker();
        try {
            assertNoForeignMutation('globalSetup');
            throw new Error('expected a refusal');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('globalSetup');
            expect(msg).toContain('tests/guards/example.test.ts');
            expect(msg).toContain('pickRows');
            expect(msg).toContain('[]');
            expect(msg).toMatch(/MUTANT/);
        }
    });

    it("exempts the sweep's OWN child, which is meant to see the mutant", () => {
        writeLiveMarker();
        process.env.SELECTOR_TEETH_OWNER = String(process.pid);
        expect(() => assertNoForeignMutation('globalSetup')).not.toThrow();
    });

    it('does NOT exempt a different owner', () => {
        writeLiveMarker();
        process.env.SELECTOR_TEETH_OWNER = String(process.pid + 1);
        expect(() => assertNoForeignMutation('globalSetup')).toThrow(/refusing to run/);
    });

    it('the escape hatch downgrades to a loud warning', () => {
        writeLiveMarker();
        process.env.SELECTOR_TEETH_ALLOW_CONCURRENT = '1';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(() => assertNoForeignMutation('globalSetup')).not.toThrow();
            expect(warn).toHaveBeenCalled();
            expect(String(warn.mock.calls[0][0])).toMatch(/PROCEEDING OVER A LIVE MUTATION/);
        } finally {
            warn.mockRestore();
        }
    });

    it('is silent when nothing is being swept', () => {
        expect(() => assertNoForeignMutation('globalSetup')).not.toThrow();
    });
});

describe('the sweep is WIRED to the marker', () => {
    /**
     * These are SOURCE assertions, and they are here because the behavioural
     * tests above cannot reach this: they call `writeMarker` directly, so
     * deleting the call inside `auditFile` would leave all fourteen green
     * while no sweep ever announced anything. Running the real sweep is the
     * only behavioural alternative and costs a jest run per gut — minutes per
     * file, ~104 files. So: one slow, honest structural check of the wiring,
     * next to the fast behavioural checks of the mechanism.
     *
     * If you are here because this failed, the question is whether the sweep
     * still publishes and withdraws its claim — not whether the regex is tidy.
     */
    const src = fs.readFileSync(SCRIPT, 'utf8');

    it('announces BEFORE writing the mutant to disk', () => {
        const i = src.indexOf('writeMarker({ file, selector: sel.name');
        const j = src.indexOf('writeFileSync(file, mutated)');
        expect(i).toBeGreaterThan(-1);
        expect(j).toBeGreaterThan(-1);
        // Ordering is the point: a marker written after the mutation leaves a
        // window where the mutant is on disk unannounced.
        expect(i).toBeLessThan(j);
    });

    it('withdraws the claim in the same `finally` that restores the file', () => {
        const fin = src.slice(src.indexOf('} finally {'), src.indexOf('} finally {') + 300);
        expect(fin).toContain('copyFileSync(backup, file)');
        expect(fin).toContain('clearMarker()');
    });

    it('withdraws it on the signal path too', () => {
        const ra = src.slice(src.indexOf('function restoreActive()'));
        expect(ra.slice(0, 400)).toContain('clearMarker()');
    });

    it("names itself as owner on the jest child it spawns", () => {
        expect(src).toContain('SELECTOR_TEETH_OWNER: String(process.pid)');
    });

    it('clears only ITS OWN marker, so a parallel sweep keeps its claim', () => {
        const cm = src.slice(src.indexOf('export function clearMarker()'));
        expect(cm.slice(0, 400)).toContain('held.pid === process.pid');
    });
});

/**
 * A pid that is certainly not running — spawn something trivial and reap it.
 *
 * `process.stdout.write`, NOT `console.log`: console.log sends the number
 * through util.inspect, which COLOURISES it, so the child printed
 * `"\u001b[33m3099305\u001b[39m"`, `Number()` gave NaN, `JSON.stringify`
 * wrote `pid: null`, and the dead-owner test below passed through the
 * MALFORMED branch without ever exercising the staleness rule. Measured: the
 * test survived a mutation that made `pidAlive` always true.
 *
 * Hence the assertion: a fixture that silently stops producing its fixture
 * turns a real test into a vacuous one.
 */
function findDeadPid(): number {
    const out = execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.pid))'],
        { encoding: 'utf8' },
    ).trim();
    const pid = Number(out);
    if (!Number.isInteger(pid) || pid <= 1) {
        throw new Error(`findDeadPid produced ${JSON.stringify(out)} — not a usable pid`);
    }
    return pid;
}
