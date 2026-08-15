/**
 * Web-platform identifiers must survive a project-wide rename.
 *
 * The Control → Practice rename (2026-08-09) swept ~1000 files. Most
 * homonyms were caught by review — `AbortController`, react-hook-form's
 * `control` prop, xyflow's `<Controls>`. Four were not, and NOTHING in
 * the suite went red for any of them:
 *
 *   • `Cache-Control` → `Cache-Practice` on 39 response headers. The
 *     browser ignores an unknown header, so `no-store` silently stopped
 *     applying to avatar, evidence-download, farm-record, policy-export
 *     and access-review-evidence responses, and the immutable basemap /
 *     cadastre tile caching stopped working.
 *   • `Access-Control-Allow-*` → `Access-Practice-Allow-*` on 28 CORS
 *     headers — i.e. no CORS at all.
 *   • `aria-controls` → `aria-practices` on 5 components. React passes
 *     `aria-*` through verbatim, so invalid ARIA shipped and the
 *     tab→tabpanel and accordion relationships broke for screen
 *     readers. A guardrail asserting the attribute had been renamed
 *     ALONGSIDE it, so it stayed green while asserting the broken form.
 *   • `control` → `practice` as a keyboard-modifier alias in
 *     `keyboard-shortcut-internals.ts`, which made `"control+k"` throw
 *     "unknown modifier"; and `'Control'` as a Playwright key name.
 *
 * TypeScript cannot help here — every one of these is a string literal.
 * The E2E suite caught exactly one, because it was the only one that
 * ran. This guard is the cheap structural backstop: these identifiers
 * belong to the web platform, not to us, and no rename may touch them.
 *
 * This is a source-text guard (see CLAUDE.md, "Green is not the same as
 * executed") — it proves the spellings are present and the mangled
 * forms absent, not that caching or ARIA behave.
 *
 * Adding an entry: any time a rename could plausibly collide with a
 * standard name, put the canonical spelling here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Directories worth scanning — source + tests + shipped static assets. */
// `messages` is in this list because of a bug it would otherwise have
// missed — and did. The Control->Practice sweep mangled three i18n KEYS in
// messages/{en,bg}.json, `controllerTitle`/`Body`/`Contact` ->
// `practicelerTitle`/..., plus the English copy "the data controller" ->
// "the data practiceler". The privacy page's data-controller disclosure —
// a GDPR-relevant section — threw MISSING_MESSAGE at runtime from then on.
// This guard existed to catch exactly that class and never looked at the
// message files. `walk()` already accepts .json; only the root was absent.
const SCAN_ROOTS = ['src', 'tests', 'public', 'scripts', 'deploy', 'messages'];

const SKIP_DIRS = new Set([
    'node_modules',
    '.next',
    'dist',
    'coverage',
    'test-results',
    'playwright-report',
]);

/**
 * Identifiers owned by the web platform / a third-party API. Each entry
 * pairs the canonical spelling with the mangled forms a Control→Practice
 * style sweep would produce. `mustExist` marks the ones this codebase
 * genuinely uses, so deleting every call site also trips the guard.
 */
const PROTECTED: ReadonlyArray<{
    canonical: string;
    mangled: readonly string[];
    mustExist: boolean;
    why: string;
}> = [
    {
        canonical: 'Cache-Control',
        mangled: ['Cache-Practice'],
        mustExist: true,
        why: 'HTTP response header — a mangled name silently drops no-store / immutable.',
    },
    {
        canonical: 'Access-Control-Allow-Origin',
        mangled: ['Access-Practice-Allow-Origin'],
        mustExist: true,
        why: 'CORS header — a mangled name means no CORS at all.',
    },
    {
        canonical: 'Access-Control-Allow-Methods',
        mangled: ['Access-Practice-Allow-Methods'],
        mustExist: true,
        why: 'CORS preflight header.',
    },
    {
        canonical: 'Access-Control-Allow-Headers',
        mangled: ['Access-Practice-Allow-Headers'],
        mustExist: true,
        why: 'CORS preflight header.',
    },
    {
        canonical: 'aria-controls',
        mangled: ['aria-practices', 'aria-practice'],
        mustExist: true,
        why: 'ARIA attribute — React passes aria-* through verbatim, so a typo ships as invalid ARIA.',
    },
    {
        canonical: 'AbortController',
        mangled: ['AbortPractice', 'PracticeAbort'],
        mustExist: true,
        why: 'DOM API.',
    },
];

/**
 * Mangled tokens that are wrong ANYWHERE, independent of a canonical
 * counterpart — keyboard modifiers, Playwright key names, and the
 * infrastructure sense of "control plane".
 */
