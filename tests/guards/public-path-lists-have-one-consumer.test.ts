/**
 * The two public-path lists are exported for TESTS only — #1848.
 *
 * `PUBLIC_PATH_PREFIXES` and `PUBLIC_PATH_EXACT` are FAIL-OPEN: anything
 * matching either one skips the auth gate. They were deliberately not
 * exported for that reason, and `public-prefix-segment-boundary` parsed the
 * source instead, its docblock saying plainly that "exporting a fail-open
 * list invites a second consumer".
 *
 * The concern is right. A module that imported either list to decide
 * something adjacent — whether to render a nav item, whether to skip a
 * redirect — would inherit auth semantics nobody reviewed for that purpose,
 * and would then make the list harder to narrow, because two call sites would
 * depend on its exact contents and only one of them would be read as
 * security-relevant.
 *
 * What the parse cost was a blind spot a floor could not catch: it matched
 * quoted literals only, so the one entry spelled as a constant was outside
 * every assertion that claimed to range over all of them. The lists are now
 * exported, and this guard is what keeps the original intent — the invitation
 * is refused by the build rather than by a comment asking nobody to accept
 * it.
 *
 * `isPublicPath` and `matchesPublicPrefix` remain the supported way to ask the
 * question, and nothing here restricts them.
 */
import fs from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const LIST_NAMES = ['PUBLIC_PATH_PREFIXES', 'PUBLIC_PATH_EXACT'] as const;

/** The module that DEFINES the lists; it does not import them. */
const DEFINING_MODULE = 'src/lib/auth/guard.ts';

/**
 * Which of the two lists an import statement in `source` names.
 *
 * Takes the source text rather than a path so it can be handed a synthetic
 * import below. Comments are blanked first, and that is load-bearing: both
 * names appear in prose in several files — `guard.ts` alone mentions
 * `PUBLIC_PATH_EXACT` five times in comments — so a raw-text search would
 * report every one of them as a consumer.
 */
export function importedListNames(source: string): string[] {
    const code = blankNonCode(source);
    const found = new Set<string>();
    for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from/gs)) {
        for (const name of LIST_NAMES) {
            if (match[1].includes(name)) found.add(name);
        }
    }
    return [...found].sort();
}

describe('the public-path lists have exactly one consumer', () => {
    const files = collectSourceFiles({ roots: ['src'], floor: 500 });

    it('no module under src/ imports either list', () => {
        const offenders = files
            .filter((file) => !file.endsWith(DEFINING_MODULE))
            .map((file) => ({ file, names: importedListNames(fs.readFileSync(file, 'utf8')) }))
            .filter((row) => row.names.length > 0)
            .map((row) => `${row.file.split('/src/')[1]} imports ${row.names.join(', ')}`);

        expect(offenders).toEqual([]);
    });

    it('detects an import when there is one', () => {
        // Positive control. The assertion above is "this list is empty", which
        // a detector that finds nothing satisfies for free.
        expect(
            importedListNames("import { PUBLIC_PATH_PREFIXES } from '@/lib/auth/guard';"),
        ).toEqual(['PUBLIC_PATH_PREFIXES']);
        expect(
            importedListNames(
                "import { isPublicPath, PUBLIC_PATH_EXACT } from '@/lib/auth/guard';",
            ),
        ).toEqual(['PUBLIC_PATH_EXACT']);
        expect(
            importedListNames(
                "import { PUBLIC_PATH_EXACT, PUBLIC_PATH_PREFIXES } from '@/lib/auth/guard';",
            ),
        ).toEqual(['PUBLIC_PATH_EXACT', 'PUBLIC_PATH_PREFIXES']);
    });

    it('ignores the names in prose, which is why comments are blanked', () => {
        expect(importedListNames('// PUBLIC_PATH_PREFIXES is fail-open.')).toEqual([]);
        expect(importedListNames('/** See PUBLIC_PATH_EXACT below. */')).toEqual([]);
        // The supported API is not restricted.
        expect(importedListNames("import { isPublicPath } from '@/lib/auth/guard';")).toEqual([]);
    });

    it('swept a real population, and the defining module is in it', () => {
        // Without this the sweep could be empty for a reason unrelated to the
        // property — a renamed root, an extension filter that matches nothing.
        expect(files.length).toBeGreaterThanOrEqual(500);
        expect(files.some((f) => f.endsWith(DEFINING_MODULE))).toBe(true);
    });
});
