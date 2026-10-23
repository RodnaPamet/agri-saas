/**
 * The node-forge exemption's REACHABILITY argument, machine-checked.
 *
 * `scripts/audit-exemptions.mjs` exempts `GHSA-86w9-cpqp-85rv` — node-forge's
 * RSA PKCS#1 v1.5 signature VERIFICATION accepting extra nested
 * `DigestAlgorithm` elements. Its range is `*` with `fixAvailable: false`, so no
 * floor fixes it and no override exists; and removal is unavailable because the
 * only path to it is live code:
 *
 *   @google/earthengine → googleapis → google-auth-library → gtoken
 *                       → google-p12-pem → node-forge
 *
 * The exemption therefore rests on an argument rather than on a version: that
 * `google-p12-pem` calls exactly four forge functions — `asn1.fromDer`,
 * `pkcs12.pkcs12FromAsn1`, `pki.privateKeyToPem`, `util.decode64` — all of which
 * parse OUR OWN service-account P12 and export its private key, none of which is
 * signature verification; and that the JWT is signed by `jws.sign()`, not by
 * forge. So the vulnerable predicate is never asked to judge anybody's
 * signature.
 *
 * ## Why that argument needs a test and not just a review date
 *
 * It is prose about somebody else's compiled output. A `gtoken` or
 * `google-p12-pem` bump can add a fifth forge call — or swap `jws.sign` for
 * `forge.pki.rsa` — and **nothing fails**: the advisory is still exempt, the
 * audit gate is still green, and the written reason silently stops describing
 * the code. The `review: '2026-11-03'` date is a reminder to a human, which is
 * the right backstop and the wrong primary.
 *
 * Re-verified by hand 2026-10-24, ten days before that date, and all four
 * premises held exactly. This file is so that the next bump does not need
 * somebody to remember.
 *
 * ## It fails rather than skips when the tree is absent
 *
 * A guard over `node_modules` that quietly passes on a machine with no install
 * is the skipped-suite defect: greener by running less. If the packages are not
 * there this says so and fails, because "the premises hold" and "I could not
 * look" are the same observation otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const EXEMPTIONS = path.join(ROOT, 'scripts/audit-exemptions.mjs');
const GHSA = 'GHSA-86w9-cpqp-85rv';

const P12_PEM = 'node_modules/google-p12-pem/build/src/index.js';
const GTOKEN = 'node_modules/gtoken/build/src/index.js';

/** The four calls the written argument enumerates. */
const ALLOWED_FORGE_CALLS = [
    'forge.asn1.fromDer',
    'forge.pkcs12.pkcs12FromAsn1',
    'forge.pki.privateKeyToPem',
    'forge.util.decode64',
] as const;

const exemptionSource = fs.readFileSync(EXEMPTIONS, 'utf8');
const isExempted = new RegExp(`id:\\s*'${GHSA}'`).test(exemptionSource);

function readOrThrow(rel: string): string {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
        throw new Error(
            `${rel} is not installed, so this guard cannot check the node-forge `
            + `reachability argument. Run \`npm ci\`. Passing here would mean "the `
            + `premises hold" and "I could not look" report the same thing.`,
        );
    }
    return fs.readFileSync(p, 'utf8');
}

describe('node-forge exemption — status', () => {
    it('[forge-exemption] reports whether the exemption is still in force', () => {
        // Printed so the denominator is visible either way (#1879). If the
        // advisory ever gets a fix and the entry goes, the premise tests below
        // become moot and this line is how a reader sees that happened.
        console.log(
            `[forge-exemption] ${GHSA} exempted: ${isExempted}`
                + ` · premises ${isExempted ? 'CHECKED below' : 'moot'}`,
        );
        expect(typeof isExempted).toBe('boolean');
    });

    it('the exemption carries a reachability argument, not just a note', () => {
        if (!isExempted) return;
        // The entry's value is entirely in its reasoning. A future edit that
        // trimmed it to "not fixed yet" would leave the premise tests below
        // asserting something nothing claims.
        expect(exemptionSource).toContain('REACHABILITY');
        for (const call of ALLOWED_FORGE_CALLS) {
            // Named without the `forge.` prefix in the prose.
            expect(exemptionSource).toContain(call.replace('forge.', ''));
        }
    });
});

(isExempted ? describe : describe.skip)('node-forge exemption — premises', () => {
    it('google-p12-pem calls EXACTLY the four enumerated forge functions', () => {
        // The load-bearing one. A fifth call is a new reachability question,
        // and the whole exemption rests on the answer being "none of these
        // verifies a signature".
        const src = readOrThrow(P12_PEM);
        const calls = [...new Set(src.match(/forge\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+/g) ?? [])].sort();
        expect(calls).toEqual([...ALLOWED_FORGE_CALLS].sort());
    });

    it('none of them is a verification entry point', () => {
        // Stated separately from the enumeration, because the enumeration
        // could be updated without anyone re-asking the question that matters.
        const src = readOrThrow(P12_PEM);
        const calls = src.match(/forge\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+/g) ?? [];
        for (const call of calls) {
            expect(call).not.toMatch(/verif|validate|checkSignature/i);
        }
        // Not vacuous: there must BE calls for this to range over.
        expect(calls.length).toBeGreaterThanOrEqual(ALLOWED_FORGE_CALLS.length);
    });

    it('gtoken signs the JWT with jws, not with forge', () => {
        // The other half: forge never produces or judges the signature.
        const src = readOrThrow(GTOKEN);
        expect(src).toMatch(/require\(["']jws["']\)|from\s+["']jws["']/);
        expect(src).toMatch(/jws\.sign\(/);
        expect(src).not.toMatch(/forge\.pki\.rsa|forge\.md\.sha\d+|\.verify\(/);
    });

    it('the vulnerable package is reached only through the enumerated chain', () => {
        // If node-forge ever becomes a direct dependency, or arrives through a
        // second path, the argument covers one route and the tree has two.
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        expect(pkg.dependencies?.['node-forge']).toBeUndefined();
        expect(pkg.devDependencies?.['node-forge']).toBeUndefined();
        // And the chain's head is the live code the reason names.
        expect(pkg.dependencies?.['@google/earthengine']).toBeTruthy();
    });

    it('the earthengine code the reason calls live is still present', () => {
        // "Removal is unavailable because earthengine is live code" is a
        // premise too: if those modules went, the honest move is to drop the
        // dependency rather than keep exempting its transitive advisory.
        for (const rel of [
            'src/lib/agro/earth-engine.ts',
            'src/lib/agro/gee-config.ts',
            'src/lib/agro/index-recipes.ts',
        ]) {
            expect({ rel, exists: fs.existsSync(path.join(ROOT, rel)) }).toEqual({
                rel,
                exists: true,
            });
        }
    });
});
