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

    test('detector actually finds the next-intl useTranslations import shape', () => {
        expect(IMPORTS_USE_TRANSLATIONS.test(`import { useTranslations } from 'next-intl';`)).toBe(true);
        expect(IMPORTS_USE_TRANSLATIONS.test(`import { useLocale, useTranslations } from "next-intl"`)).toBe(true);
        expect(IMPORTS_USE_TRANSLATIONS.test(`import { getTranslations } from 'next-intl/server';`)).toBe(false);
        expect(HAS_USE_CLIENT.test(`'use client';\nimport x from 'y';`)).toBe(true);
    });
});
