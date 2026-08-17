/**
 * Verify that the BUILT IMAGE actually applied patch-package.
 *
 * Runs INSIDE the container (see the "Gate: image applied the CSP-nonce
 * patch" step in .github/workflows/ci.yml), against the same
 * `load: true` image the Trivy scan uses — so it costs no extra build.
 *
 * Why this exists, and why it reads the image rather than the repo:
 *
 * From 2026-05-14 to 2026-07-25 every deployed container served an
 * unnonced <script> that `script-src 'nonce-…' 'strict-dynamic'` blocks.
 * The patch file was in the repo the whole time and CI was green,
 * because the Dockerfile's deps stage copied only package.json +
 * package-lock.json before `npm ci` — `patch-package` resolves
 * `patches/` relative to CWD, found nothing, logged "No patch files
 * found", and produced an unpatched node_modules that the builder
 * inherited and the runner shipped.
 *
 * Every signal we had described the developer's machine: the guard tests
 * read the LOCAL node_modules, where `npm ci` DOES see patches/ and the
 * patch DOES apply. Locally patched, in-image unpatched — a green CI and
 * a broken production, with no contradiction between them.
 *
 * A test that inspects the build definition (does the Dockerfile COPY
 * patches before npm ci?) is a proxy: it encodes "these inputs usually
 * produce a good artifact." This script is not a proxy. It reads the
 * artifact.
 *
 * Fails CLOSED: a missing bundle is a failure, not a skip. "The file
 * I was going to check isn't there" is how this class of bug hides.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const NEXT_SERVER = '/app/node_modules/next/dist/compiled/next-server';
const UNBUNDLED =
    '/app/node_modules/next/dist/server/app-render/create-component-styles-and-scripts.js';

/** The four bundled prod runtimes — these are what `next start` executes. */
const PROD_RUNTIMES = [
    'app-page.runtime.prod.js',
    'app-page-turbo.runtime.prod.js',
    'app-page-experimental.runtime.prod.js',
    'app-page-turbo-experimental.runtime.prod.js',
];

/**
 * A minified component-script element with NO nonce: the object literal
 * closes (`}`) immediately after the `script-${index}` key. Anchored on the
 * `${ctx.assetPrefix}` src interpolation so it cannot match unrelated
 * elements. A nonced site has `,nonce:<ctx>.nonce` before the brace.
 *
 * Deliberately asserts the ABSENCE of the bad pattern rather than the
 * presence of a good one: the sibling `getLayerAssets` element is nonced
 * upstream and has always been, so a presence check is satisfied by a
 * bystander and passes whether or not the vulnerable function is patched.
 * That is the exact weakness that let this ship.
 */
const UNNONCED_SCRIPT_SITE =
    /\{src:`\$\{\w+\.assetPrefix\}[^`]*`,async:!0,key:`script-\$\{\w+\}`\}/;

/**
 * POSITIVE CONTROL — same fingerprint, indifferent to a trailing nonce.
 *
 * The absence check above also passes when it matches NOTHING. If Next
 * restructures its minified output, the regex stops describing reality and an
 * entirely unpatched image ships green — the check fails OPEN in exactly the
 * release where the patch is most likely to have broken.
 *
 * Observed for real between 16.2.x and 16.3.1: the sibling `getLayerAssets`
 * hoisted its `src` to a local, so the per-bundle match count went 2 → 1. A
 * larger refactor could take it to 0.
 *
 * Requiring a match keeps "no unnonced site" meaning "we looked and found
 * none" rather than "we no longer know how to look".
 */
const ANY_COMPONENT_SCRIPT_SITE =
    /\{src:`\$\{\w+\.assetPrefix\}[^`]*`,async:!0,key:`script-\$\{\w+\}`[,}]/g;

const failures = [];

// The unbundled source is the cheapest signal that postinstall ran at all.
if (!fs.existsSync(UNBUNDLED)) {
    failures.push(`missing: ${UNBUNDLED}`);
} else if (!/nonce:\s*ctx\.nonce/.test(fs.readFileSync(UNBUNDLED, 'utf8'))) {
    failures.push(
        `${path.basename(UNBUNDLED)}: no "nonce: ctx.nonce" — patch-package did not apply ` +
            `(check that the Dockerfile COPYs patches/ BEFORE npm ci)`,
    );
}

// The bundles are what actually executes.
for (const runtime of PROD_RUNTIMES) {
    const file = path.join(NEXT_SERVER, runtime);
    if (!fs.existsSync(file)) {
        failures.push(`missing: ${file}`);
        continue;
    }
    const contents = fs.readFileSync(file, 'utf8');
    const found = UNNONCED_SCRIPT_SITE.exec(contents);
    if (found) {
        // Print the match, not the 5 MB bundle.
        failures.push(`${runtime}: unnonced component script -> ${found[0]}`);
        continue;
    }

    // Positive control: absence only means something if we can still find the
    // shape at all. Zero matches = the fingerprint has drifted, not that the
    // bundle is clean.
    const sites = contents.match(ANY_COMPONENT_SCRIPT_SITE) ?? [];
    if (sites.length === 0) {
        failures.push(
            `${runtime}: component-script fingerprint matched NOTHING — this check has gone ` +
                `blind (Next likely restructured its minified output). Re-derive the regex ` +
                `here AND in tests/guards/csp-nonce-component-scripts-patch.test.ts.`,
        );
        continue;
    }

    console.log(`ok   ${runtime}  (${sites.length} component-script site(s), all nonced)`);
}

if (failures.length > 0) {
    console.error('\nFAIL: the built image did not apply the CSP-nonce patch.\n');
    for (const f of failures) console.error(`  • ${f}`);
    console.error(
        '\nThis image would serve <script> tags with no nonce, which the ' +
            "production CSP (script-src 'nonce-…' 'strict-dynamic') blocks.\n" +
            'See docs/implementation-notes/2026-07-25-csp-nonce-prod-runtime-regression.md\n',
    );
    process.exit(1);
}

console.log('\nPASS: image applied the CSP-nonce patch to all four prod runtimes.');
