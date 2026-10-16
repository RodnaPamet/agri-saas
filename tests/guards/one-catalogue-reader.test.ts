/**
 * Tests read the message catalogue through ONE function — #1813.
 *
 * ## Why this guard earns its keep
 *
 * 43 files read `messages/<locale>.json` for themselves, in shapes including
 * `import en from …`, `require(…)`, `readFileSync(join(ROOT, …))`,
 * `readFileSync(\`${REPO_ROOT}/…\`)` and an aliased `@/../messages/en.json`.
 * Migrating them behind `readCatalogue()` took three batches and four failed
 * attempts at scripting it, because the population was not uniform: a `const`
 * is not hoisted where a static import was, so every `jest.mock` factory
 * reading the catalogue broke at once — including `tests/rendered/setup.ts`,
 * and with it 22 suites.
 *
 * None of that is worth paying twice. The point of the migration is that
 * `messages/` can be SPLIT into bundles without touching any caller, and a
 * single new direct reader re-breaks that property silently — it keeps working
 * until the day the files move, which is exactly when nobody is looking for it.
 *
 * ## It forbids READS, not mentions
 *
 * Several suites legitimately name the path in prose or in an assertion
 * message ("New UI must be translatable — add the key to messages/en.json").
 * That is documentation, not coupling. So the patterns below match the three
 * ways a file can actually LOAD the catalogue, and nothing else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** The one module allowed to know where the catalogue lives. */
const CANONICAL = 'tests/helpers/catalogue.ts';

/**
 * The three load forms. Deliberately not "any mention of the path": a guard
 * that banned the string would fail on its own docblock, and on every error
 * message that helpfully tells a developer which file to edit.
 */
const READ_FORMS: ReadonlyArray<{ name: string; re: RegExp }> = [
    { name: 'static import', re: /import\s+\w+\s+from\s+'[^']*messages\/(?:en|bg)\.json'/ },
    { name: 'require', re: /require\(\s*'[^']*messages\/(?:en|bg)\.json'\s*\)/ },
    { name: 'readFileSync', re: /readFileSync\([^)]*messages\/(?:en|bg)\.json/ },
    { name: 'readFileSync (template path)', re: /readFileSync\(\s*`[^`]*messages\/(?:en|bg)\.json/ },
];

const files = collectSourceFiles({
    roots: ['tests'],
    extensions: ['.ts', '.tsx'],
    // ~1100 files under tests/; a floor well under it still catches an
    // exclude predicate or a renamed root that ate the population.
    floor: 400,
}).map((abs) => path.relative(REPO_ROOT, abs));

const codeOf = (rel: string) => blankNonCode(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

describe('tests read the catalogue through one reader', () => {
    it('collected a real population', () => {
        // The denominator. A scan that collected nothing passes the assertion
        // below for free.
        expect(files.length).toBeGreaterThanOrEqual(400);
        expect(files).toContain(CANONICAL);
    });

    it('no test loads messages/<locale>.json directly', () => {
        const offenders: string[] = [];
        for (const rel of files) {
            if (rel === CANONICAL) continue;
            const code = codeOf(rel);
            for (const { name, re } of READ_FORMS) {
                if (re.test(code)) offenders.push(`${rel} — ${name}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the reader is actually used, by suites across every test root', () => {
        // The inverse: one reader nobody imports is not one reader, it is dead
        // code beside direct readers. Spread across roots matters too — the
        // migration covered guards, guardrails, unit and rendered, and a
        // regression in any one of them is what this notices.
        const importers = files.filter((rel) =>
            /from\s+'[^']*helpers\/catalogue'/.test(codeOf(rel)),
        );
        expect(importers.length).toBeGreaterThanOrEqual(30);
        for (const root of ['tests/guards/', 'tests/unit/', 'tests/rendered/']) {
            expect(importers.some((f) => f.startsWith(root))).toBe(true);
        }
    });
});