const BANNED_TOKENS: ReadonlyArray<{ token: string; why: string }> = [
    {
        token: 'practiceler',
        why:
            'A mangled "controller" — "cont[rol]ler" caught the Control->Practice ' +
            'sweep. It landed in messages/{en,bg}.json as the privacy page\'s ' +
            'controllerTitle/Body/Contact keys AND in the English copy itself ' +
            '("the data practiceler"), so the GDPR data-controller disclosure ' +
            'rendered a MISSING_MESSAGE error. "controller" is a legal term of ' +
            'art here, not a domain noun this codebase may rename.',
    },
    {
        token: "'Practice+",
        why: "Playwright/DOM key name — the modifier is 'Control+…'.",
    },
    {
        token: 'Practice+Key',
        why: "Playwright key name — the modifier is 'Control+Key…'.",
    },
    {
        token: 'Cache-Practice',
        why: 'Mangled Cache-Control.',
    },
    {
        token: 'Access-Practice-',
        why: 'Mangled Access-Control-*.',
    },
    {
        token: 'aria-practices',
        why: 'Mangled aria-controls.',
    },
    {
        // One entry, not two — matching folds case, so `Practice-Plane`,
        // `Practice-plane` and `practice-plane` are all this token.
        token: 'Practice-plane',
        why: 'Infrastructure term — "control plane", not our entity.',
    },
];

function walk(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(full, out);
        } else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|sql)$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

const FILES: ReadonlyArray<{ rel: string; src: string }> = SCAN_ROOTS.flatMap(
    (r) => walk(path.join(ROOT, r)),
).map((f) => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));

/** This guard file itself names every banned token as data. */
const SELF = 'tests/guards/web-platform-identifiers.test.ts';
const SUBJECTS: ReadonlyArray<{ rel: string; src: string; lower: string }> = FILES
    .filter((f) => f.rel !== SELF)
    .map((f) => ({ ...f, lower: f.src.toLowerCase() }));

/**
 * Mangled forms are matched CASE-INSENSITIVELY, and that is load-bearing,
 * not defensive. HTTP header names and ARIA attributes are both
 * case-insensitive in use — `res.headers.get('cache-control')` reads the
 * same header a route writes as `'Cache-Control'` — so a codebase spells
 * them in whichever case reads best at each site. The first cut of this
 * guard matched exact case and passed while two tests still asserted on
 * `res.headers.get('cache-practice')`; CI caught them, the guard did not.
 *
 * The canonical `mustExist` probe stays case-SENSITIVE on purpose: it
 * asserts the name is spelled correctly somewhere, and a lowercase
 * reader is not proof that any writer emits the real header.
 */
const containsFold = (haystackLower: string, needle: string) =>
    haystackLower.includes(needle.toLowerCase());

describe('web-platform identifiers survive project-wide renames', () => {
    it('scans a real population (the walker still works)', () => {
        expect(SUBJECTS.length).toBeGreaterThan(500);
    });

    describe.each(PROTECTED)('$canonical', ({ canonical, mangled, mustExist, why }) => {
        if (mustExist) {
            it('is still spelled correctly somewhere in the codebase', () => {
                const hits = SUBJECTS.filter((f) => f.src.includes(canonical));
                if (hits.length === 0) {
                    throw new Error(
                        `"${canonical}" no longer appears anywhere under ` +
                            `${SCAN_ROOTS.join('/')}. ${why} If every call site was ` +
                            `legitimately removed, drop this entry in the same PR — ` +
                            `otherwise a rename has eaten a web-platform name.`,
                    );
                }
                expect(hits.length).toBeGreaterThan(0);
            });
        }

        it.each(mangled)('is never mangled to "%s" (in any case)', (bad) => {
            const hits = SUBJECTS.filter((f) => containsFold(f.lower, bad));
            if (hits.length > 0) {
                throw new Error(
                    `Found "${bad}" — a mangled "${canonical}" — in ` +
                        `${hits.length} file(s). ${why}\n` +
                        hits.slice(0, 10).map((f) => `  ${f.rel}`).join('\n'),
                );
            }
            expect(hits.map((f) => f.rel)).toEqual([]);
        });
    });

    it.each(BANNED_TOKENS)('never contains $token (in any case)', ({ token, why }) => {
        const hits = SUBJECTS.filter((f) => containsFold(f.lower, token));
        if (hits.length > 0) {
            throw new Error(
                `Found banned token "${token}" in ${hits.length} file(s). ${why}\n` +
                    hits.slice(0, 10).map((f) => `  ${f.rel}`).join('\n'),
            );
        }
        expect(hits.map((f) => f.rel)).toEqual([]);
    });

    it('the keyboard-shortcut parser still accepts the "control" modifier alias', () => {
        // The one entry with a behavioural consequence a string scan
        // can't express: the alias table is what makes `"control+k"`
        // parse. Read it from source rather than trusting the token scan.
        const src = fs.readFileSync(
            path.join(ROOT, 'src/lib/hooks/keyboard-shortcut-internals.ts'),
            'utf8',
        );
        expect(src).toMatch(/^\s*control:\s*'ctrl',/m);
        expect(src).not.toMatch(/^\s*practice:\s*'ctrl',/m);
    });

    it.each([
        ["headers: { 'Cache-Practice': 'no-store' }", 'Cache-Practice'],
        ["res.headers.get('cache-practice')", 'Cache-Practice'],
        ['<div aria-Practices="x" />', 'aria-practices'],
    ])('the detector fires on %s (mutation proof)', (planted, token) => {
        // Guards that only ever pass are indistinguishable from guards
        // that cannot fail. The lowercase case is the one that actually
        // escaped: two tests read `headers.get('cache-practice')` while
        // an exact-case matcher reported all-clear.
        expect(containsFold(planted.toLowerCase(), token)).toBe(true);
    });
});
