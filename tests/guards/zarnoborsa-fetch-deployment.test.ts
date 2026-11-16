/**
 * #3081 — the ZarnoBorsa fetch bundle reaches the image, the share, and the
 * container that runs it.
 *
 * ## Why this exists: four pieces, and only three of them shipped
 *
 * #3089 landed the npm script, the compose service, and the app entrypoint's
 * publish step — and NOT the Dockerfile build step. Nothing failed. The image
 * had no `dist/zarnoborsa-fetch.mjs`, so the entrypoint's `[ -f ... ]` guard
 * correctly skipped, the shared volume stayed empty, and the Playwright
 * container sat running a `|| true` command against a file that did not
 * exist. Measured on production after the deploy: `/opt/share/dist/` empty, no
 * publish line in the app log, and the fetch container up with nothing to do.
 *
 * Code-complete is not running. Each piece individually looked present and the
 * CHAIN was broken, which is the shape `seed-deployment` was written for after
 * the same thing nearly happened to `dist/seed.mjs` — this is its sibling.
 *
 * ## It was FOUR links and it is five (#3081, second round)
 *
 * The first version of this guard asserted the four DECLARATIONS and passed
 * while the share stayed empty, because the fifth link is not a declaration
 * at all: the app publishes as uid 1001 and Docker creates a named volume's
 * mount point `root:root` unless the path exists in the image. Measured on
 * production — `rw=true` on the mount, bundle present, directory present,
 * `[ -w ]` false, and `… could not publish zarnoborsa-fetch.mjs (continuing)`
 * in the app log, unread.
 *
 * `rw=true` is Docker's mount flag and says nothing about POSIX ownership.
 * Both counts of this chain were taken by reading declarations, which is the
 * mistake the issue is about; #3099 is the in-image assertion, and this is
 * the source half of the fifth link.
 *
 * ## What it asserts, and why each link is separate
 *
 * A single "does it work" test is impossible here: the pieces live in a
 * Dockerfile, a shell script, a compose file and package.json, and no test
 * process can run that chain. So each link is asserted where it is written,
 * and the VALUE is that the four must agree — a rename in any one of them
 * fails here rather than silently producing an empty share.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Where the APP publishes to, on its own writable mount.
 *
 * The two containers mount the same VOLUME at DIFFERENT paths, and that is
 * deliberate rather than untidy — see `FETCH_PATH`.
 */
const SHARE_PATH = '/opt/share/dist';

/**
 * The package root in the fetch image, where `npm install playwright` put
 * `node_modules`.
 */
const FETCH_PACKAGE_ROOT = '/opt/zarnoborsa';

/**
 * Where the FETCH container mounts that volume — UNDER its package root (#3117).
 *
 * This is the sixth link, and the one no amount of reading declarations found.
 * ESM resolves a bare specifier from the importing FILE's URL and ignores the
 * cwd, so a bundle at `/opt/share/dist/` walks
 * `/opt/share/dist/node_modules` -> `/opt/share` -> `/opt` -> `/` and never
 * reaches `/opt/zarnoborsa/node_modules`. The compose command's
 * `cd /opt/zarnoborsa` is inert for resolution — it is right for the write
 * side and was only ever wrong as a module-resolution mechanism.
 *
 * Measured in the container with both directions: the same file fails outside
 * the package root with `ERR_MODULE_NOT_FOUND` and imports fine inside it. And
 * `node -e 'import("playwright")'` prints RESOLVED there, because `-e` DOES
 * resolve from the cwd — a probe that uses it certifies the package is
 * installed and says nothing about the case that matters.
 */
const FETCH_PATH = `${FETCH_PACKAGE_ROOT}/dist`;
const BUNDLE = 'dist/zarnoborsa-fetch.mjs';

