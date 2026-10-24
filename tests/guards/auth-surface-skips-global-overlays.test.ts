/**
 * The sign-in surface does not mount the global overlays (#2264).
 *
 * `src/app/providers.tsx` is rendered by the ROOT layout, so it runs on
 * `/login` as well as inside the app. It mounted `<CommandPalette />` and
 * `<ShortcutHelpOverlay />` unconditionally, and both call
 * `useTranslations(...)` at mount — for namespaces that live in the `app`
 * bundle, which `bundlesFor('auth')` deliberately excludes. Measured on two
 * `main` E2E runs: 1320 `MISSING_MESSAGE: commandPalette` and 840
 * `: shortcutHelp` server-side per run, and `src/i18n.ts` configures no
 * `getMessageFallback`, so next-intl's default printed the key path.
 *
 * ## Why a SOURCE guard and not a render
 *
 * Same idiom as `public-surface-skips-app-chrome.test.ts`, which splits the
 * layout's public branch and reads each side. The property is "this subtree is
 * not reachable on that surface", which is a statement about the tree rather
 * than about one mount: a render test would have to reproduce the auth bundle,
 * the provider stack and next-intl's error channel to observe the same thing,
 * and would still only cover the path it happened to exercise.
 *
 * ## What this does NOT cover, said plainly
 *
 * It checks the two overlays named below and nothing else. A THIRD global
 * overlay added to `providers.tsx` tomorrow, reading a third `app` namespace,
 * passes this file — the list is the coverage. `auth-surface-i18n-complete`
 * does not catch it either: that walk starts at `src/app/login/page.tsx` and
 * never enters the layout, which is the hole #2264 was filed about. The
 * remaining `notFound` and `common` errors from the same measurement are NOT
 * fixed by this change and stay on #2264.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const PROVIDERS = join(REPO_ROOT, 'src/app/providers.tsx');

/** The overlays whose copy the auth bundle does not carry. */
const GATED_OVERLAYS = ['CommandPalette', 'ShortcutHelpOverlay'] as const;

/**
 * Is every JSX mount of `name` guarded by `!isAuthSurface`?
 *
 * Deliberately narrow: it looks for the mount and requires the gate on the
 * SAME line, which is the shape the fix uses (`{!isAuthSurface && <X />}`).
 * A different-shaped gate would read as unguarded here and fail — a false
 * alarm is the right direction for this one, since the alternative is a silent
 * pass on a page that prints key paths.
 */
function mountsAreGated(src: string, name: string): { mounts: number; ungated: string[] } {
    const code = blankNonCode(src);
    const mounts: string[] = [];
    for (const line of code.split('\n')) {
        // `<Name />` or `<Name/>` — the self-closing mount, not the import or
        // a provider wrapper like `<CommandPaletteProvider>`.
        if (new RegExp(`<${name}\\s*/>`).test(line)) mounts.push(line);
    }
    return {
        mounts: mounts.length,
        ungated: mounts.filter((l) => !l.includes('!isAuthSurface')),
    };
}

describe('the auth surface mounts no overlay whose copy it lacks (#2264)', () => {
    const src = readFileSync(PROVIDERS, 'utf8');

    it('control: the file is the one being graded, and it mounts both overlays', () => {
        // Without this the assertion below passes for free if the file moves,
        // is renamed, or stops mounting them at all — the vacuity this repo's
        // guards keep being caught by.
        for (const name of GATED_OVERLAYS) {
            expect(mountsAreGated(src, name).mounts).toBeGreaterThan(0);
        }
        // And it takes the flag at all, so the gate below cannot be a comment.
        expect(blankNonCode(src)).toContain('isAuthSurface');
    });

    it('control: the detector actually distinguishes gated from ungated', () => {
        // The positive control. Every assertion here is "nothing ungated",
        // which an extractor returning an empty list satisfies for free.
        const ungated = `        <CommandPalette />\n`;
        const gated = `        {!isAuthSurface && <CommandPalette />}\n`;
        expect(mountsAreGated(ungated, 'CommandPalette').ungated).toHaveLength(1);
        expect(mountsAreGated(gated, 'CommandPalette').ungated).toHaveLength(0);
        // And prose naming the component cannot create a mount.
        expect(mountsAreGated('// <CommandPalette /> used to be here', 'CommandPalette').mounts)
            .toBe(0);
    });

    it.each(GATED_OVERLAYS)('%s is mounted only when NOT on the auth surface', (name) => {
        const { mounts, ungated } = mountsAreGated(src, name);
        expect({ name, mounts, ungated }).toEqual({ name, mounts, ungated: [] });
    });
});
