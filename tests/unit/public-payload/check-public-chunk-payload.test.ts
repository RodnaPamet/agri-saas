/**
 * `scripts/ci/check-public-chunk-payload.mjs` — EXECUTED, not described (#1971).
 *
 * The script decides whether the public farm page downloads application-only
 * JS. Every failure mode it has points toward green: a renamed minified marker,
 * a Lighthouse audit that moved, a script URL that does not resolve to a file,
 * a baseline entry for something no longer there. Each of those makes "nothing
 * found" the answer, and "nothing found" is what a passing run looks like.
 *
 * So this drives the real script as a SUBPROCESS over synthetic fixtures —
 * jest's `node` project is CJS and cannot import an `.mjs` at all, the same wall
 * `verify-changed.mjs` hit in #2018, and the same `spawnSync` shape
 * `coverage-scripts.test.ts` uses for the coverage tooling.
 *
 * The fixture build always carries a kitchen-sink chunk holding EVERY marker,
 * which the reports never reference. Without it the control would fire on every
 * case and nothing else could be tested; with it, "findable in the build" and
 * "on the public page" are independent, which is the distinction the script
 * exists to make.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/check-public-chunk-payload.mjs');

/** Markers the script looks for, mirrored here deliberately — see below. */
const MARKERS: Record<string, string> = {
    sonner: 'sonner',
    cmdk: 'cmdk-',
    radix: 'data-radix',
    swr: 'revalidateOnFocus',
};

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-payload-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A fixture build + report pair.
 *
 * @param pageChunks  chunk basename → marker names that chunk carries
 * @param opts.omitFromBuild markers to leave out of the kitchen-sink chunk, so
 *   the control has something to fail on
 * @param opts.extraUrls script URLs with no file behind them
 */
function fixture(
    pageChunks: Record<string, string[]>,
    opts: { omitFromBuild?: string[]; extraUrls?: string[]; audit?: unknown } = {},
) {
    const build = path.join(tmp, 'build');
    const chunkDir = path.join(build, 'static', 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });

    // Referenced by no report: makes every marker findable in the build.
    const omit = new Set(opts.omitFromBuild ?? []);
    const sink = Object.entries(MARKERS)
        .filter(([name]) => !omit.has(name))
        .map(([, marker]) => `/* ${marker} */`)
        .join('\n');
    fs.writeFileSync(path.join(chunkDir, 'kitchen-sink.js'), `${sink}\nexport {};\n`);

    const urls: string[] = [];
    for (const [file, markerNames] of Object.entries(pageChunks)) {
        fs.writeFileSync(
            path.join(chunkDir, file),
            `${markerNames.map((n) => `/* ${MARKERS[n]} */`).join('\n')}\nexport {};\n`,
        );
        urls.push(`http://localhost:3006/_next/static/chunks/${file}`);
    }
    urls.push(...(opts.extraUrls ?? []));

    const lhrDir = path.join(tmp, 'reports');
    fs.mkdirSync(lhrDir, { recursive: true });
    const audits =
        'audit' in opts
            ? (opts.audit as Record<string, unknown>)
            : {
                  'network-requests': {
                      details: {
                          items: [
                              { url: 'http://localhost:3006/f/x', resourceType: 'Document' },
                              ...urls.map((u) => ({ url: u, resourceType: 'Script' })),
                          ],
                      },
                  },
              };
    fs.writeFileSync(path.join(lhrDir, 'lhr-1700000000000.json'), JSON.stringify({ audits }));
    return { lhrDir, build };
}

