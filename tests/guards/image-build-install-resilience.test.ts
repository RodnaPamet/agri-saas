/**
 * An image build must not die because one optional native download failed.
 *
 * ## The defect
 *
 * `Dockerfile:25` was a bare `RUN npm ci`, and `onnxruntime-node` was a
 * PRODUCTION dependency whose postinstall downloads a platform binary from the
 * network. So every image build depended on an external host answering first
 * time, with no retry — while `ci.yml` wraps its own installs in 3-attempt
 * loops and even carries a comment about an `npm ci` that stalled ~8 minutes
 * and ate a job budget.
 *
 * Measured 2026-10-01: `Docker Build & Scan` went red on `119366da3` with
 * `AggregateError [ETIMEDOUT] … connect ETIMEDOUT 150.171.109.73:443` inside
 * `npm error path /app/node_modules/onnxruntime-node`. That commit's entire
 * diff was one `scripts` entry in `package.json`.
 *
 * ## Why OPTIONAL rather than a retry loop
 *
 * A retry makes a flaky download slower to fail, not less fatal. Measured
 * instead: the module is loaded only from `onnx-provider.ts`, only through a
 * DYNAMIC `import()`, and `getSession()` throws on a missing
 * `VISION_MODEL_PATH` before either import site runs. Production sets neither
 * `VISION_MODEL_PATH` nor `VISION_BACKEND` — zero entries in
 * `deploy/env.prod.example`, zero on the live VM — so the native binary is
 * downloaded at build time, shipped into the runtime image, and never loaded.
 *
 * `optionalDependencies` says exactly that: still installed, still shipped
 * when the download works, no longer able to fail the build when it does not.
 * It removes the failure mode rather than reducing its probability, and it
 * takes no capability away — which matters because the vision work is
 * groundwork for a roadmap item rather than dead code.
 *
 * ## What this guard is for
 *
 * The Dockerfile is the one file with no CI job reading its text, which is
 * precisely why the workflow's retries survived and it never got any. A future
 * "tidy the dependency list" change would move this back without anything
 * noticing. So the property is asserted, not trusted.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};
/**
 * The floors are SHARED with `scripts/check-optional-closure.mjs`, which runs
 * before `npm ci` and is the only one of the two that can fire when the flags
 * are actually missing (this suite never runs — the install dies first). Two
 * copies of a ratchet drift, so both read the same file.
 */
const FLOORS = JSON.parse(read('scripts/optional-closure-floors.json')) as {
    optionalEntries: number;
};

const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<
        string,
        {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
            libc?: unknown;
            optional?: boolean;
        }
    >;
};

/** Packages whose install reaches the NETWORK for a platform binary. */
const NETWORK_POSTINSTALL = ['onnxruntime-node'];

