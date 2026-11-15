/**
 * A `'use client'` module may not REACH a server-only module — #3070.
 *
 * ## The defect, which cost a whole E2E shard
 *
 * `PublicLegalFooter` is an `async` server component calling `getTranslations`
 * from `next-intl/server`. #3070 rendered it from inside `login/page.tsx`,
 * which is `'use client'`. From a client module that import lands on the wrong
 * side of the boundary and React is handed a Promise to render as a child, so
 * the page rendered NOTHING — `#credentials-form` never appeared.
 *
 * What that looked like in CI is the part worth remembering: FOUR unrelated
 * specs failed (`module-gate-exchange`, `offline-field-sync`, `onboarding`,
 * `rbac-access`), each with all three attempts, each at exactly 1.0m, and the
 * shard then blew its 25-minute budget. Every one of them failed inside
 * `loginAndGetTenant`. A uniform duration across unrelated specs is the tell
 * for ONE systemic cause rather than four bugs — four separate defects do not
 * agree on a timeout to the tenth of a minute.
 *
 * ## This is the MIRROR of `i18n-use-client-directive`, not a duplicate
 *
 * That guard asserts a module calling the CLIENT hook (`useTranslations` from
 * `next-intl`) declares `'use client'`. This asserts the other direction: a
 * module that HAS the directive does not reach `next-intl/server`,
 * `next/headers` or `server-only`. Both failures 500 a page and neither
 * population contains the other's offenders — a client page importing a server
 * component calls no hook at all, which is exactly why nothing caught #3070.
 *
 * ## TRANSITIVE, because the boundary is not crossed only at the call site
 *
 * `DashboardClient → AgDashboardStrip → FieldBriefingCard → satellite-briefing`
 * is three hops. A one-hop check would read clean while the bundle still pulled
 * a server module.
 *
 * ## `import type` is ERASED, so it is not a reach
 *
 * That same chain is the live proof: `FieldBriefingCard` does
 * `import type { FieldBriefingPayload } from '@/app-layer/usecases/satellite-briefing'`,
 * and that usecase imports `getLocale` from `next-intl/server`. The type import
 * emits no require, so it is correct code — and a guard that flagged it would
 * have been switched off on its first run. The exclusion is asserted below
 * against that real chain rather than only against a synthetic case, so it
 * stays proved rather than assumed.
 *
 * ## The live population is CLEAN, which is why the proof is a crafted offender
 *
 * Zero offenders today (488 client modules of 2,485). A guard whose offender
 * set is empty cannot demonstrate teeth from the repo, so the detector is run
 * against synthetic one-hop and two-hop sources — the standing arrangement for
 * `channels-are-never-auto-joined`, whose allowlist is also empty.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const SRC = path.join(REPO_ROOT, 'src');

/**
 * Modules that only a SERVER tree may load. Each is server-only for its own
 * reason: `next-intl/server` and `next/headers` read request state that does
 * not exist in a browser, and `server-only` is the explicit marker package.
 */
const SERVER_ONLY_SPECIFIERS = ['next-intl/server', 'next/headers', 'server-only'] as const;

const SERVER_ONLY_IMPORT = new RegExp(
    String.raw`from\s*['"](?:${SERVER_ONLY_SPECIFIERS.map((s) => s.replace('/', '\\/')).join('|')})['"]`,
);

/**
 * Deliberately NOT anchored with `^`: three `'use server'` directives in this
 * repo sit inline rather than at the start of a line, and
 * `anchored-pattern-invents-an-absence` is the recorded cost of assuming
 * otherwise. `m` so a directive after a licence comment still matches.
 */
