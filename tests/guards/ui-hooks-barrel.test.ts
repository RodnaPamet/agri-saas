/**
 * Epic 60 — UI utility hook barrel guardrail.
 *
 * Every `use-*.ts(x)` file in `src/components/ui/hooks/` must export
 * exactly one primary hook named from its file slug, and the barrel
 * (`src/components/ui/hooks/index.ts`) must re-export it. Without this
 * guard, a new hook can silently slip in via a deep-path import and
 * skip the "one canonical home" discipline the epic is built on.
 *
 * The guard runs as a plain file-scan test — no module loading, no
 * jsdom, fast enough to live under `tests/guards/`. Failures are
 * explicit: the error message names which file is missing a barrel
 * entry, which slug it expected, and where to add the line.
 */

import * as fs from 'fs';
import * as path from 'path';

const HOOKS_DIR = path.resolve(
    __dirname,
    '../../src/components/ui/hooks',
);

const BARREL = path.join(HOOKS_DIR, 'index.ts');

/**
 * `use-long-press.ts` → `useLongPress`. The single derivation this guard
 * stands on, at module level ON PURPOSE.
 *
 * It replaces a `slugToHookName` that sat here computing into a const which
 * was never compared to anything and was then discharged with a `void`, so
 * mutating it to return an empty string changed no assertion — `Selector
 * teeth` reported it SURVIVED the moment a PR touching the hooks barrel pulled
 * this guard into the audit population (#2797). It had been dead since
 * somebody added a "simpler path" inline beside it and left the original.
 *
 * Deleting it outright was the first fix and was WORSE: with no module-level
 * selector the file becomes NOT AUDITED, which pushed the repo's unauditable
 * guard count from 200 to 201 and broke that ceiling. A guard whose selecting
 * happens inside `it()` passes whether or not it selects anything, so the
 * ceiling is the right thing to respect — extract the selection, do not
 * remove it.
 */
export function expectedHookName(file: string): string {
    const slug = file.replace(/\.tsx?$/, '').replace(/^use-/, '');
    return (
        'use' +
        slug
            .split('-')
            .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
            .join('')
    );
}

describe('Epic 60 — ui/hooks barrel completeness', () => {
    const files = fs
        .readdirSync(HOOKS_DIR)
        .filter((f) => /^use-.+\.tsx?$/.test(f));

    it('discovers at least a reasonable set of hook files', () => {
        // Sanity check on the discovery — if the directory moves or
        // gets accidentally emptied, the guard still fails noisily
        // rather than silently passing with zero assertions.
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    it('barrel index.ts exists', () => {
        expect(fs.existsSync(BARREL)).toBe(true);
    });

    const barrelSrc = fs.readFileSync(BARREL, 'utf-8');

    test.each(files)(
        '%s: file exports the expected hook and the barrel re-exports it',
        (file) => {
            const expected = expectedHookName(file);

            // A CONTROL on the derivation, and it is load-bearing rather than
            // decorative. With an empty `expected` the export regex below
            // degrades to `export \{[^}]*\}`, which matches any re-export
            // block, and `toContain('')` is trivially true — so the guard
            // could not fail on a WRONG hook name at all. Measured: mutating
            // `expectedHookName` to `return ''` left all 28 cases green, which
            // is what `Selector teeth` reported as SURVIVED (#2797).
            expect(expected).toMatch(/^use[A-Z][A-Za-z0-9]*$/);

            const content = fs.readFileSync(path.join(HOOKS_DIR, file), 'utf-8');
            // The file must export the hook (named export, no default).
            const fileExportsHook = new RegExp(
                `export (function|const|async function) ${expected}\\b|export \\{[^}]*\\b${expected}\\b[^}]*\\}`,
            ).test(content);
            expect(
                fileExportsHook,
            ).toBe(true);

            // The barrel must re-export it from this file path.
            const barrelLine = new RegExp(
                `from ["']\\./${file.replace(/\.tsx?$/, '')}["']`,
            );
            expect(barrelLine.test(barrelSrc)).toBe(true);
            expect(barrelSrc).toContain(expected);
        },
    );
});

describe('Epic 60 — barrel export integrity', () => {
    it('barrel does not export a hook whose file has been deleted', () => {
        const barrelSrc = fs.readFileSync(BARREL, 'utf-8');
        const referencedFiles = Array.from(
            barrelSrc.matchAll(/from ["']\.\/(use-[a-z0-9-]+)["']/g),
            (m) => m[1],
        );
        for (const ref of referencedFiles) {
            const ts = path.join(HOOKS_DIR, `${ref}.ts`);
            const tsx = path.join(HOOKS_DIR, `${ref}.tsx`);
            expect(fs.existsSync(ts) || fs.existsSync(tsx)).toBe(true);
        }
    });
});
