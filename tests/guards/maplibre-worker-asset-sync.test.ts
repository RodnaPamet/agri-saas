/**
 * The served maplibre worker must be byte-identical to the installed one.
 *
 * maplibre v6 is ESM-only and loads its worker from a real URL instead of an
 * inlined blob. It derives that URL by swapping the filename on its own
 * `import.meta.url`, which under webpack points into `/_next/static/chunks/`
 * where no such file is ever emitted — so the worker 404s and the map never
 * initializes. We therefore serve it ourselves from `public/maplibre/` and
 * point `<Map workerUrl>` at it (see `MapCanvas.tsx`).
 *
 * That buys a working map and a maintenance hazard: TWO copies of a
 * version-specific artifact, one in `node_modules` and one in git. A maplibre
 * bump updates the first and silently leaves the second behind. The failure
 * mode is not a build error — it is a worker running LAST release's code
 * against this release's main thread, which is the kind of thing that surfaces
 * as an inexplicable rendering bug months later.
 *
 * So: assert byte-identity, and make the fix a one-liner in the message.
 *
 * WHY THE COPIES ARE CHECKED IN rather than generated. Both obvious generation
 * hooks are dead ends in this repo's Docker pipeline:
 *   - `postinstall` runs in the `deps` stage, which has only package.json,
 *     package-lock.json and patches/ — there is no `public/` there, and the
 *     builder copies only `node_modules` out of that stage.
 *   - a `prebuild` npm script never fires either: the builder runs
 *     `npx next build --webpack` directly, not `npm run build`.
 * Checked-in files ride the builder's `COPY . .` and the runner's
 * `COPY --from=builder /app/public ./public` with no pipeline changes at all.
 *
 * The consequence is that a maplibre bump needs a human, because Dependabot
 * cannot run a copy — so the refresh has a name, `npm run maplibre:sync`
 * (`scripts/sync-maplibre-worker.mjs`), which is both the remedy this message
 * prints and the seam a CI step could call. Whether CI should call it is
 * #1807; nothing here depends on that answer.
 *
 * ## ONE file since maplibre 6.15 (#2443)
 *
 * This docblock used to say "BOTH files are required", because up to 6.11.2
 * `maplibre-gl-worker.mjs` was a 19 KB ES module doing
 * `import … from "./maplibre-gl-shared.mjs"` and the 516 KB sibling had to sit
 * beside it or the map 404'd.
 *
 * 6.15 inlined that chunk into the worker — 519 KB, self-contained, **zero**
 * references to the sibling — and still publishes `maplibre-gl-shared.mjs` as
 * a **0-byte file**. So the old sentence stayed grammatical and became false,
 * while the guard kept passing: its only cross-asset check was that the two
 * digests DIFFER, and an empty file differs from a 519 KB one. A safety
 * argument expiring with nothing going red.
 *
 * Keeping it would have meant requiring an empty file nothing imports, on the
 * strength of a sentence that is no longer true — so it is dropped from
 * `REQUIRED_ASSETS` and deleted from `public/maplibre/`. The 0-byte file was
 * never protection for a stale client either: it resolves and then fails on
 * missing exports.
 *
 * What makes that reversible is the inverted assertion below: the worker must
 * import NOTHING. If upstream re-splits the bundle, that fails and names the
 * fix, instead of the map 404ing at runtime.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SERVED_DIR = path.join(ROOT, 'public/maplibre');
const DIST_DIR = path.join(ROOT, 'node_modules/maplibre-gl/dist');

/**
 * Every file that must be served. One entry since 6.15 inlined the shared
 * chunk — see the header. A second entry returning here means upstream
 * re-split the bundle, and `the worker imports nothing` below is what will
 * tell you.
 */
const REQUIRED_ASSETS = ['maplibre-gl-worker.mjs'];

/**
 * Dropped from REQUIRED_ASSETS, and named so the deletion is searchable: a
 * reader finding `maplibre-gl-shared.mjs` in a stale comment elsewhere lands
 * here rather than concluding the sync script forgot a file.
 */
const INLINED_SINCE_6_15 = 'maplibre-gl-shared.mjs';

const sha256 = (p: string) =>
    createHash('sha256').update(fs.readFileSync(p)).digest('hex');

