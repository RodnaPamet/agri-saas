/**
 * CSP nonce — Next.js component-script patch (2026-05-14).
 *
 * Real-world failure: `_next/static/chunks/18at7xtdx0uoz.js`
 * loaded WITHOUT a nonce attribute in the rendered HTML of every
 * authenticated app page (dashboard, practices, risks, etc.). CSP
 * `strict-dynamic` blocked it, breaking R16 chart code (donut
 * rendered as thin orange crescent only).
 *
 * Root cause: a missing `nonce: ctx.nonce` prop in Next.js 16's
 * internal `createComponentStylesAndScripts` function. The sibling
 * `getLayerAssets` function — which builds the same shape of
 * `<script>` element from the same client-reference manifest —
 * DOES pass `nonce: ctx.nonce`. The bug is one missing line in
 * `node_modules/next/dist/server/app-render/create-component-
 * styles-and-scripts.js`.
 *
 * Diagnosis path (2026-05-14):
 *   1. PR #481 set CSP on REQUEST headers → fixed 54/55 script
 *      tags on the dashboard HTML, but ONE remained unnonced.
 *   2. Captured the dashboard HTML via curl + session cookie →
 *      pinned the unnonced tag's source to its `script-${index}`
 *      key (from `getLayerAssets` / `createComponentStylesAndScripts`).
 *   3. Compared the two functions — `getLayerAssets` passes
 *      `nonce: ctx.nonce`, `createComponentStylesAndScripts` does
 *      not. Verified by re-curl after manually patching the
 *      bundled prod runtime — 0 unnonced scripts, fix confirmed.
 *
 * Fix: apply `patches/next+<version>.patch` via `patch-package`
 * (`postinstall` hook in package.json). The patch adds
 * `nonce: ctx.nonce` to the `createComponentStylesAndScripts`
 * function in:
 *   • `dist/server/app-render/create-component-styles-and-scripts.js`
 *   • `dist/esm/server/app-render/create-component-styles-and-scripts.js`
 *   • All four bundled prod runtimes in
 *     `dist/compiled/next-server/app-page*.prod.js`
 *
 * The .prod.js files are what actually load at runtime; the
 * dist/ + esm/ patches keep the source-level fix visible for the
 * eventual upstream PR.
 *
 * REGRESSION (2026-06-08 → 2026-07-25): #929 bumped next 16.2.6 →
 * 16.2.7 and regenerated the patch. `patch-package` diffs against a
 * freshly-downloaded copy, and the new copy's bundles were pristine —
 * so the four .prod.js hunks were silently dropped and the patch
 * shrank 80 → 28 lines. The unbundled source stayed patched
 * (cosmetic) while the bundle that `next start` actually executes did
 * not, for ~7 weeks. The assertions below did not catch it because
 * the bundle check only required ONE `nonce:` match anywhere in a
 * 5 MB file — and the sibling `getLayerAssets` element, which
 * upstream has always nonced, satisfied it. The check now asserts
 * the ABSENCE of any unnonced site instead, and pins the patch's
 * file coverage, so a regenerated-but-incomplete patch fails CI.
 *
 * Load-bearing invariants — locked here so a future `npm install`
 * or version bump that drops the patch breaks CI:
 *
 *   1. A `patches/next+*.patch` file exists. (Deliberately NOT
 *      version-pinned: hardcoding the version meant every routine
 *      bump had to edit this file, and the friction is part of how
 *      #929 went wrong.)
 *   2. The `postinstall` npm script invokes `patch-package`.
 *   3. The patch covers all six files — both unbundled sources AND
 *      all four prod runtimes. This is the #929 lock.
 *   4. The unbundled source file contains the `nonce: ctx.nonce`
 *      line. (Verifies the patch actually applied — `npm install`
 *      runs `patch-package` via `postinstall`, so on a clean
 *      checkout + install, this assertion passes if and only if
 *      the patch round-tripped successfully.)
 *   5. NO bundled prod runtime contains an unnonced component
 *      script element.
 *   6. The Dockerfile copies `patches/` BEFORE `npm ci`. This is the
 *      one invariant the other five cannot see.
 *
 * SECOND REGRESSION (2026-07-25): restoring the four bundle hunks did
 * not fix production, because the production image had NEVER applied
 * the patch at all. The Dockerfile's deps stage copied only
 * package.json + package-lock.json before `npm ci`, so the
 * `postinstall` patch-package hook logged "No patch files found" and
 * produced an unpatched node_modules, which the builder and runner
 * stages inherit. The builder's `COPY . .` brings patches/ in, but
 * after the install.
 *
 * That made assertions 4 and 5 misleading rather than wrong: they read
 * the LOCAL node_modules, where `npm ci` does see patches/ and the
 * patch does apply. Locally patched, in-image unpatched — so CI was
 * green while every deployed container served the CSP bug. #484's
 * original verification was a MANUAL patch of a running container
 * (see the diagnosis path above), which no redeploy preserves, so this
 * was broken from 2026-05-14 rather than from #929. Assertion 6 closes
 * the gap by checking the image build itself, which is the only one of
 * these signals that reflects what production actually runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** The four bundled prod runtimes — these are what `next start` executes. */