describe('image build survives a failed optional native download', () => {
    it('control: the manifests parsed and carry a real population', () => {
        // The assertions below are about absence from one map and presence in
        // another; an unparsed or empty manifest satisfies several of them.
        expect(Object.keys(pkg.dependencies ?? {}).length).toBeGreaterThan(50);
        expect(Object.keys(pkg.devDependencies ?? {}).length).toBeGreaterThan(20);
        expect(Object.keys(lock.packages).length).toBeGreaterThan(500);
    });

    it.each(NETWORK_POSTINSTALL)(
        '%s is OPTIONAL, so a failed download cannot fail the build',
        (name) => {
            expect(pkg.optionalDependencies?.[name]).toBeDefined();
            // Not in BOTH — npm resolves a duplicate unpredictably and the
            // required edge would win.
            expect(pkg.dependencies?.[name]).toBeUndefined();
        },
    );

    it('the lockfile root agrees with package.json', () => {
        // An out-of-sync lock does not fail quietly: `npm ci` refuses. This
        // catches a package.json edit landed without the lock.
        const root = lock.packages[''];
        for (const name of NETWORK_POSTINSTALL) {
            expect(root.optionalDependencies?.[name]).toBeDefined();
            expect(root.dependencies?.[name]).toBeUndefined();
        }
    });

    it('the lockfile ENTRY is flagged optional, not just the root declaration', () => {
        // THE DEFECT THIS GUARD MISSED THE FIRST TIME.
        //
        // The assertions above check `package.json` and the lockfile ROOT. npm
        // reads neither at install time to decide a failure is tolerable — it
        // reads `"optional": true` on the PACKAGE ENTRY. My first fix moved the
        // root declaration (hand-patched, because
        // `npm install --package-lock-only` strips all 26 `libc` entries) and
        // never set the entry flag, so `npm ci` still treated the package as
        // required and the postinstall download was still fatal.
        //
        // It blocked a production deploy: `ghcr-publish` failed on main's tip
        // with the identical ETIMEDOUT signature AFTER the "fix" had merged,
        // leaving three merged PRs unpublished. Declaring a property is not
        // delivering it, and this guard proved the declaration.
        for (const name of NETWORK_POSTINSTALL) {
            const entry = lock.packages[`node_modules/${name}`] as { optional?: boolean } | undefined;
            expect(entry).toBeDefined();
            expect(entry!.optional).toBe(true);
        }
    });

    it('the optional CLOSURE is flagged, not only the named package', () => {
        // npm marks the whole subtree reachable only through an optional edge,
        // and it needs all of it: a dependency of an optional package left
        // unflagged is itself required, so its install failure is fatal and the
        // tolerance is defeated one level down. Measured here — the eight
        // entries the first hand-patch missed were `onnxruntime-node` plus its
        // closure (`onnxruntime-common`, `adm-zip`, `global-agent`, `matcher`,
        // `escape-string-regexp`, `serialize-error`, `type-fest`).
        //
        // A FLOOR rather than an exact set: the closure is npm's to compute and
        // a legitimate dependency change moves it. What a floor catches is the
        // case that actually happened — a hand-patch that touched the root and
        // left the entries alone, which drops this count by eight.
        const optionalEntries = Object.values(lock.packages).filter(
            (e) => e && typeof e === 'object' && (e as { optional?: boolean }).optional === true,
        );
        expect(optionalEntries.length).toBeGreaterThanOrEqual(FLOORS.optionalEntries);
    });

    it('the lockfile still carries its platform (`libc`) entries', () => {
        // `npm install --package-lock-only` STRIPS every one of these —
        // measured twice, 26 -> 0 — so a regenerated lock silently drops the
        // musl/glibc discrimination this Alpine image depends on. The fix for
        // this very defect had to be hand-patched for that reason.
        const withLibc = Object.values(lock.packages).filter(
            (p) => p && typeof p === 'object' && 'libc' in p,
        );
        expect(withLibc.length).toBeGreaterThanOrEqual(26);
    });

    it('the ONLY loader of a network-postinstall module is dynamic and guarded', () => {
        // A STATIC import would pull the native addon into the module graph at
        // build time, which is what makes the optional classification safe to
        // begin with.
        //
        // #1392 CHANGED THE MECHANISM, so this test changed with it. It used to
        // REQUIRE `import type { … } from 'onnxruntime-node'`, on the reasoning
        // that `import type` is erased while a value import is not. True, and
        // beside the point: a type-only import still needs the package ON DISK
        // at compile time, so it made `Typecheck` fail at random whenever npm
        // skipped the optional install. The property worth asserting was never
        // "an `import type` exists" — it was "nothing forces the compiler to
        // resolve this package", and the old assertion pinned a means as if it
        // were the end. Improving the means broke it.
        const raw = read('src/app-layer/ai/vision/onnx-provider.ts');
        // Comments blanked, because the provider's docblock now QUOTES all
        // three banned forms to explain them. The previous version of the
        // dynamic-import count read raw source and would have scored that
        // prose as a call — the same mistake its own comment records making
        // once already, in the other direction (`typeof` in type position).
        const provider = blankNonCode(raw);

        // No compile-time reference in ANY of the three forms that resolve.
        expect(provider).not.toMatch(/import\s+type\s[^;]*from\s*'onnxruntime-node'/);
        expect(provider).not.toMatch(/typeof\s+import\('onnxruntime-node'\)/);
        expect(provider).not.toMatch(/import\('onnxruntime-node'\)/);
        expect(provider).not.toMatch(/^import\s[^;]*from\s*'onnxruntime-node'/m);

        // EXACTLY ONE dynamic load, through the `string`-typed id. This counts
        // the CALL rather than looking for the helper's name: a mutation that
        // reverted both call sites to a bare `import()` and left the now-unused
        // helper in place SURVIVED a `toContain` assertion, because the token
        // was still in the file. The property is "every load goes through the
        // guarded path", not "the word appears".
        const dynamicImports = provider.match(/import\(ONNX_MODULE_ID\)/g) ?? [];
        expect(dynamicImports).toHaveLength(1);
        const calls = provider.match(/loadOnnxRuntime\(\)/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(2); // both load sites

        // The id must stay a BINDING — that indirection is what stops the
        // compiler resolving the module. Measured with the package removed:
        // an inline `import('onnxruntime-node')` gives 3 × TS2307, while both
        // `const ID = '…'` and `const ID: string = '…'` give 0. So the
        // assertion above (no literal specifier anywhere) is the one carrying
        // the property; this one pins the declaration's SHAPE so the intent
        // survives a tidy-up that inlines it.
        //
        // The `: string` annotation is deliberately part of that shape even
        // though it is not load-bearing today: it makes the specifier
        // non-literal by type as well as by position, so the property does not
        // rest on TypeScript continuing to decline to follow a const-narrowed
        // literal. Asserted rather than assumed, because the first draft of
        // this comment claimed the annotation WAS the mechanism and the
        // measurement said otherwise.
        expect(provider).toMatch(/const ONNX_MODULE_ID:\s*string\s*=\s*'onnxruntime-node'/);

        // The failure names the cause rather than surfacing MODULE_NOT_FOUND.
        expect(raw).toMatch(/not installed/);
    });

    it('no source file outside the provider imports it at all', () => {
        // Derived, so a new consumer is caught the moment it exists — a second
        // importer could reintroduce a static edge and nothing else here would
        // notice.
        //
        // `collectSourceFiles` rather than a hand-rolled walk: it REFUSES an
        // empty result, which is the hazard this assertion has. Measured on
        // the first draft of this file — narrowing the walk root to one small
        // directory left the test green, because `expect([]).toEqual([])` is
        // satisfied by a scan that visited nothing. `floor` is the population
        // control, and `file-collection-is-not-silently-empty` is the guard
        // that rejected the hand-rolled version.
        const files = collectSourceFiles({
            roots: ['src'],
            extensions: ['.ts', '.tsx'],
            exclude: (rel) => rel.endsWith('src/app-layer/ai/vision/onnx-provider.ts'),
            floor: 1000,
        });

        const offenders = files.filter((full) =>
            /from 'onnxruntime-node'|import\('onnxruntime-node'\)/.test(
                fs.readFileSync(full, 'utf8'),
            ),
        );
        expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    });
});
