import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Which basemap branch did THIS build actually take? (#781)
 *
 * ## Why this exists, and why the obvious checks do not work
 *
 * `resolveBasemapStyle` (`@/lib/geo/basemap-style`) renders MapTiler only if
 * `NEXT_PUBLIC_MAPTILER_KEY` was present at `next build`. That key reaches the
 * published image through exactly one line —
 * `.github/workflows/ghcr-publish.yml`'s `build-args` — from a repo variable.
 * Clear the variable, build from a fork, or drop that line, and the app falls
 * back to the demotiles CDN **silently**: a working map, quietly served by a
 * third party, with no error and no alert. Nothing asserted which branch
 * shipped. That is #781.
 *
 * Three checks look like they answer it and cannot. All three were tried:
 *
 *  1. **Read the workflow.** `deploy.yml` deploys; `ghcr-publish.yml` builds.
 *     And `Dockerfile`'s `ARG NEXT_PUBLIC_MAPTILER_KEY=""` is the default when
 *     nothing supplies one, not the effective value.
 *  2. **Check the bundle READS the var.** It reads it on BOTH branches — the
 *     decision site is `let e = <proxy>.NEXT_PUBLIC_MAPTILER_KEY`, byte-identical
 *     either way.
 *  3. **Count URL literals.** `demotiles.maplibre.org` and `api.maptiler.com`
 *     are both in the source unconditionally, because both are in the resolver.
 *
 * Only the **inlined value** in the `runtimeEnv` object literal settles it. And
 * a bare `grep NEXT_PUBLIC_MAPTILER_KEY` cannot find it, because the zod SCHEMA
 * site sits ~200 bytes away in the same file and is spelled differently per
 * chunk after minification (`n.string().optional()`, `rw().optional()`, …).
 * That is the same bystander shape as the CSP-nonce `getLayerAssets` trap
 * CLAUDE.md describes. So this module ALLOWLISTS the value shapes rather than
 * blocklisting bystanders — a bystander enumeration is already known wrong.
 *
 * ## The three inlined shapes, measured
 *
 * Next inlines a `NEXT_PUBLIC_*` variable only when its build-time value is
 * non-null, and emits it through `JSON.stringify`, so:
 *
 * (Spelled without the `process.<env>.` prefix on purpose —
 * `tests/unit/no-fallbacks.test.ts` bans that literal anywhere under `src/`,
 * comments included, and it is right to: the ban is what keeps env access
 * funnelled through `@/env`. This module reads no environment at all.)
 *
 * | build env            | emitted text                                  | branch    |
 * |----------------------|-----------------------------------------------|-----------|
 * | key set              | `NEXT_PUBLIC_MAPTILER_KEY:"<literal>"`        | maptiler  |
 * | key `""`             | `NEXT_PUBLIC_MAPTILER_KEY:""`                 | demotiles |
 * | var absent from build| `NEXT_PUBLIC_MAPTILER_KEY:<id>.env.NEXT_…`    | demotiles |
 *
 * The last two are classified identically on purpose: the verdict is the same
 * and it removes a dependency on which one a keyless build happens to produce.
 *
 * ## Failing BLIND rather than confidently wrong
 *
 * A fingerprint over minified output is fragile by nature. So the scan carries
 * POSITIVE CONTROLS and reports `blind` when they are missing, never a
 * confident answer:
 *
 *  - no chunk directory            → `blind:no_chunks`
 *  - no binding site found at all  → `blind:no_binding`  (the fingerprint moved)
 *  - neither branch URL literal present → `blind:no_branch_literals`
 *    (the resolver was restructured, so classification is meaningless)
 *
 * Without those controls this check would fail OPEN on exactly the release
 * where it most needed to work. **Never "fix" a `blind` result by relaxing the
 * expectation** — a blind result means the fingerprint no longer describes the
 * build, and relaxing it converts a known-unknown into a false negative.
 *
 * The key VALUE is never returned, logged, or included in any error. The result
 * is a closed enum plus counts.
 */

/** Which basemap the built bundle will resolve at runtime. */
export type BasemapBranch = 'maptiler' | 'demotiles' | 'blind';

export interface BasemapScanResult {
    branch: BasemapBranch;
    /** Present only when `branch === 'blind'`; a closed enum, never a path. */
    blindReason?: 'no_chunks' | 'no_binding' | 'no_branch_literals';
    /** How many chunk files carried a binding site. Diagnostic only. */
    bindingSites: number;
    /** Positive controls: did we see each resolver branch's URL at all? */
    sawDemotilesLiteral: boolean;
    sawMaptilerLiteral: boolean;
}

/**
 * A KEY inlined with a non-empty value: `NEXT_PUBLIC_MAPTILER_KEY:"…"` with at
 * least one character between the quotes. The quotes are load-bearing — drop
 * them and the zod bystander (`NEXT_PUBLIC_MAPTILER_KEY:n.string()…`) matches,
 * which is precisely the trap this module exists to avoid.
 */
const INLINED_NON_EMPTY = /NEXT_PUBLIC_MAPTILER_KEY:"[^"]+"/;