const PROD_RUNTIMES = [
    'app-page.runtime.prod.js',
    'app-page-turbo.runtime.prod.js',
    'app-page-experimental.runtime.prod.js',
    'app-page-turbo-experimental.runtime.prod.js',
];

/**
 * A minified component-script element with NO nonce: the object literal closes
 * (`}`) immediately after the `script-${index}` key. Anchored on the
 * `${ctx.assetPrefix}` src interpolation so it cannot match unrelated elements.
 * A nonced site has `,nonce:<ctx>.nonce` before the brace, so it will not match.
 */
const UNNONCED_SCRIPT_SITE =
    /\{src:`\$\{\w+\.assetPrefix\}[^`]*`,async:!0,key:`script-\$\{\w+\}`\}/;

/**
 * POSITIVE CONTROL — the same fingerprint, but indifferent to whether a nonce
 * follows. Matches a component-script site in EITHER state.
 *
 * `UNNONCED_SCRIPT_SITE` asserts an absence, which is the right shape but has
 * one failure mode: it also passes when it matches NOTHING. If a Next release
 * restructures the minified output, the regex quietly stops describing reality
 * and a completely unpatched bundle sails through — the guard fails OPEN, in
 * precisely the release where the patch is most likely to have broken.
 *
 * That is not hypothetical. Between 16.2.x and 16.3.1 the sibling
 * `getLayerAssets` hoisted its `src` to a local (`{src:r,async:!0,…}`), so it
 * stopped matching this shape at all: the per-bundle count went from 2 to 1.
 * A larger refactor could just as easily take it to 0.
 *
 * So: require the fingerprint to still match SOMETHING. Then "no unnonced site"
 * means "we looked and found none", not "we no longer know how to look".
 */
const ANY_COMPONENT_SCRIPT_SITE =
    /\{src:`\$\{\w+\.assetPrefix\}[^`]*`,async:!0,key:`script-\$\{\w+\}`[,}]/g;

function findNextPatches(): string[] {
    const dir = path.join(ROOT, 'patches');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^next\+.+\.patch$/.test(f));
}

