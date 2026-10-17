/**
 * Every namespace the AUTH surface reads is one it is actually sent (#2011).
 *
 * ## The failure this exists for
 *
 * `/login` used to take `allMessages` — all 5787 keys serialised into the HTML
 * a stranger downloads before authenticating — because the #1813 bundle split
 * was keyed on `PUBLIC_SURFACE_PREFIXES`, which is `['/f']` and nothing else.
 * `lighthouserc.json`'s own note named that lever on 2026-07-13 and it stayed
 * unpulled for three months.
 *
 * Now it takes the `auth` bundle alone: **2,084 bytes against app.json's
 * 350,271**.
 *
 * The danger of that trade is silent. A page reading an UNLISTED namespace
 * renders raw keys — `login.submitButton` where «Вход» belongs. next-intl does
 * not throw for a missing namespace in a server component, the HTML is valid,
 * the status is 200, and the only observer is a visitor who cannot sign in.
 * So the list has to be DERIVED from the files, not maintained beside them.
 *
 * ## This walk follows IMPORTS, which the public-surface guard does not
 *
 * Its sibling says so plainly: *"What it does NOT follow is imports. A shared
 * component three levels down that calls `useTranslations('someNamespace')`
 * would not be seen here. That is a real gap."*
 *
 * The gap matters more here. `/f/<handle>` is a server-rendered page with a
 * small tree; `/login` is a form that pulls in shared UI, and a button three
 * levels down reading `common` would break the sign-in page for everyone with
 * no error anywhere. So this one resolves `@/` imports transitively.
 *
 * Its honest limit, in turn: it resolves only `@/`-aliased specifiers to a
 * `.ts`/`.tsx` file or an `index` under them. A bare-package re-export or a
 * dynamic `import()` is invisible, so the list still errs WIDE by preference —
 * an extra namespace costs bytes, a missing one costs a visitor the page.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';
import { AUTH_SURFACE_NAMESPACES, isAuthSurface } from '@/lib/i18n/auth-surface';
import { bundleFor, bundlesFor } from '@/lib/i18n/bundles';

/** Namespaces a file reads, comments blanked so prose cannot add one. */
function namespacesIn(src: string): string[] {
    const code = blankNonCode(src);
    return [
        ...new Set(
            [...code.matchAll(/(?:get|use)Translations\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ),
    ];
}

/** Resolve an `@/`-aliased specifier to a file on disk, or null. */
function resolveAlias(spec: string): string | null {
    if (!spec.startsWith('@/')) return null;
    const base = join(REPO_ROOT, 'src', spec.slice(2));
    for (const candidate of [
        `${base}.tsx`,
        `${base}.ts`,
        join(base, 'index.tsx'),
        join(base, 'index.ts'),
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** Every file reachable from the auth entry points, and what each reads. */
function walkAuthSurface(): { files: Set<string>; namespaces: Set<string> } {
    const entry = join(REPO_ROOT, 'src/app/login/page.tsx');
    const files = new Set<string>();
    const namespaces = new Set<string>();
    const queue = [entry];
    while (queue.length) {
        const file = queue.pop() as string;
        if (files.has(file)) continue;
        files.add(file);
        const src = readFileSync(file, 'utf8');
        for (const ns of namespacesIn(src)) namespaces.add(ns);
        for (const m of blankNonCode(src).matchAll(/from\s+'(@\/[^']+)'/g)) {
            const resolved = resolveAlias(m[1]);
            if (resolved) queue.push(resolved);
        }
    }
    return { files, namespaces };
}

const walk = walkAuthSurface();

describe('the auth i18n payload covers what the auth surface reads (#2011)', () => {
    it('control: the walk reaches a real population', () => {
        // `files.size === 1` would mean the import resolver broke and every
        // assertion below went vacuous — the failure this whole file guards
        // against, applied to itself.
        console.log(
            `[auth-i18n] ${walk.files.size} file(s) reachable from /login, ` +
                `${walk.namespaces.size} namespace(s) read, ${AUTH_SURFACE_NAMESPACES.length} listed`,
        );
        expect(walk.files.size).toBeGreaterThan(1);
        expect(existsSync(join(REPO_ROOT, 'src/app/login/page.tsx'))).toBe(true);
    });

    it('control: the extractor finds the namespaces it is looking for', () => {
        expect(namespacesIn("const t = useTranslations('login');")).toEqual(['login']);
        expect(namespacesIn("const t = await getTranslations('common');")).toEqual(['common']);
        // And prose cannot add one — the trap `blankNonCode` is here for.
        expect(namespacesIn("// see useTranslations('ghost') elsewhere")).toEqual([]);
    });

    it('every namespace the surface READS is listed', () => {
        // The direction that breaks the page. An unlisted namespace renders
        // raw keys with a 200 status, so nothing else in the suite notices.
        const unlisted = [...walk.namespaces]
            .filter((ns) => !(AUTH_SURFACE_NAMESPACES as readonly string[]).includes(ns))
            .sort();
        expect(unlisted.join(', ')).toBe('');
    });

    it('every namespace LISTED is one the surface reads', () => {
        // The other direction. A listed namespace nobody reads is dead weight
        // in the payload this change exists to shrink, and it rots quietly
        // once the page that used it stops.
        const unread = (AUTH_SURFACE_NAMESPACES as readonly string[])
            .filter((ns) => !walk.namespaces.has(ns))
            .sort();
        expect(unread.join(', ')).toBe('');
    });

    it('each listed namespace lives in the `auth` bundle, not `app`', () => {
        // The split is only real if `bundleFor` agrees. A namespace listed
        // here but filed under `app` would be loaded by `bundlesFor('auth')`
        // — which excludes `app` — and so would be ABSENT at render.
        for (const ns of AUTH_SURFACE_NAMESPACES) {
            expect(`${ns} -> ${bundleFor(ns)}`).toBe(`${ns} -> auth`);
        }
    });

    it('the auth surface never loads the app or public bundle', () => {
        const forAuth = bundlesFor('auth');
        expect(forAuth).toContain('auth');
        expect(forAuth).not.toContain('app');
        // Nor the other pre-session surface's copy: farm-profile wording has
        // no business on a sign-in page.
        expect(forAuth).not.toContain('public');
        // And the operator app still gets everything.
        expect(bundlesFor('app')).toContain('app');
    });

    it('the prefix match respects segment boundaries', () => {
        expect(isAuthSurface('/login')).toBe(true);
        expect(isAuthSurface('/login/callback')).toBe(true);
        // A prefix match would hand the slim bundle to this and the symptom
        // would be raw keys rather than an error.
        expect(isAuthSurface('/loginx')).toBe(false);
        expect(isAuthSurface('/f/pobeda')).toBe(false);
    });
});