function run(lhrDir: string, build: string) {
    const r = spawnSync('node', [SCRIPT, lhrDir, build], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('check-public-chunk-payload.mjs', () => {
    it('passes when exactly the two baselined libraries are present', () => {
        // The state the first CI run measured. Every one of the five is
        // baselined, so the check is green — and the only thing left that can
        // fail it is a SIXTH library, which is the honest limit of a baseline
        // this size.
        const { lhrDir, build } = fixture({ 'a.js': ['sonner'], 'b.js': ['swr'] });
        const r = run(lhrDir, build);
        expect(r.status).toBe(0);
    });

    it('FAILS on a library outside the baseline — the whole point', () => {
        // Simulated by shrinking the baseline, because all five known
        // libraries are currently in it: a test that could not express "a new
        // one arrived" would be green forever.
        const { lhrDir, build } = fixture({
            'a.js': ['sonner', 'cmdk'],
            'b.js': ['radix', 'swr'],
        });
        const src = fs.readFileSync(SCRIPT, 'utf8');
        const shrunk = path.join(tmp, 'shrunk.mjs');
        fs.writeFileSync(
            shrunk,
            src.replace(/export const BASELINE = new Set\(\[[\s\S]*?\]\);/, "export const BASELINE = new Set(['sonner']);"),
        );
        const r = spawnSync('node', [shrunk, lhrDir, build], { encoding: 'utf8' });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        expect(r.status).toBe(1);
        // Every one, not just the first: a loop that returned early would hide
        // the rest and the reader would fix one and re-run.
        // cmdk and radix are outside the baseline since #2225, so they are
        // already the "new library" case without shrinking anything.
        for (const name of ['cmdk', 'radix']) {
            expect(out).toContain(`${name} reaches the public page`);
        }
    });

    it('CONTROL: fails when a marker is findable NOWHERE in the build', () => {
        // The failure that makes every absence vacuous. Two of the original
        // six markers were in this state against a real build.
        const { lhrDir, build } = fixture({ 'a.js': ['sonner'] }, { omitFromBuild: ['cmdk'] });
        const r = run(lhrDir, build);
        expect(r.status).toBe(1);
        expect(r.out).toContain('CONTROL FAILED');
        expect(r.out).toContain('cmdk');
    });

    it('fails when a BASELINE entry is no longer on the page', () => {
        // Shrink-only. A baseline naming something absent silently excuses
        // whatever lands there next.
        const { lhrDir, build } = fixture({ 'a.js': [], 'b.js': [] });
        const r = run(lhrDir, build);
        expect(r.status).toBe(1);
        // Every baseline entry is absent here, and each must be reported —
        // the baseline is five entries since the first CI run.
        for (const name of ['sonner', 'swr']) {
            expect(r.out).toContain(`BASELINE names ${name}`);
        }
    });

    it('resolves a PERCENT-ENCODED dynamic-segment chunk path', () => {
        // An app-router dynamic segment is a literal `[handle]` on disk and
        // `%5Bhandle%5D` in the URL. Without decoding, the public route's OWN
        // page chunk resolves to nothing — the one chunk most likely to carry
        // route-specific code is the one never scanned. The first CI run
        // reported exactly this as an unresolved URL.
        const build = path.join(tmp, 'build');
        const dir = path.join(build, 'static', 'chunks', 'app', 'f', '[handle]');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'page-abc.js'), `/* ${MARKERS.sonner} */\nexport {};\n`);
        const sinkDir = path.join(build, 'static', 'chunks');
        fs.writeFileSync(
            path.join(sinkDir, 'kitchen-sink.js'),
            `${Object.values(MARKERS).map((m) => `/* ${m} */`).join('\n')}\nexport {};\n`,
        );
        const lhrDir = path.join(tmp, 'reports');
        fs.mkdirSync(lhrDir, { recursive: true });
        fs.writeFileSync(
            path.join(lhrDir, 'lhr-1700000000001.json'),
            JSON.stringify({
                audits: {
                    'network-requests': {
                        details: {
                            items: [
                                {
                                    url: 'http://localhost:3006/_next/static/chunks/app/f/%5Bhandle%5D/page-abc.js',
                                    resourceType: 'Script',
                                },
                            ],
                        },
                    },
                },
            }),
        );
        const r = run(lhrDir, build);
        // It must RESOLVE (no "did not resolve"), and so must see the sonner
        // inside it — which the baseline then tolerates.
        expect(r.out).not.toContain('did not resolve');
        expect(r.out).toContain('1 resolved under');
    });

    it('fails when a script URL does not resolve to a file', () => {
        // Never silently skipped: an unscanned chunk is an unchecked chunk,
        // and skipping it reads exactly like finding nothing in it.
        const { lhrDir, build } = fixture(
            { 'a.js': ['sonner'] },
            { extraUrls: ['http://localhost:3006/_next/static/chunks/ghost.js'] },
        );
        const r = run(lhrDir, build);
        expect(r.status).toBe(1);
        expect(r.out).toContain('did not resolve');
        expect(r.out).toContain('ghost.js');
    });

    it('fails when the network-requests audit is absent', () => {
        // "The audit moved" and "the page loaded no scripts" are the same
        // observation otherwise, and one of them looks clean.
        const { lhrDir, build } = fixture({ 'a.js': ['sonner'] }, { audit: { 'first-contentful-paint': {} } });
        const r = run(lhrDir, build);
        expect(r.status).toBe(1);
        expect(r.out).toContain("has no 'network-requests' audit");
    });

    it('fails when the report directory holds no lhr-*.json', () => {
        const { build } = fixture({ 'a.js': ['sonner'] });
        const empty = path.join(tmp, 'empty');
        fs.mkdirSync(empty, { recursive: true });
        const r = run(empty, build);
        expect(r.status).toBe(1);
        expect(r.out).toContain('holds no lhr-*.json');
    });

    it('fails when there is no build to scan', () => {
        const { lhrDir } = fixture({ 'a.js': ['sonner'] });
        const r = run(lhrDir, path.join(tmp, 'not-a-build'));
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/no chunk directory|did not resolve/);
    });

    it('is WIRED — the Lighthouse public-farm leg runs it', () => {
        // A check nothing invokes is not a check. `seed-deployment` holds the
        // same shape for the seed build step, and for the same reason: this
        // one lives in a workflow rather than in jest, so deleting the step
        // removes it with nothing going red.
        const wf = fs.readFileSync(
            path.join(ROOT, '.github/workflows/lighthouse.yml'),
            'utf8',
        );
        expect(wf).toContain('scripts/ci/check-public-chunk-payload.mjs');
        // Scoped to the public leg, and `always()` so a failed BUDGET still
        // yields the payload answer.
        expect(wf).toMatch(/if:\s*always\(\) && matrix\.page == 'public-farm'/);
    });

    it('the mirrored marker table still matches the script', () => {
        // MARKERS above is a second copy, which this repo distrusts. It is
        // here because the fixtures must write the real strings, and it is
        // checked against the script's own source so the two cannot drift —
        // the drift would make every case above test a marker nothing uses.
        const src = fs.readFileSync(SCRIPT, 'utf8');
        const declared = [...src.matchAll(/\{ name: '([^']+)', marker: '([^']+)'/g)].map((m) => [
            m[1],
            m[2],
        ]);
        expect(Object.entries(MARKERS).sort()).toEqual(declared.sort());
    });
});