describe('CSP nonce — Next.js component-script patch', () => {
    it('a patches/next+*.patch is present in the tree', () => {
        // The patch is the deliverable. Without it, `npm install`
        // produces an unpatched node_modules and the R16 chart
        // CSP bug returns. Matched by glob rather than exact version
        // so a routine `next` bump + `patch-package next` regeneration
        // does not require editing this test.
        expect(findNextPatches()).toHaveLength(1);
    });

    it('package.json has the `postinstall: patch-package` script', () => {
        // patch-package is a no-op without the postinstall hook.
        // The hook auto-runs after `npm install` / `npm ci`, so
        // every developer + CI environment gets the patched bundle
        // automatically.
        const pkgJson = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
        );
        expect(pkgJson.scripts?.postinstall).toBe('patch-package');
        expect(pkgJson.devDependencies?.['patch-package']).toBeTruthy();
    });

    it('node_modules has the nonce fix in the unbundled source', () => {
        // Smoke test: on a clean install, `postinstall` runs
        // `patch-package`, which applies our patch, which adds the
        // `nonce: ctx.nonce` line. If this assertion fails, either
        // the patch didn't apply (postinstall didn't run) or the
        // patch drifted against a different next version.
        const srcPath = path.join(
            ROOT,
            'node_modules/next/dist/server/app-render/create-component-styles-and-scripts.js',
        );
        const src = fs.readFileSync(srcPath, 'utf8');
        expect(src).toMatch(/nonce:\s*ctx\.nonce/);
    });

    it('the Dockerfile copies patches/ before npm ci, with scripts enabled', () => {
        // Without this, `postinstall`'s patch-package finds nothing and the
        // built image ships an UNPATCHED next — while every other assertion
        // in this file still passes, because they read the LOCAL
        // node_modules where patches/ IS present at install time.
        //
        // NOTE this is a PROXY: it asserts the build inputs, not the built
        // artifact. The non-proxy check is the "Gate: image applied the
        // CSP-nonce patch" step in ci.yml (asserted below), which runs
        // scripts/verify-image-patches.mjs inside the image itself.
        const dockerfile = fs.readFileSync(
            path.join(ROOT, 'Dockerfile'),
            'utf8',
        );
        const lines = dockerfile.split('\n');

        const copyPatchesAt = lines.findIndex((l) =>
            /^\s*COPY\s+(--\S+\s+)*patches[\s/]/.test(l),
        );
        const npmCiAt = lines.findIndex((l) => /^\s*RUN\s+npm ci\b/.test(l));

        expect(copyPatchesAt).toBeGreaterThan(-1);
        expect(npmCiAt).toBeGreaterThan(-1);
        // Order is the whole point: a COPY after the install is a no-op.
        expect(copyPatchesAt).toBeLessThan(npmCiAt);

        // `--ignore-scripts` skips postinstall entirely, so patches/ being
        // present in the right layer would stop meaning anything. The
        // ordering assertion above cannot see that flag.
        expect(lines[npmCiAt]).not.toMatch(/--ignore-scripts/);
    });

    it('CI verifies the BUILT IMAGE applied the patch', () => {
        // The load-bearing one. Every other assertion in this file reads
        // the repo or the local node_modules; this asserts that the
        // pipeline runs a check against the artifact it ships. Removing
        // that step is how the 2026-05-14 → 2026-07-25 outage stayed
        // invisible for ten weeks.
        const verifier = path.join(ROOT, 'scripts/verify-image-patches.mjs');
        expect(fs.existsSync(verifier)).toBe(true);

        const ci = fs.readFileSync(
            path.join(ROOT, '.github/workflows/ci.yml'),
            'utf8',
        );
        expect(ci).toContain('scripts/verify-image-patches.mjs');

        // It has to run against a locally-loaded image, and before the
        // Trivy scan so a delivery bug fails fast.
        const loadAt = ci.indexOf('load: true');
        const verifyAt = ci.indexOf('scripts/verify-image-patches.mjs');
        expect(loadAt).toBeGreaterThan(-1);
        expect(loadAt).toBeLessThan(verifyAt);
    });

    it('the patch covers all four bundled prod runtimes (the #929 lock)', () => {
        // #929 regenerated the patch against a pristine download and
        // silently lost these four hunks, leaving the runtime bundle
        // unpatched for ~7 weeks. Assert the patch's file coverage
        // directly: a regenerated patch that omits a bundle fails here,
        // in the same PR that regenerates it.
        const [patchFile] = findNextPatches();
        const patch = fs.readFileSync(
            path.join(ROOT, 'patches', patchFile),
            'utf8',
        );

        for (const runtime of PROD_RUNTIMES) {
            expect(patch).toContain(
                `dist/compiled/next-server/${runtime}`,
            );
        }
        // Both unbundled sources too, so coverage is fully pinned.
        expect(patch).toContain(
            'dist/server/app-render/create-component-styles-and-scripts.js',
        );
        expect(patch).toContain(
            'dist/esm/server/app-render/create-component-styles-and-scripts.js',
        );
    });

    it.each(PROD_RUNTIMES)(
        'no unnonced component script survives in %s',
        (runtime) => {
            // The prod runtime bundle is what actually runs in
            // `npx next start`. The unbundled source above is for
            // upstream-PR readability; this assertion is the one
            // that proves the fix is live at runtime.
            //
            // Asserts ABSENCE, not presence. The old version required one
            // `nonce:` match anywhere in the file, which the sibling
            // `getLayerAssets` element — nonced upstream, never broken —
            // satisfied on its own. So it passed while the vulnerable
            // function was unpatched. Var names are minifier-assigned and
            // change between releases, so match the structural fingerprint,
            // not the letters.
            const bundle = fs.readFileSync(
                path.join(
                    ROOT,
                    'node_modules/next/dist/compiled/next-server',
                    runtime,
                ),
                'utf8',
            );

            // Assert on the extracted match, NOT the bundle: a bare
            // `expect(bundle).not.toMatch(...)` dumps a 5 MB minified string
            // into the CI log on failure. This prints just the offending
            // element, which is also the snippet you need to write the fix.
            const offendingSite = UNNONCED_SCRIPT_SITE.exec(bundle)?.[0] ?? null;
            expect(offendingSite).toBeNull();
        },
    );

    it.each(PROD_RUNTIMES)(
        'the component-script fingerprint still matches something in %s',
        (runtime) => {
            // The positive control for the assertion above. Without it, that
            // check passes both when there is no unnonced site AND when the
            // regex has stopped matching anything at all — and the second case
            // arrives exactly when a Next release restructures the bundle,
            // i.e. the release where the patch most likely broke.
            //
            // Real drift, not a hypothetical: 16.2.x had TWO matching sites per
            // bundle (createComponentStylesAndScripts + getLayerAssets); in
            // 16.3.1 getLayerAssets hoists its src to a local, so only one
            // matches. Hence >= 1 rather than a pinned count — the point is
            // "the shape still exists", not "there are exactly N of them".
            const bundle = fs.readFileSync(
                path.join(
                    ROOT,
                    'node_modules/next/dist/compiled/next-server',
                    runtime,
                ),
                'utf8',
            );

            const sites = bundle.match(ANY_COMPONENT_SCRIPT_SITE) ?? [];
            if (sites.length === 0) {
                throw new Error(
                    `${runtime}: the component-script fingerprint matched NOTHING.\n\n` +
                        `This does not mean the bundle is safe — it means this guard can no ` +
                        `longer see the thing it is guarding, so "no unnonced site" is ` +
                        `vacuous. Next has almost certainly restructured its minified output.\n\n` +
                        `Re-derive the fingerprint: find the createElement('script', …) built ` +
                        `from ctx.assetPrefix in ` +
                        `node_modules/next/dist/compiled/next-server/${runtime}, confirm whether ` +
                        `it carries a nonce, and update UNNONCED_SCRIPT_SITE + ` +
                        `ANY_COMPONENT_SCRIPT_SITE here AND the copies in ` +
                        `scripts/verify-image-patches.mjs.`,
                );
            }
            expect(sites.length).toBeGreaterThanOrEqual(1);
        },
    );
});
