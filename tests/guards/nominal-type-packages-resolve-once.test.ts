/**
 * A package whose types are NOMINAL may resolve to only ONE version — #2776.
 *
 * ## The mechanism, which is not about versions drifting
 *
 * `Client` in `@smithy/core/client` is not an interface. It is a
 * `declare class` carrying `private handlers?`, and **a class type with a
 * private member is nominal in TypeScript**: assignability requires the same
 * DECLARATION SITE, not the same shape. Two copies of a byte-identical
 * declaration are two different types.
 *
 * `s3-provider.ts` hands an `S3Client` to `getSignedUrl`, and the two sides
 * reach that class through the same specifier from different packages:
 *
 *     S3Client.d.ts     import { Client as __Client } from "@smithy/core/client"
 *     getSignedUrl.d.ts import type { Client, Command } from "@smithy/core/client"
 *
 * So whether that call compiles depends on which copy each side resolves — and
 * not on the content of either AWS package. #2731's typecheck break was
 * exactly this, and it is why #2758's "a type change inside one of the two
 * packages" was measurably wrong: both packages' `dist-types` trees were
 * byte-identical across the two releases.
 *
 * ## Why a guard rather than only the override
 *
 * `package.json` carries `"@smithy/core": "~3.37.0"` in `overrides`, which
 * collapsed six installs at two versions into one. That is the fix, and it is
 * also one line that a future dependency bump has every reason to touch: an
 * AWS SDK needing `^3.40.0` will not resolve under a `~3.37.0` override, and
 * the obvious response is to widen the range rather than to re-pin it — which
 * re-splits the tree the moment two consumers want different minors.
 *
 * This guard turns that from an undiagnosed `tsc` error in a dependency PR
 * into a named failure with the remedy in the message. #2776 exists because
 * the same break was diagnosed twice and got the wrong answer once.
 *
 * ## It reads the LOCKFILE, not `node_modules`
 *
 * The lockfile is what CI installs from and what a dependency PR changes, so
 * it is the artefact the claim is about. `node_modules` would also make this
 * guard depend on an install having happened, and a guard that silently
 * passes on a missing tree is the shape this repo keeps finding.
 *
 * ## Same-version duplication is NOT what this forbids
 *
 * Measured and worth stating, because the over-strict version of this guard is
 * the tempting one: on `main` before the override, `client-s3` and
 * `s3-request-presigner` resolved `Client` from two physically different files
 * at the SAME version, and the typecheck was green with no cast. Three
 * declarations at one version do not break — TypeScript's nominal comparison
 * is per declaration, but identical versions give identical declarations and
 * the structural fallback applies. So this guard counts VERSIONS, never paths.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

/**
 * Packages whose exported types are nominal, so a version split breaks
 * assignability between two consumers that both import from them.
 *
 * Deliberately an ENUMERATION and deliberately short. The alternative — "every
 * package that exports a `declare class` with a private member" — would need
 * to parse every `.d.ts` in `node_modules`, which makes the guard depend on an
 * install and turns a 3-second check into a minutes-long one. An enumeration
 * is a claim that these are the ones that bite, and the entry below is the one
 * that has bitten (#2731, re-diagnosed on #2758 and #2776).
 *
 * Add an entry when a `tsc` error says "Argument of type 'X' is not assignable
 * to parameter of type 'Y'" for two types that look identical.
 */
const NOMINAL_TYPE_PACKAGES: ReadonlyArray<{ name: string; why: string }> = [
    {
        name: '@smithy/core',
        why:
            'exports `Client` as a `declare class` with `private handlers?`, which makes it '
            + 'nominal; `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` both import it '
            + 'and `s3-provider.ts` passes one to the other (#2731, #2776)',
    },
];

interface LockPackage {
    version?: string;
}

const lock = JSON.parse(
    readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'),
) as { packages: Record<string, LockPackage> };

/** Every resolved version of `name`, keyed by the lockfile path that holds it. */
function copiesOf(name: string): { path: string; version: string }[] {
    const suffix = `node_modules/${name}`;
    return Object.entries(lock.packages)
        .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
        .map(([key, value]) => ({ path: key, version: value.version ?? '(none)' }));
}