describe('maplibre worker asset is in sync with the installed package', () => {
    /**
     * CONTROLS, and they were missing.
     *
     * `scripts/selector-teeth.mjs` stubbed `sha256` to return a constant and
     * every test below still PASSED. It was right to call that dead: each
     * comparison here is between two values from the SAME function, so
     * `'' === ''` satisfies all of them.
     *
     * The consequence is narrow but real. This guard has teeth against a stale
     * asset — corrupt `public/maplibre/maplibre-gl-worker.mjs` and it reddens —
     * and had none against ITSELF reading nothing. The concrete way that bites
     * is a path refactor: if `SERVED_DIR` and `DIST_DIR` ever resolved to the
     * same place, every assertion would compare a file to itself and pass for
     * ever, and the `existsSync` checks would pass too.
     *
     * So the controls assert what the comparisons cannot: that the hash
     * function discriminates on this very population, and that the two sides
     * are actually two places.
     */
    it('CONTROL: sha256 tells two different files apart', () => {
        // THIS CONTROL USED TO REST ON THERE BEING TWO REQUIRED ASSETS — it
        // hashed the worker and its shared chunk and asserted the digests
        // differ. Dropping the shared chunk (#2443) would have left it hashing
        // ONE file and comparing a set of size 1 to a length of 1, which is
        // true for `sha256` returning '' / 0 / null / undefined / false — the
        // precise mutation `scripts/selector-teeth.mjs` already proved
        // survives here. The list shrank for a good reason; the control must
        // not shrink with it.
        //
        // So it no longer borrows its second value from the required set. It
        // hashes the asset and a file guaranteed to differ, which keeps the
        // discrimination independent of how many assets ship.
        const asset = sha256(path.join(DIST_DIR, REQUIRED_ASSETS[0]));
        const other = sha256(path.join(ROOT, 'scripts/sync-maplibre-worker.mjs'));

        expect(asset).not.toBe(other);
        expect(asset).toMatch(/^[0-9a-f]{64}$/);
        expect(other).toMatch(/^[0-9a-f]{64}$/);

        // And the population is non-empty: `it.each([])` registers NO tests,
        // so an emptied list would delete every assertion below rather than
        // fail one.
        expect(REQUIRED_ASSETS.length).toBeGreaterThan(0);
    });

    it('CONTROL: the two compared sides are different directories', () => {
        expect(path.resolve(SERVED_DIR)).not.toBe(path.resolve(DIST_DIR));
    });

    it.each(REQUIRED_ASSETS)('%s is served from public/maplibre', (asset) => {
        const served = path.join(SERVED_DIR, asset);
        expect(fs.existsSync(served)).toBe(true);
    });

    it.each(REQUIRED_ASSETS)(
        '%s is byte-identical to node_modules/maplibre-gl/dist',
        (asset) => {
            const served = path.join(SERVED_DIR, asset);
            const dist = path.join(DIST_DIR, asset);

            // Fail CLOSED if the source is missing: "the file I was going to
            // compare against isn't there" must not read as "in sync".
            expect(fs.existsSync(dist)).toBe(true);
            expect(fs.existsSync(served)).toBe(true);

            const servedHash = sha256(served);
            const distHash = sha256(dist);

            if (servedHash !== distHash) {
                throw new Error(
                    `public/maplibre/${asset} is STALE — it does not match the installed ` +
                        `maplibre-gl.\n\n` +
                        `The map would run last release's worker against this release's main ` +
                        `thread. Refresh both files in the same commit as the bump:\n\n` +
                        `  npm run maplibre:sync\n\n` +
                        `(It copies every entry in REQUIRED_ASSETS and verifies the result, so a ` +
                        `copy whose source was missing fails instead of leaving the stale file ` +
                        `shipping. This used to print a bare \`cp\` with brace expansion, which ` +
                        `is not POSIX sh — the remedy silently did nothing on some shells.)\n\n` +
                        `served: ${servedHash.slice(0, 16)}…  installed: ${distHash.slice(0, 16)}…`,
                );
            }
            expect(servedHash).toBe(distHash);
        },
    );

    it('the worker is self-contained — it imports NOTHING', () => {
        // THE INVERSION, and the thing that makes dropping the sibling safe to
        // reverse. This test used to assert the opposite: that the worker DOES
        // import a same-directory sibling, which was the stated reason two
        // files shipped. 6.15 inlined the chunk, so that assertion now fails
        // loudly — which is correct, and is how this change was found.
        //
        // Asserting the absence is what keeps the claim honest in the other
        // direction: if upstream re-splits the bundle, the worker regains an
        // import, this fails, and the message says to put the sibling back.
        // Without it, a re-split would 404 the shared chunk at runtime and the
        // map would die silently — MapCanvas registers no onError, so that is
        // 60vh of empty rectangle with nothing to explain it.
        const worker = fs.readFileSync(
            path.join(SERVED_DIR, REQUIRED_ASSETS[0]),
            'utf8',
        );
        const specifiers = [...worker.matchAll(/from\s*["']([^"']+)["']/g)].map(
            (m) => m[1],
        );
        if (specifiers.length > 0) {
            throw new Error(
                `${REQUIRED_ASSETS[0]} imports ${specifiers.length} module(s) — `
                    + `${specifiers.join(', ')}.\n\n`
                    + `Upstream has re-split the worker bundle. Every specifier must be a `
                    + `same-directory sibling that is actually SERVED, so add it to `
                    + `REQUIRED_ASSETS in this file and to ASSETS in `
                    + `scripts/sync-maplibre-worker.mjs, then run \`npm run maplibre:sync\`.\n\n`
                    + `Until then the map 404s that import at runtime and dies with no `
                    + `error UI. maplibre 6.15 inlined \`${INLINED_SINCE_6_15}\` (#2443), `
                    + `which is why only the worker ships today.`,
            );
        }
        expect(specifiers).toEqual([]);

        // And the file really was read — an empty string has no imports either,
        // which would satisfy the assertion above for the wrong reason.
        expect(worker.length).toBeGreaterThan(100_000);
    });

    it(`${INLINED_SINCE_6_15} is no longer served, and upstream ships it empty`, () => {
        // Both halves of the decision, pinned. If a future bump gives the file
        // real content again, the second assertion fails — which is the signal
        // to reconsider serving it rather than to edit this number.
        expect(fs.existsSync(path.join(SERVED_DIR, INLINED_SINCE_6_15))).toBe(false);

        const upstream = path.join(DIST_DIR, INLINED_SINCE_6_15);
        if (fs.existsSync(upstream)) {
            expect({ file: INLINED_SINCE_6_15, bytes: fs.statSync(upstream).size })
                .toEqual({ file: INLINED_SINCE_6_15, bytes: 0 });
        }
    });

    it('MapCanvas points <Map workerUrl> at the served path', () => {
        // The asset is useless unless something asks maplibre to use it, and
        // maplibre's own default silently resolves to a chunk path that is
        // never emitted. Pin the wiring to the path we actually serve.
        const src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/map/MapCanvas.tsx'),
            'utf8',
        );
        expect(src).toContain("'/maplibre/maplibre-gl-worker.mjs'");
        expect(src).toMatch(/workerUrl=\{MAPLIBRE_WORKER_URL\}/);
    });

    it('CI answers the drift in thirty seconds, not in a test shard (#1807)', () => {
        // This guard IS the enforcement, and it is also the wrong place to
        // learn about the problem: it lands as two failures among 5395 tests
        // in a sharded run, and the remedy is one command.
        //
        // Dependabot cannot run that command, so every maplibre bump reddens
        // this and stays red until a person notices — which is the security
        // backlog waiting on somebody reading a test name. The `lint` job now
        // checks it directly, with a GitHub annotation naming the fix.
        //
        // Pinned here because that step is precisely what a later cleanup
        // removes as redundant WITH this guard. It is not redundant: this one
        // says the tree is wrong, that one says so early and says what to do.
        const pkg = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
        ) as { scripts?: Record<string, string> };
        expect(`maplibre:check: ${pkg.scripts?.['maplibre:check']}`).toContain('--check');
        expect(`maplibre:sync: ${pkg.scripts?.['maplibre:sync']}`).toContain(
            'scripts/sync-maplibre-worker.mjs',
        );

        const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
        expect(ci).toContain('npm run maplibre:check');

        // And the CHECK mode must not write. A checker that repairs the tree
        // reports success on the second run and the drift ships — the exact
        // shape of the `cp`-that-silently-did-nothing this script replaced.
        const script = fs.readFileSync(
            path.join(ROOT, 'scripts/sync-maplibre-worker.mjs'),
            'utf8',
        );
        expect(script).toMatch(/CHECK_ONLY\s*=\s*process\.argv\.includes\('--check'\)/);
        expect(script).toMatch(/if \(!CHECK_ONLY\) mkdirSync/);
        expect(script).toMatch(/::error file=public\/maplibre\//);
    });
});
