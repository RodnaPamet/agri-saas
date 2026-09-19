/**
 * i18n client-directive guard.
 *
 * `useTranslations` from `next-intl` is the CLIENT hook. In next-intl v4
 * the import binding is resolved by the module's `'use client'` directive:
 * a component that calls `useTranslations` but lacks `'use client'` binds
 * the SERVER implementation, which THROWS during SSR when the component is
 * rendered inside a server tree (e.g. a `loading.tsx` rendering a migrated
 * `<Skeleton>`). That 500s the page — and it is invisible to jest, because
 * the `tests/rendered/setup.ts` next-intl mock resolves strings without
 * exercising the real server/client split. So it only surfaces in E2E/build.
 *
 * This guard makes the failure structural + fast: any `.tsx` under `src/`
 * that imports `useTranslations` from `next-intl` MUST declare `'use
 * client'`. Server components must use `getTranslations` from
 * `next-intl/server` instead (which is not matched here).
 *
 * (Discovered when the T02 i18n batch crashed every page in E2E — 5 shared
 * primitives used `useTranslations` without the directive.)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(REPO_ROOT, 'src');

const IMPORTS_USE_TRANSLATIONS =
    /import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*['"]next-intl['"]/;
const HAS_USE_CLIENT = /^\s*['"]use client['"]\s*;?/m;

function walkTsx(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === '__tests__' || e.name === 'node_modules') continue;
            out.push(...walkTsx(full));
        } else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) {
            out.push(full);
        }
    }
    return out;
}

describe('i18n client-directive guard', () => {
    const offenders: string[] = [];
    for (const file of walkTsx(SRC)) {
        const src = fs.readFileSync(file, 'utf-8');
        if (IMPORTS_USE_TRANSLATIONS.test(src) && !HAS_USE_CLIENT.test(src)) {
            offenders.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'));
        }
    }

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walkTsx` and NOT ONE test failed. Its only
    // call site is the `for (const file of walkTsx(SRC))` loop above, so
    // every EMPTY-ITERABLE gut — `[]`, `''`, `new Set()`, `new Map()` —
    // makes that loop run zero times: `offenders` stays empty, the throw
    // never fires, green. "835 components scanned, every one declares 'use
    // client'" and "no file was ever opened" were the same result — and the
    // test below makes no `expect()` call at all, so an empty scan is a
    // zero-assertion pass. (The non-iterable guts — `0` / `null` /
    // `undefined` / `false` / `{}` — throw at the for-of, which sits in the
    // describe BODY: jest then reports 0 tests, so the tool skips them
    // rather than scoring a kill.)
    //
    // The `: string[]` annotation is NOT the filter here. tsconfig.json sets
    // `isolatedModules: true`, so ts-jest compiles with `transpileModule`
    // and raises syntactic diagnostics only — `return '';` from a
    // `: string[]` function runs. Never rely on a return type to kill a gut.
    //
    // Nor does the `fs.existsSync` throw INSIDE `walkTsx` (#875) cover any
    // of it: gutting replaces the WHOLE function, so that floor never runs.
    // A check one layer down cannot protect a caller that stops calling it,
    // which is why it is asserted separately, at the call site.

    it('control: walkTsx returns the real .tsx population under src/', () => {
        const files = walkTsx(SRC);
        // Kills `''` / `new Set()` / `new Map()` at the seam instead of
        // letting them read as a zero-length scan.
        expect(Array.isArray(files)).toBe(true);
        // Measured 2026-09-19: 835 files. The floor sits far below that, so
        // ordinary feature PRs never move it.
        expect(files.length).toBeGreaterThan(400);

        const rels = files.map((f) =>
            path.relative(REPO_ROOT, f).split(path.sep).join('/'),
        );
        expect(rels.filter((r) => !r.startsWith('src/'))).toEqual([]);

        // The exclusions must BITE. The extension filter is the one with
        // real material behind it — 1,123 `.ts` files live under `src/`, 49
        // of them directly in `src/lib` — derived here rather than named, so
        // this cannot go stale as files move.
        const libTs = fs
            .readdirSync(path.join(SRC, 'lib'), { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.ts'))
            .map((e) => `src/lib/${e.name}`);
        expect(libTs.length).toBeGreaterThan(10);
        expect(rels.filter((r) => libTs.includes(r))).toEqual([]);
        expect(rels.filter((r) => !r.endsWith('.tsx'))).toEqual([]);
        // These two are PINS, not measured bites: both `.tsx` files under a
        // `__tests__` directory today are also `.test.tsx`, so the extension
        // filter would drop them anyway. They fail if the population ever
        // widens.
        expect(rels.filter((r) => r.endsWith('.test.tsx'))).toEqual([]);
        expect(rels.filter((r) => r.split('/').includes('__tests__'))).toEqual([]);

        // RECURSION is the one behaviour a constant return cannot express,
        // and real product source proves it: the deepest page sits nine
        // segments down (src/app/t/[tenantSlug]/(app)/admin/integrations/
        // sharepoint-health/page.tsx, measured).
        expect(
            Math.max(...rels.map((r) => r.split('/').length)),
        ).toBeGreaterThanOrEqual(6);
    });

    it('control: walkTsx reaches the components this guard is about', () => {
        let importers = 0;
        let withDirective = 0;
        for (const file of walkTsx(SRC)) {
            const text = fs.readFileSync(file, 'utf-8');
            if (!IMPORTS_USE_TRANSLATIONS.test(text)) continue;
            importers += 1;
            if (HAS_USE_CLIENT.test(text)) withDirective += 1;
        }
        // POSITIVE CONTROL from real product source. Measured 2026-09-19:
        // 262 of the 835 scanned components import next-intl's
        // `useTranslations`. Without this, "zero offenders" and "zero files
        // opened" remain the same observation.
        expect(importers).toBeGreaterThan(100);
        // The measurement the main test only ever asserts NEGATIVELY: every
        // importer in the scanned population carries the directive.
        expect(withDirective).toBe(importers);
    });

    it('control: walkTsx refuses a scan root that does not exist (#875)', () => {
        // Asserted at the CALL SITE, because the throw lives inside the very
        // function a mutation replaces.
        expect(() => walkTsx(path.join(SRC, '__no_such_scan_root__'))).toThrow(
            /scan root does not exist/,
        );
    });

    test('every component importing useTranslations declares "use client"', () => {
        if (offenders.length > 0) {
            throw new Error(
                `These components import next-intl's useTranslations (a CLIENT hook) but ` +
                    `lack a "use client" directive — they will 500 during SSR:\n` +
                    offenders.map((f) => `  - ${f}`).join('\n') +
                    `\n\nAdd "use client" at the top of the file, or (for a genuine Server ` +
                    `Component) use getTranslations from "next-intl/server" instead.`,
            );
        }
    });

    // ── Control (#971) — the detector's dangerous direction ──────────
    //
    // `IMPORTS_USE_TRANSLATIONS` and `HAS_USE_CLIENT` are module-level
    // selectors that `selector-teeth` cannot reach: it mutates only
    // function-valued declarations, so a RegExp const is invisible to it
    // (this file reports exactly one candidate, `walkTsx`). Its gut set is
    // falsy/empty-only and never tries `true` — and TRUE is the dangerous
    // direction here, because `HAS_USE_CLIENT` is consumed NEGATED: a regex
    // that matches every file silences every offender for good, with the
    // walk intact and all 835 files genuinely opened.
    //
    // The test below asserts `HAS_USE_CLIENT` only in the positive
    // direction, so an always-true rewrite passes it. (Its
    // `IMPORTS_USE_TRANSLATIONS` half IS two-directional already — the
    // `next-intl/server` negative — and needs nothing added.)

    it('control: HAS_USE_CLIENT is false without a real directive, and a manufactured offender is caught', () => {
        // The negative half the test below omits.
        expect(
            HAS_USE_CLIENT.test(`import { useTranslations } from 'next-intl';`),
        ).toBe(false);
        // A mention of the directive is not the directive: only a line whose
        // first non-space characters are the quoted string counts.
        expect(
            HAS_USE_CLIENT.test(`// 'use client' belongs at the top\nimport x from 'y';`),
        ).toBe(false);

        // MANUFACTURED POSITIVE CONTROL, from real product source. There is
        // no genuine offender to point at — that is this guard working — and
        // no exemption list to derive one from, so take the first scanned
        // component carrying BOTH the import and the directive and delete the
        // directive line. Derived from the walk, so it cannot go stale the
        // way a named path would.
        let sample: string | undefined;
        for (const file of walkTsx(SRC)) {
            const text = fs.readFileSync(file, 'utf-8');
            if (IMPORTS_USE_TRANSLATIONS.test(text) && HAS_USE_CLIENT.test(text)) {
                sample = text;
                break;
            }
        }
        if (!sample) {
            throw new Error(
                'no scanned component imports useTranslations with a "use client" directive — the walk or one of the two detectors is broken',
            );
        }
        expect(HAS_USE_CLIENT.test(sample)).toBe(true);

        const stripped = sample
            .split('\n')
            .filter((line) => !/^\s*['"]use client['"]\s*;?\s*$/.test(line))
            .join('\n');
        // The pair must SEPARATE the two texts — flagging both, or neither,
        // is what an always-true / always-false rewrite produces.
        expect(IMPORTS_USE_TRANSLATIONS.test(stripped)).toBe(true);
        expect(HAS_USE_CLIENT.test(stripped)).toBe(false);
    });

    test('detector actually finds the next-intl useTranslations import shape', () => {
        expect(IMPORTS_USE_TRANSLATIONS.test(`import { useTranslations } from 'next-intl';`)).toBe(true);
        expect(IMPORTS_USE_TRANSLATIONS.test(`import { useLocale, useTranslations } from "next-intl"`)).toBe(true);
        expect(IMPORTS_USE_TRANSLATIONS.test(`import { getTranslations } from 'next-intl/server';`)).toBe(false);
        expect(HAS_USE_CLIENT.test(`'use client';\nimport x from 'y';`)).toBe(true);
    });
});
