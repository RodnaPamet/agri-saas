/**
 * A page that renders on EVERY surface must have its copy on every surface
 * (#2264).
 *
 * `src/app/not-found.tsx` and `src/app/error.tsx` sit at the app root, outside
 * every route group, so they render for a 404 or a crash **wherever it
 * happens** — under `/f/{handle}`, under `/login`, and inside the operator
 * app. Their namespaces therefore have to be in a bundle that every surface
 * loads.
 *
 * `notFound` was in `public`. `bundlesFor('auth')` excludes `public` along with
 * `app` — that exclusion is the whole point of the split — so a 404 under
 * `/login` threw `MISSING_MESSAGE: notFound`, and with no `getMessageFallback`
 * configured next-intl printed the key path. Measured at 360 occurrences per
 * E2E run, steady across two independent `main` runs.
 *
 * ## Why this is not covered by the two surface guards
 *
 * `public-surface-i18n-complete` walks `src/app/f/**` plus these two files and
 * checks them against the PUBLIC payload — it was green, correctly, because
 * `notFound` was in the public bundle. `auth-surface-i18n-complete` walks
 * imports from `src/app/login/page.tsx` and never reaches the root pages at
 * all. Each guard was right about its own surface; neither asked the question
 * these files actually raise, which is "which surfaces do you render on".
 *
 * Asserted through `bundlesFor` and the real catalogues rather than against the
 * namespace lists, so a namespace that is listed somewhere but whose keys are
 * missing from a bundle file still fails.
 */
import * as fs from 'fs';
import * as path from 'path';
import { bundlesFor, type Surface } from '@/lib/i18n/bundles';
import { REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';
import { locales, readBundle } from '../helpers/catalogue';

/** Pages outside every route group — they render on whatever surface faults. */
const ROOT_PAGES = ['src/app/not-found.tsx', 'src/app/error.tsx'];

const SURFACES: Surface[] = ['app', 'public', 'auth'];

/** `useTranslations('ns')` / `getTranslations('ns')` → 'ns'. Code only. */
function namespacesIn(src: string): string[] {
    const out = new Set<string>();
    for (const m of blankNonCode(src).matchAll(
        /\b(?:use|get)Translations\(\s*['"]([A-Za-z][\w.]*)['"]\s*\)/g,
    )) {
        out.add(m[1]);
    }
    return [...out];
}

/**
 * The namespaces a surface can actually resolve, from the bundle FILES.
 *
 * Through `readBundle` rather than reading `messages/` directly:
 * `one-catalogue-reader.test.ts` keeps `tests/helpers/catalogue.ts` the only
 * module that knows where the catalogue lives, which is the property that let
 * it be split into bundles in the first place. My first draft built the path
 * here and that guard caught it — while this PR was splitting the bundles
 * again, which is exactly the day it was written for.
 *
 * `null` means the bundle has no file for this locale, which is expected:
 * `bundleFiles()` emits nothing for an empty category.
 */
function loadable(locale: string, surface: Surface): Set<string> {
    const out = new Set<string>();
    for (const bundle of bundlesFor(surface)) {
        const cat = readBundle(locale, bundle);
        if (cat === null) continue;
        for (const ns of Object.keys(cat)) out.add(ns);
    }
    return out;
}

const READS = ROOT_PAGES.map((rel) => ({
    rel,
    namespaces: namespacesIn(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
}));

describe('the root error pages resolve on every surface (#2264)', () => {
    it('control: the files exist and at least one really reads a namespace', () => {
        // Without this, "no namespace is missing" passes for free on a renamed
        // file or an extractor that stopped matching — which is how a guard
        // ends up green about a page it can no longer see.
        for (const { rel } of READS) {
            expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
        }
        expect(READS.flatMap((r) => r.namespaces)).toContain('notFound');
    });

    it('control: the extractor reads CODE, not prose, and the surfaces differ', () => {
        expect(namespacesIn("const t = await getTranslations('notFound');")).toEqual(['notFound']);
        expect(namespacesIn("// getTranslations('ghost')")).toEqual([]);
        // And the three surfaces are genuinely different bundle sets, or the
        // assertion below would be one check wearing three hats.
        expect(bundlesFor('auth')).not.toEqual(bundlesFor('app'));
        expect(bundlesFor('auth')).not.toEqual(bundlesFor('public'));
    });

    it.each(SURFACES)('every root-page namespace is loadable on the %s surface', (surface) => {
        const missing: string[] = [];
        for (const locale of locales()) {
            const have = loadable(locale, surface);
            for (const { rel, namespaces } of READS) {
                for (const ns of namespaces) {
                    if (!have.has(ns)) missing.push(`${locale}/${surface}: ${rel} reads '${ns}'`);
                }
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} root-page namespace(s) cannot be resolved on a surface they ` +
                    `render on:\n  ${missing.join('\n  ')}\n\n` +
                    `These pages are outside every route group, so they render wherever a 404 ` +
                    `or a crash happens. Put the namespace in SHARED_NAMESPACES ` +
                    `(src/lib/i18n/shared-namespaces.ts) — not in two bundles, which ` +
                    `scripts/i18n-diff.mjs refuses as 'duplicated'.`,
            );
        }
        expect(missing).toEqual([]);
    });
});