describe('a nominal-typed package resolves to ONE version', () => {
    it('reports what it graded', () => {
        const lines = NOMINAL_TYPE_PACKAGES.map((p) => {
            const copies = copiesOf(p.name);
            const versions = [...new Set(copies.map((c) => c.version))].sort();
            return `${p.name} copies=${copies.length} versions=${versions.join(',') || '(none)'}`;
        });
        console.log(`[nominal-type-dedupe] graded ${NOMINAL_TYPE_PACKAGES.length} package(s)`);
        for (const line of lines) console.log(`[nominal-type-dedupe]   ${line}`);

        // A guard that located NONE of them would pass every assertion below
        // over nothing — and a renamed or removed package is exactly how this
        // list goes quietly inert.
        expect(NOMINAL_TYPE_PACKAGES.length).toBeGreaterThan(0);
        for (const p of NOMINAL_TYPE_PACKAGES) {
            expect(copiesOf(p.name).length).toBeGreaterThan(0);
        }
    });

    for (const p of NOMINAL_TYPE_PACKAGES) {
        it(`${p.name} resolves to exactly one version`, () => {
            const copies = copiesOf(p.name);
            const versions = [...new Set(copies.map((c) => c.version))].sort();
            if (versions.length > 1) {
                throw new Error(
                    `${p.name} resolves to ${versions.length} versions (${versions.join(', ')}), `
                    + `across ${copies.length} install(s):\n`
                    + copies.map((c) => `  ${c.version}  ${c.path}`).join('\n')
                    + `\n\nThis package ${p.why}.\n\n`
                    + 'A version split makes those two declarations DIFFERENT TYPES, so a call '
                    + 'passing one to the other fails to typecheck with an error naming two types '
                    + 'that look identical. The remedy is an `overrides` entry in package.json '
                    + `pinning ${p.name} to a single range that satisfies every consumer — NOT a `
                    + 'cast at the call site, which would hide a real resolution problem.',
                );
            }
            expect(versions).toHaveLength(1);
        });
    }

    it('counts VERSIONS, not paths — same-version duplication is allowed', () => {
        // The control, and it is load-bearing rather than decorative. Before
        // the #2776 override there were SIX installs of `@smithy/core` and the
        // typecheck was green, because five of them were the same version.
        // A guard that failed on the install COUNT would have fired on a green
        // tree and been switched off.
        //
        // Asserted against a synthetic lockfile, because the real one now has
        // one install and cannot express the case.
        const synthetic: Record<string, LockPackage> = {
            'node_modules/@smithy/core': { version: '3.37.0' },
            'node_modules/@aws-sdk/client-s3/node_modules/@smithy/core': { version: '3.37.0' },
            'node_modules/@aws-sdk/s3-request-presigner/node_modules/@smithy/core': { version: '3.37.0' },
        };
        const versions = [...new Set(Object.values(synthetic).map((v) => v.version))];
        expect(Object.keys(synthetic)).toHaveLength(3);
        expect(versions).toHaveLength(1);
    });

    it('would CATCH the split #2731 hit — the mutation proof', () => {
        // The detector run against a lockfile shaped like the failure, since
        // the real tree is now deduped and a passing guard over a clean tree
        // proves only that it does not false-alarm.
        const split: Record<string, LockPackage> = {
            'node_modules/@aws-sdk/client-s3/node_modules/@smithy/core': { version: '3.37.0' },
            'node_modules/@aws-sdk/s3-request-presigner/node_modules/@smithy/core': { version: '3.39.0' },
        };
        const versions = [...new Set(Object.values(split).map((v) => v.version))].sort();
        expect(versions).toEqual(['3.37.0', '3.39.0']);
        expect(versions.length).toBeGreaterThan(1);
    });
});

describe('the override that makes it true is present', () => {
    it('pins every graded package in package.json overrides', () => {
        // The guard above reads the RESULT; this reads the CAUSE. Without it a
        // tree that happens to dedupe — because every consumer agrees today —
        // reads exactly like one that is pinned, and the first disagreement
        // re-splits it.
        const pkg = JSON.parse(
            readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
        ) as { overrides?: Record<string, unknown> };
        for (const p of NOMINAL_TYPE_PACKAGES) {
            expect(pkg.overrides ?? {}).toHaveProperty([p.name]);
        }
    });
});
