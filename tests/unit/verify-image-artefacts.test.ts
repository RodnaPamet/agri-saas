/**
 * #3099 — the dist/ artefact verifier, EXECUTED.
 *
 * `coverage-scripts.test.ts` set this pattern and its reason applies with
 * force here: the contract is an EXIT CODE that a CI gate acts on, and a guard
 * that read this script's source would grade its text while leaving the thing
 * CI depends on unexercised. The repo's worst instance of that was the
 * coverage gate itself — 675 lines deciding whether CI passes, every test
 * naming them a guard, and BOTH seams neuterable with 28 of 28 green.
 *
 * So the script is SPAWNED against synthetic trees, because the one property
 * that matters cannot be checked any other way: **does it exit non-zero when
 * an artefact is missing or short, and zero only when all six are present and
 * above their floors.**
 */
import { execFile } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '../../scripts/verify-image-artefacts.mjs');

/** Measured in the production image 2026-11-16; the script's floors derive from these. */
const REAL_SIZES: Record<string, number> = {
    'worker.mjs': 3_016_110,
    'scheduler.mjs': 106_388,
    'seed.mjs': 297_724,
    'machine-listener.mjs': 37_839,
    'worker-healthcheck.mjs': 1_734,
    'zarnoborsa-fetch.mjs': 7_490,
};

function run(
    root: string,
    env?: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
        /*
         * `process.execPath`, not `'node'`.
         *
         * The binary-check case below scrubs PATH to make `pdftotext`
         * unfindable — and with `'node'` that also hid node from THIS spawn,
         * so the child never started and stderr came back empty. The test
         * then failed for the right reason by accident while proving nothing
         * about the script. An absolute interpreter keeps PATH governing only
         * the lookup under test.
         */
        execFile(process.execPath, [SCRIPT, root], { env: env ?? process.env }, (e, stdout, stderr) => {
            const code = e && typeof (e as { code?: number }).code === 'number'
                ? (e as { code: number }).code
                : e ? 1 : 0;
            resolve({ code, out: String(stdout), err: String(stderr) });
        });
    });
}

/** A tree whose `dist/` holds every artefact at its real shipped size. */
function makeGoodTree(over: Record<string, number | null> = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'vartefacts-'));
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    // The root controls: what the runner stage COPYs and starts from.
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, '.next'), { recursive: true });
    for (const [file, size] of Object.entries(REAL_SIZES)) {
        const override = Object.prototype.hasOwnProperty.call(over, file) ? over[file] : size;
        if (override === null) continue; // deliberately absent
        writeFileSync(join(dist, file), Buffer.alloc(override as number, 0x20));
    }
    return root;
}

