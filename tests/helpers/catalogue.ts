/**
 * The ONE way a test reads the message catalogue — #1813.
 *
 * ## Why this exists
 *
 * 84 files reference the catalogue's path in code, in 58 distinct shapes:
 * `fs.readFileSync` and bare `readFileSync`, inline `path.join(ROOT, …)` and a
 * hoisted `const MESSAGES`, `require(…)`, and 41 static `import en from
 * '../../messages/en.json'`. None is wrong. Together they are 84 places that
 * encode WHERE the catalogue lives.
 *
 * #1813 splits it into bundles, which changes where it lives. With 84 copies
 * that is 84 edits and 84 chances to miss one — and a missed one fails as
 * `ENOENT` at best or reads a stale file at worst. So the path moves behind
 * one function first and the split follows.
 *
 * Same argument as `collect-buffer.ts` (seven copies, #1905) and
 * `src/lib/qr/matrix.ts`: duplication is not a bug until something has to
 * change, and then it is the only thing that matters.
 *
 * ## The type survives the move, which is the part that was not obvious
 *
 * Callers do typed property access — `en.evidence.upload`,
 * `enMessages.locations.detail` — so returning `Record<string, unknown>` would
 * have broken 41 files at the type level and turned a path refactor into a
 * typing exercise.
 *
 * A TYPE-ONLY import of the JSON gives the full parsed type and is ERASED at
 * runtime, so this module names the file for its shape without depending on it
 * for its data. Verified to discriminate rather than widen to `any`: accessing
 * a key the catalogue does not have is a type error.
 *
 * After the split this becomes an intersection of the bundle types, and every
 * call site is untouched:
 *
 *     import type PublicBundle from '../../messages/en/public.json';
 *     import type AppBundle from '../../messages/en/app.json';
 *     export type Catalogue = typeof PublicBundle & typeof AppBundle;
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// The INTERSECTION of the bundle types, now that the catalogue is split
// (#1813). Type-only, so this module still names the files for their SHAPE
// without depending on them for its data — and the docblock above predicted
// exactly this edit, which is the whole reason no call site changes.
import type EnPublicBundle from '../../messages/en/public.json';
import type EnAppBundle from '../../messages/en/app.json';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const MESSAGES_DIR = path.join(REPO_ROOT, 'messages');

/**
 * A locale's full catalogue.
 *
 * Shaped from `en`, which is the canonical locale every other is compared
 * against — `scripts/i18n-diff.mjs` fails on any key present in one and not
 * the other, so one shape for all locales is enforced elsewhere rather than
 * assumed here.
 */
export type Catalogue = typeof EnPublicBundle & typeof EnAppBundle;

/**
 * Read one locale's full catalogue.
 *
 * Handles both layouts, so the split does not touch any caller:
 *   - `messages/<locale>.json`   — one file (today)
 *   - `messages/<locale>/*.json` — N bundles, merged (after the split)
 *
 * Throws on a locale with neither rather than returning `{}`. An empty
 * catalogue satisfies most assertions in the suites that call this — every
 * "no missing keys" check passes over nothing — so silence would be worse
 * than a crash.
 */
export function readCatalogue(locale: string): Catalogue {
    const single = path.join(MESSAGES_DIR, `${locale}.json`);
    if (fs.existsSync(single)) {
        return JSON.parse(fs.readFileSync(single, 'utf-8')) as Catalogue;
    }

    const dir = path.join(MESSAGES_DIR, locale);
    if (!fs.existsSync(dir)) {
        throw new Error(
            `catalogue for locale '${locale}' not found: neither messages/${locale}.json ` +
                `nor messages/${locale}/`,
        );
    }

    const bundles = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    if (bundles.length === 0) {
        throw new Error(`catalogue for locale '${locale}': messages/${locale}/ holds no bundles`);
    }

    const merged: Record<string, unknown> = {};
    for (const file of bundles) {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as Record<
            string,
            unknown
        >;
        for (const [namespace, value] of Object.entries(parsed)) {
            if (namespace in merged) {
                // A namespace in two bundles. `scripts/i18n-diff.mjs` reports
                // it as `duplicated` and blocks the commit; throwing here too
                // means no test can quietly assert against whichever copy the
                // merge happened to keep.
                throw new Error(
                    `catalogue for locale '${locale}': namespace '${namespace}' is in two bundles`,
                );
            }
            merged[namespace] = value;
        }
    }
    return merged as Catalogue;
}

/**
 * Every locale the catalogue holds.
 *
 * Needed because the split changed what a locale LOOKS like on disk: it was a
 * `<locale>.json` file and is now a `<locale>/` directory. A suite that
 * enumerated locales with `readdirSync(messages).filter(endsWith('.json'))`
 * found none after the split and still reported "no missing keys" — a parity
 * check passing over an empty population, which is the exact failure #1813
 * warns about.
 */
export function locales(): string[] {
    return fs
        .readdirSync(MESSAGES_DIR, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name : e.name.endsWith('.json') ? e.name.slice(0, -5) : null))
        .filter((n): n is string => n !== null)
        .sort();
}

/**
 * Where a locale's catalogue is read FROM, for the few tests that name the
 * path rather than the contents (a file-size assertion, an error message).
 *
 * Returns the directory once split, so a caller that stats it still gets
 * something real instead of `ENOENT`.
 */
export function cataloguePath(locale: string): string {
    const single = path.join(MESSAGES_DIR, `${locale}.json`);
    return fs.existsSync(single) ? single : path.join(MESSAGES_DIR, locale);
}