describe('#3081 — the fetch bundle is built, published and mounted', () => {
    it('package.json carries the build script', () => {
        const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
        expect(pkg.scripts?.['build:zarnoborsa']).toBe('node scripts/build-zarnoborsa-fetch.mjs');
    });

    it('the bundler names the entrypoint and the output', () => {
        const src = read('scripts/build-zarnoborsa-fetch.mjs');
        expect(src).toContain("entryPoints: ['scripts/zarnoborsa-fetch.ts']");
        expect(src).toContain(`outfile: '${BUNDLE}'`);
    });

    it('THE LINK THAT WAS MISSING — the Dockerfile runs the build', () => {
        // This is the one #3089 shipped without, and the only one whose
        // absence is invisible at runtime: everything downstream degrades
        // quietly to "nothing to publish".
        const dockerfile = read('Dockerfile');
        expect(dockerfile).toMatch(/npm run build:zarnoborsa/);
    });

    it('it builds BEFORE the dev-dependency prune', () => {
        // esbuild is a devDependency, so a build step after the prune cannot
        // run — and would fail the image build rather than degrade, but the
        // ordering is worth pinning beside its two siblings regardless.
        const dockerfile = read('Dockerfile');
        const build = dockerfile.indexOf('npm run build:zarnoborsa');
        const prune = dockerfile.indexOf('npm prune --omit=dev');
        expect(build).toBeGreaterThan(-1);
        expect(prune).toBeGreaterThan(-1);
        expect(build).toBeLessThan(prune);
    });

    it('the runner stage copies dist, so the bundle ships', () => {
        const dockerfile = read('Dockerfile');
        // A whole-directory copy, which is why no per-bundle COPY is needed —
        // and why dropping it would take worker, seed and this one together.
        expect(dockerfile).toMatch(/COPY --from=builder[^\n]*\/app\/dist \.\/dist/);
    });

    it('THE FIFTH LINK — the image creates the share owned by the runtime user', () => {
        // Without this the named volume's mount point is created root:root and
        // the uid-1001 app cannot write into it, so the publish fails
        // best-effort and the share stays empty with everything else correct.
        const dockerfile = read('Dockerfile');
        expect(dockerfile).toMatch(
            new RegExp(`mkdir -p ${SHARE_PATH}[\\s\\S]{0,80}chown nextjs:nodejs ${SHARE_PATH}`),
        );
    });

    it('and it does so BEFORE dropping to that user', () => {
        // `chown` needs root. After `USER nextjs` the RUN cannot change
        // ownership at all — it would fail the build rather than degrade, but
        // the ordering is the reason the line sits where it does.
        const dockerfile = read('Dockerfile');
        const mk = dockerfile.indexOf(`mkdir -p ${SHARE_PATH}`);
        const user = dockerfile.indexOf('\nUSER nextjs');
        expect(mk).toBeGreaterThan(-1);
        expect(user).toBeGreaterThan(-1);
        expect(mk).toBeLessThan(user);
    });

    it('the entrypoint publishes it to the share the container mounts', () => {
        const entry = read('scripts/entrypoint.sh');
        expect(entry).toContain(BUNDLE);
        expect(entry).toContain(SHARE_PATH);
    });

    it('the compose service mounts that same VOLUME, read-only', () => {
        const compose = read('deploy/docker-compose.vm.yml');
        // The same volume, at the consumer's own path. What must agree across
        // the three files is the VOLUME NAME and each container's own path —
        // not one shared path, which is what this asserted until #3117.
        expect(compose).toContain(`appdist:${FETCH_PATH}:ro`);
        // And the app mounts it WRITABLE, or it cannot publish.
        expect(compose).toContain(`appdist:${SHARE_PATH}\n`);
        expect(compose).toContain('agrent-zarnoborsa');
    });

    it('THE SIXTH LINK — the fetch mount is UNDER the package root', () => {
        // The whole of #3117. A mount anywhere else leaves the bundle unable
        // to resolve `playwright`, and the command's `|| true` swallows it
        // three times a day with no symptom but absent prices.
        expect(FETCH_PATH.startsWith(`${FETCH_PACKAGE_ROOT}/`)).toBe(true);
        const compose = read('deploy/docker-compose.vm.yml');
        // Derived from the Dockerfile rather than assumed: the package root is
        // wherever `npm install` ran, and if that WORKDIR ever moves this
        // assertion must move with it.
        const df = read('deploy/zarnoborsa/Dockerfile');
        expect(df).toContain(`WORKDIR ${FETCH_PACKAGE_ROOT}`);
        // And the bundle is run from the mount, not from the old path.
        expect(compose).not.toContain(`node ${SHARE_PATH}/zarnoborsa-fetch.mjs`);
    });

    it('the container runs the bundle from the mount, not from its own image', () => {
        const compose = read('deploy/docker-compose.vm.yml');
        expect(compose).toContain(`node ${FETCH_PATH}/zarnoborsa-fetch.mjs`);
    });

    /*
     * ── THE OUTPUT CHAIN (#3120) ──────────────────────────────────────────
     *
     * Everything above delivers the SCRIPT. This delivers what the script
     * PRODUCES, and it has the identical structure: the fetch writes a file
     * into a volume, and a DIFFERENT container has to mount that volume to
     * read it.
     *
     * The guard asserted the first chain and not the second, so the fetch ran,
     * wrote a 20 KB handoff, and `zarnoborsa-pull` reported `unaudited` /
     * `no-file` — because the `zarnoborsa` volume was declared on exactly ONE
     * service, the producer. Measured by running the job rather than reading
     * the file: 7ms, nothing read.
     *
     * Derived from the PATH CONSTANT rather than a remembered service name, so
     * moving the handoff moves this assertion with it.
     */
    it('THE OUTPUT CHAIN — the worker mounts the volume holding the handoff', () => {
        const pull = read('src/app-layer/jobs/zarnoborsa-pull.ts');
        const m = /ZARNOBORSA_HANDOFF = '([^']+)'/.exec(pull);
        expect(m).not.toBeNull();
        const handoffDir = m![1].replace(/\/[^/]+$/, '');
        // A control on the derivation: an empty or truncated capture would make
        // every `toContain` below trivially true.
        expect(handoffDir).toMatch(/^\/\S+\/\S+/);

        const compose = read('deploy/docker-compose.vm.yml');
        // The PRODUCER writes there.
        expect(compose).toContain(`zarnoborsa:${handoffDir}\n`);
        // And the CONSUMER reads there — read-only, because the direction is
        // one way and a writable mount would let the consumer corrupt its own
        // input.
        expect(compose).toContain(`zarnoborsa:${handoffDir}:ro`);
    });

    it('and the job that reads it runs on the WORKER, which is why that mount is the worker\'s', () => {
        // The assertion above would pass if BOTH mounts were on the fetch
        // container. This pins which service consumes: `zarnoborsa-pull` is a
        // scheduled job, scheduled jobs run in the worker container, and the
        // schedule is where that is written down.
        const schedules = read('src/app-layer/jobs/schedules.ts');
        expect(schedules).toContain("name: 'zarnoborsa-pull'");
        const compose = read('deploy/docker-compose.vm.yml');
        const worker = compose.slice(compose.indexOf('\n  worker:'));
        const nextService = worker.slice(1).search(/\n  [a-z][a-z-]*:\n/);
        const workerBlock = nextService > -1 ? worker.slice(0, nextService + 1) : worker;
        expect(workerBlock).toContain('zarnoborsa:/var/lib/agrent/zarnoborsa:ro');
    });

    it('its image is built locally rather than pulled', () => {
        // The base image ships the browsers and no `playwright` package, so a
        // bare pull cannot run the bundle — measured on the VM.
        const compose = read('deploy/docker-compose.vm.yml');
        expect(compose).toContain('agrent-zarnoborsa:local');
        expect(compose).toContain('context: ./deploy/zarnoborsa');
        const df = read('deploy/zarnoborsa/Dockerfile');
        expect(df).toMatch(/FROM mcr\.microsoft\.com\/playwright:v[\d.]+-\w+/);
        expect(df).toMatch(/npm install[^\n]*playwright@[\d.]+/);
    });

    it('the driver is pinned to the base image tag', () => {
        // Playwright's package and its bundled browser revision are a coupled
        // pair; a floating version against a pinned base is how a driver ends
        // up talking to a browser it does not know.
        const df = read('deploy/zarnoborsa/Dockerfile');
        const base = /FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-/.exec(df);
        const pkg = /playwright@([\d.]+)/.exec(df);
        expect(base).not.toBeNull();
        expect(pkg).not.toBeNull();
        expect(pkg?.[1]).toBe(base?.[1]);
    });
});