const USE_CLIENT = /(^|\n)\s*['"]use client['"]\s*;?/m;

/**
 * The three shapes that pull a module in at RUNTIME. `import type …` and
 * `export type …` are erased by the compiler and emit nothing, so both are
 * excluded by the negative lookahead.
 *
 * All three are needed, and the crafted-offender control below is what proved
 * it: the first draft matched only the `from`-shaped import, so a bare
 * side-effect `import './x'` — which has no `from` at all — and a re-export
 * `export { y } from './x'` were both invisible. A detector blind to two of
 * the three ways a module is loaded reads exactly like one that is clean.
 *
 * Dynamic `import()` is deliberately NOT here: `next/dynamic` is a sanctioned
 * pattern in this repo and a lazily-loaded chunk is a different question from
 * a statically-bundled one.
 */
const VALUE_IMPORT_FORMS: readonly RegExp[] = [
    // import x from 'spec' / import { x } from 'spec'
    /(?:^|\n)\s*import\s+(?!type\s)[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    // import 'spec' — side effect only, no bindings
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    // export { x } from 'spec' / export * from 'spec'
    /(?:^|\n)\s*export\s+(?!type\s)[^;'"]*?from\s*['"]([^'"]+)['"]/g,
];

/**
 * Blanked source, CACHED. 488 entry points walk overlapping graphs, so without
 * this the same module is read and blanked hundreds of times: 38s, against
 * 3.6s cached. `pages-are-reachable` learned the same lesson at 53s — a slow
 * guard is one somebody eventually moves out of the default population.
 */
const CODE_CACHE = new Map<string, string>();
function code(file: string): string {
    const hit = CODE_CACHE.get(file);
    if (hit !== undefined) return hit;
    const blanked = blankNonCode(fs.readFileSync(file, 'utf8'));
    CODE_CACHE.set(file, blanked);
    return blanked;
}

/** Resolved local value-imports per file, cached for the same reason. */
const IMPORTS_CACHE = new Map<string, string[]>();

/** Resolve a repo-local specifier to a file on disk, or null for a package. */
function resolveLocal(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return null;
    for (const candidate of [
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, 'index.ts'),
        path.join(base, 'index.tsx'),
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function localValueImports(file: string, src = code(file)): string[] {
    const hit = IMPORTS_CACHE.get(file);
    if (hit !== undefined) return hit;
    const out = new Set<string>();
    for (const form of VALUE_IMPORT_FORMS) {
        for (const m of src.matchAll(form)) {
            const resolved = resolveLocal(m[1], file);
            if (resolved) out.add(resolved);
        }
    }
    const resolved = [...out];
    IMPORTS_CACHE.set(file, resolved);
    return resolved;
}

/** The chain from a client module to the server-only module it reaches, or null. */
function reachesServerOnly(entry: string): string[] | null {
    const seen = new Set<string>([entry]);
    const queue: string[][] = localValueImports(entry).map((i) => [entry, i]);
    while (queue.length > 0) {
        const chain = queue.shift() as string[];
        const cur = chain[chain.length - 1];
        if (seen.has(cur)) continue;
        seen.add(cur);
        const src = code(cur);
        if (SERVER_ONLY_IMPORT.test(src)) return chain;
        for (const next of localValueImports(cur, src)) {
            if (!seen.has(next)) queue.push([...chain, next]);
        }
    }
    return null;
}

const rel = (p: string) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

const ALL = collectSourceFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
    // `.ts` under `src` with the DEFAULT skips hides real API routes by name.
    skipDirs: ['node_modules', '__tests__'],
    exclude: (r) => r.includes('.test.'),
    floor: 2000,
});
const CLIENT_MODULES = ALL.filter((f) => USE_CLIENT.test(code(f)));

describe("a 'use client' module does not reach a server-only module (#3070)", () => {
    it('no client module reaches next-intl/server, next/headers or server-only', () => {
        console.log(
            `[client-server-boundary] ${CLIENT_MODULES.length} client module(s) of ${ALL.length} ` +
                `scanned against ${SERVER_ONLY_SPECIFIERS.length} server-only specifier(s)`,
        );
        // A floor, because an empty client population passes this for free.
        expect(CLIENT_MODULES.length).toBeGreaterThanOrEqual(300);

        const offenders = CLIENT_MODULES.map((f) => reachesServerOnly(f))
            .filter((c): c is string[] => c !== null)
            .map((chain) => chain.map(rel).join('\n      -> '));

        expect(offenders).toEqual([]);
    });

    it('control: the detector catches a crafted offender, at one hop and at three', () => {
        const dir = fs.mkdtempSync(path.join(REPO_ROOT, 'node_modules', '.cb-'));
        try {
            fs.writeFileSync(
                path.join(dir, 'server-leaf.ts'),
                "import { getTranslations } from 'next-intl/server';\nexport const x = getTranslations;\n",
            );
            fs.writeFileSync(
                path.join(dir, 'mid-b.ts'),
                "export { x } from './server-leaf';\nimport './server-leaf';\n",
            );
            fs.writeFileSync(path.join(dir, 'mid-a.ts'), "import './mid-b';\nexport const y = 1;\n");
            const oneHop = path.join(dir, 'one-hop.tsx');
            fs.writeFileSync(oneHop, "'use client';\nimport './server-leaf';\nexport const A = 1;\n");
            const threeHops = path.join(dir, 'three-hops.tsx');
            fs.writeFileSync(threeHops, "'use client';\nimport './mid-a';\nexport const B = 1;\n");

            expect(USE_CLIENT.test(code(oneHop))).toBe(true);
            expect(reachesServerOnly(oneHop)).not.toBeNull();
            // Three hops: a one-hop-only detector reads this clean.
            const deep = reachesServerOnly(threeHops);
            expect(deep).not.toBeNull();
            expect((deep as string[]).length).toBeGreaterThanOrEqual(4);

            // And a client module reaching only client code is NOT flagged,
            // so the detector discriminates rather than firing on everything.
            const innocent = path.join(dir, 'innocent.tsx');
            fs.writeFileSync(innocent, "'use client';\nimport './mid-never';\nexport const C = 1;\n");
            fs.writeFileSync(path.join(dir, 'mid-never.ts'), 'export const z = 1;\n');
            expect(reachesServerOnly(innocent)).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('control: a type-only import is not a reach — proved on the real chain', () => {
        const card = path.join(
            SRC,
            'app/t/[tenantSlug]/(app)/dashboard/FieldBriefingCard.tsx',
        );
        // If this file moves, the exclusion loses its live proof — fail rather
        // than silently fall back to the synthetic case.
        expect(fs.existsSync(card)).toBe(true);
        const src = code(card);
        expect(USE_CLIENT.test(src)).toBe(true);
        // It really does name a module that is server-only…
        expect(src).toMatch(/import type \{[^}]*\} from '@\/app-layer\/usecases\/satellite-briefing'/);
        const briefing = path.join(SRC, 'app-layer/usecases/satellite-briefing.ts');
        expect(SERVER_ONLY_IMPORT.test(code(briefing))).toBe(true);
        // …and is still clean, because the import is erased.
        expect(reachesServerOnly(card)).toBeNull();
    });

    it("control: the login page is a client module and the footer's mount is a server layout", () => {
        const page = path.join(SRC, 'app/login/page.tsx');
        const layout = path.join(SRC, 'app/login/layout.tsx');
        expect(USE_CLIENT.test(code(page))).toBe(true);
        expect(code(page)).not.toMatch(/PublicLegalFooter/);
        // The layout is where it lives, and the layout must NOT be a client module.
        expect(code(layout)).toMatch(/PublicLegalFooter/);
        expect(USE_CLIENT.test(code(layout))).toBe(false);
    });
});