/** The key inlined as an EMPTY string — a keyless build that still defined it. */
const INLINED_EMPTY = /NEXT_PUBLIC_MAPTILER_KEY:""/;

/**
 * The key NOT inlined: the object falls through to a `…env.NEXT_PUBLIC_MAPTILER_KEY`
 * property read. Measured alongside the other shapes in the same live object
 * (`NEXT_PUBLIC_VAPID_PUBLIC_KEY:nf.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY`).
 */
const NOT_INLINED = /NEXT_PUBLIC_MAPTILER_KEY:[A-Za-z_$][\w$]*\.env\.NEXT_PUBLIC_MAPTILER_KEY/;

/** Positive controls — the two branch URLs the resolver can produce. */
const DEMOTILES_LITERAL = 'demotiles.maplibre.org';
const MAPTILER_LITERAL = 'api.maptiler.com';

async function collectJsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await collectJsFiles(p)));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/**
 * Scan a Next chunk directory and classify which basemap branch it will take.
 *
 * Pure over the filesystem and side-effect free, so it is unit-testable against
 * fixture directories written from real bundle bytes — which is the only way to
 * prove the bystander does not fool it.
 */
export async function scanChunkDir(dir: string): Promise<BasemapScanResult> {
    const files = await collectJsFiles(dir);
    if (files.length === 0) {
        return {
            branch: 'blind',
            blindReason: 'no_chunks',
            bindingSites: 0,
            sawDemotilesLiteral: false,
            sawMaptilerLiteral: false,
        };
    }

    let bindingSites = 0;
    let sawNonEmpty = false;
    let sawKeyless = false;
    let sawDemotilesLiteral = false;
    let sawMaptilerLiteral = false;

    for (const f of files) {
        let text: string;
        try {
            text = await readFile(f, 'utf8');
        } catch {
            continue;
        }
        if (text.includes(DEMOTILES_LITERAL)) sawDemotilesLiteral = true;
        if (text.includes(MAPTILER_LITERAL)) sawMaptilerLiteral = true;

        // Order matters: INLINED_NON_EMPTY must be tested before INLINED_EMPTY,
        // since `""` would also satisfy a laxer non-empty pattern.
        if (INLINED_NON_EMPTY.test(text)) {
            bindingSites += 1;
            sawNonEmpty = true;
        } else if (INLINED_EMPTY.test(text) || NOT_INLINED.test(text)) {
            bindingSites += 1;
            sawKeyless = true;
        }
    }

    // The fingerprint found nothing at all — it no longer describes this build.
    if (bindingSites === 0) {
        return {
            branch: 'blind',
            blindReason: 'no_binding',
            bindingSites,
            sawDemotilesLiteral,
            sawMaptilerLiteral,
        };
    }

    // Neither branch URL is present, so the resolver was restructured and a
    // verdict about "which branch" is meaningless even if a binding was found.
    if (!sawDemotilesLiteral && !sawMaptilerLiteral) {
        return {
            branch: 'blind',
            blindReason: 'no_branch_literals',
            bindingSites,
            sawDemotilesLiteral,
            sawMaptilerLiteral,
        };
    }

    // A non-empty key anywhere wins: that is the value the resolver reads.
    const branch: BasemapBranch = sawNonEmpty ? 'maptiler' : sawKeyless ? 'demotiles' : 'blind';
    return { branch, bindingSites, sawDemotilesLiteral, sawMaptilerLiteral };
}

/**
 * The chunk directory of the running build. `Dockerfile` copies the whole
 * `.next` into the runner (non-standalone), and the server's cwd is `/app`, so
 * this resolves in the image and in `next start` locally alike. Named as a
 * relative path rather than an absolute one so a future `output: 'standalone'`
 * relocation surfaces as `blind:no_chunks` — honest — rather than as a wrong
 * answer.
 */
const CHUNK_DIR = '.next/static/chunks';

let memo: Promise<BasemapScanResult> | null = null;

/**
 * Memoized entry point for `/api/readyz`.
 *
 * The scan reads ~560 files (~10 MB) and takes ~90 ms, which is fine once and
 * not fine on every uptime poll — so the PROMISE is cached, not the value, so
 * concurrent first probes share one scan rather than racing three.
 *
 * Never throws: an unreadable directory returns `blind`, and this capability
 * sits outside `checks`/`failed` precisely so it can never 503 the probe.
 */
export function basemapBranchStatus(): Promise<BasemapScanResult> {
    memo ??= scanChunkDir(CHUNK_DIR).catch(() => ({
        branch: 'blind' as const,
        blindReason: 'no_chunks' as const,
        bindingSites: 0,
        sawDemotilesLiteral: false,
        sawMaptilerLiteral: false,
    }));
    return memo;
}

/** Test-only: drop the memo so a suite can scan more than one fixture tree. */
export function __resetBasemapBranchMemo(): void {
    memo = null;
}
