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
 * BOTH files are required. `maplibre-gl-worker.mjs` does
 * `import … from "./maplibre-gl-shared.mjs"`, so the sibling must sit in the
 * same directory with that relative specifier intact — shipping only the worker
 * yields a 404 on the shared chunk and the same dead map.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SERVED_DIR = path.join(ROOT, 'public/maplibre');
const DIST_DIR = path.join(ROOT, 'node_modules/maplibre-gl/dist');

/**
 * Every file that must be served. The worker is the entry point; the shared
 * chunk is its static import. Neither works without the other.
 */
const REQUIRED_ASSETS = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

const sha256 = (p: string) =>
    createHash('sha256').update(fs.readFileSync(p)).digest('hex');

describe('maplibre worker asset is in sync with the installed package', () => {
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
                        `  cp node_modules/maplibre-gl/dist/{${REQUIRED_ASSETS.join(',')}} ` +
                        `public/maplibre/\n\n` +
                        `served: ${servedHash.slice(0, 16)}…  installed: ${distHash.slice(0, 16)}…`,
                );
            }
            expect(servedHash).toBe(distHash);
        },
    );

    it('the worker still imports the shared chunk as a same-directory sibling', () => {
        // The reason two files ship rather than one. If upstream ever inlines
        // the shared chunk or renames it, REQUIRED_ASSETS is wrong and this
        // says so, instead of the map silently 404ing at runtime.
        const worker = fs.readFileSync(
            path.join(SERVED_DIR, 'maplibre-gl-worker.mjs'),
            'utf8',
        );
        const specifiers = [...worker.matchAll(/from\s*["']([^"']+)["']/g)].map(
            (m) => m[1],
        );
        expect(specifiers.length).toBeGreaterThan(0);
        for (const spec of specifiers) {
            // Every import must be a sibling in the same served directory.
            expect(spec.startsWith('./')).toBe(true);
            const name = spec.slice(2);
            expect(REQUIRED_ASSETS).toContain(name);
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
});