describe('verify-image-artefacts.mjs — executed, not read', () => {
    const made: string[] = [];
    const tree = (over?: Record<string, number | null>) => {
        const r = makeGoodTree(over);
        made.push(r);
        return r;
    };
    afterAll(() => {
        for (const r of made) rmSync(r, { recursive: true, force: true });
    });

    it('EXIT 0 on a complete tree — the control for every refusal below', async () => {
        const r = await run(tree());
        expect(r.code).toBe(0);
        // The DENOMINATOR, printed: a green run over three artefacts and one
        // over six are the same line without it.
        expect(r.out).toContain('6 artefact(s) present and above floor');
    });

    it.each(Object.keys(REAL_SIZES))('EXIT 1 when %s is ABSENT', async (file) => {
        const r = await run(tree({ [file]: null }));
        expect(r.code).toBe(1);
        expect(r.err).toContain(`${file} is ABSENT`);
    });

    it('EXIT 1 when a bundle is SHORT — what existsSync cannot see', async () => {
        // esbuild can fail after opening its output file, which leaves a short
        // file rather than none. 200 bytes is the shape of that failure.
        const r = await run(tree({ 'zarnoborsa-fetch.mjs': 200 }));
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/zarnoborsa-fetch\.mjs is 200 bytes, under its \d+ floor/);
    });

    it('EXIT 1 on the artefact with real teeth, too', async () => {
        // `worker-healthcheck.mjs` is 1,734 bytes — the smallest by three
        // orders of magnitude, and the one the container healthcheck RUNS. A
        // single global floor would either pass a truncated worker.mjs or fail
        // this, and failing this is the worst available false alarm.
        const r = await run(tree({ 'worker-healthcheck.mjs': 100 }));
        expect(r.code).toBe(1);
        expect(r.err).toContain('worker-healthcheck.mjs is 100 bytes');
    });

    it('a bundle that GREW is fine — a floor, never a range', async () => {
        // Growth is routine: a dependency bump, a new subcommand. An upper
        // bound would turn that into a red check and teach people to raise it.
        const r = await run(tree({ 'worker.mjs': REAL_SIZES['worker.mjs'] * 3 }));
        expect(r.code).toBe(0);
    });

    describe('the POSITIVE CONTROL — a wrong root must not read as a clean image', () => {
        it('EXIT 1 when the root is NOT the app image — nothing is concluded', async () => {
            // The case the control exists for: a path that resolves and is not
            // the WORKDIR. Every artefact is "absent" there, and reporting
            // that as a finding about the image would be a fact about the
            // probe instead.
            const root = mkdtempSync(join(tmpdir(), 'vartefacts-notapp-'));
            made.push(root);
            const r = await run(root);
            expect(r.code).toBe(1);
            expect(r.err).toContain('not the app image');
            expect(r.err).toContain('nothing is concluded');
        });

        it('EXIT 1 when the root IS the app image and dist/ is absent', async () => {
            // Distinct from the above, and the distinction is the point: this
            // one IS a finding about the image.
            const root = mkdtempSync(join(tmpdir(), 'vartefacts-nodist-'));
            made.push(root);
            writeFileSync(join(root, 'package.json'), '{}');
            mkdirSync(join(root, '.next'));
            const r = await run(root);
            expect(r.code).toBe(1);
            expect(r.err).toContain('did not happen');
        });

        it('EXIT 1 when dist/ exists and is EMPTY', async () => {
            const root = mkdtempSync(join(tmpdir(), 'vartefacts-empty-'));
            made.push(root);
            writeFileSync(join(root, 'package.json'), '{}');
            mkdirSync(join(root, '.next'));
            mkdirSync(join(root, 'dist'));
            const r = await run(root);
            expect(r.code).toBe(1);
            expect(r.err).toContain('is EMPTY');
        });

        it('a MISSING worker.mjs is reported as missing, not as a wrong directory', async () => {
            // The regression this restructure exists for. `worker.mjs` used to
            // be both a checked artefact AND the positive control, so its
            // absence reported "the directory is not the one this script is
            // about" — sending an operator after a wrong rootDir when the
            // directory was right and the worker bundle was genuinely gone.
            // Both exit 1; only one of them is the correct diagnosis.
            const r = await run(tree({ 'worker.mjs': null }));
            expect(r.code).toBe(1);
            expect(r.err).toContain('worker.mjs is ABSENT');
            expect(r.err).not.toContain('not the app image');
        });
    });

    describe('the BINARY check — #3136', () => {
        it('reports pdftotext RUNNING, with its version', async () => {
            // The control. A check that only ever printed a name would pass
            // against a file that is not executable at all.
            const { code, out } = await run(makeGoodTree());
            expect(code).toBe(0);
            expect(out).toMatch(/pdftotext runs — pdftotext version/);
        });

        it('EXIT 1 when pdftotext is not on PATH', async () => {
            // The whole reason this check exists: a missing `poppler-utils`
            // produces no build error and no startup error. The job would
            // download the bulletin, the subprocess would fail, and the run
            // would report `unreadable` — which a changed bulletin also
            // reports. Scrubbing PATH is how that absence is simulated
            // without uninstalling anything.
            const { code, err } = await run(makeGoodTree(), {
                ...process.env,
                PATH: mkdtempSync(join(tmpdir(), 'empty-path-')),
            });
            expect(code).toBe(1);
            expect(err).toMatch(/pdftotext could not be executed/);
            expect(err).toMatch(/mzh-prices-pull/);
        });

        it('counts the binary in its own failure line, not among the artefacts', async () => {
            // A diagnosis that said "1 of 6 artefacts" for a missing binary
            // would send an operator looking at `dist/` — the
            // `uniform-failure-shape-blinds-the-client` shape the control
            // above the artefact loop exists to prevent.
            const { err } = await run(makeGoodTree(), {
                ...process.env,
                PATH: mkdtempSync(join(tmpdir(), 'empty-path-')),
            });
            expect(err).toMatch(/binar\(ies\) missing, short or unrunnable/);
        });
    });

    it('its floors sit BELOW the measured sizes, and not by a hair', async () => {
        // A floor at or above the measured size would fail every real image;
        // a floor at 1 byte would pass a stub. Read the floors out of the
        // script rather than restating them, so this cannot drift.
        const src = require('fs').readFileSync(SCRIPT, 'utf8') as string;
        const rows = [...src.matchAll(/file: '([^']+)', floor: ([\d_]+), measured: ([\d_]+)/g)];
        expect(rows).toHaveLength(6);
        for (const [, file, floorRaw, measuredRaw] of rows) {
            const floor = Number(floorRaw.replace(/_/g, ''));
            const measured = Number(measuredRaw.replace(/_/g, ''));
            expect(REAL_SIZES[file]).toBe(measured);
            expect(floor).toBeLessThan(measured);
            // Roughly half: loose enough for routine growth, tight enough that
            // a collapse cannot slip under.
            expect(floor).toBeGreaterThan(measured * 0.25);
            expect(floor).toBeLessThan(measured * 0.75);
        }
    });
});
