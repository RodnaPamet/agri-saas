/**
 * The public surface must not mount the application's client chrome — #1872.
 *
 * `/f/{handle}` is a page a stranger opens from a shared link. It used to
 * mount the whole app tree: a ⌘K command palette, a shortcut help overlay, a
 * toaster nothing emits into, form telemetry with no forms, view transitions,
 * `SWRPersistenceProvider` handed an undefined `userId`, a cache-retention
 * sweep for a device with nothing cached, and an offer to install a
 * farm-management PWA.
 *
 * That was a correctness problem before a performance one — ⌘K on a farm's
 * public page opened the application's search — and also the measured lever
 * for P6.5's LCP target (#1866: 3635 ms against a 2500 ms goal, TBT 380 ms on
 * output that is a heading and five fields).
 *
 * ## Why this reads the source
 *
 * The property is structural: which components sit in which branch of the
 * root layout. `layout.tsx` is an async server component that awaits
 * `headers()` and `getMessages()`, so rendering it in jsdom would mean
 * mocking most of Next — and the thing under test is the branch, not the
 * render. `public-surface-payload` establishes the same idiom for the
 * middleware half of this bridge.
 *
 * Comments are blanked first, and that is load-bearing rather than tidy: the
 * docblock in `layout.tsx` NAMES every component it excludes, in order to
 * explain why. A raw-text search would find all of them in the prose and
 * report the opposite of the truth.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const LAYOUT = path.join(REPO_ROOT, 'src/app/layout.tsx');

/** Client chrome that must never mount for an anonymous visitor. */
const APP_ONLY_CHROME = [
    'ServiceWorkerRegistrar',
    'ClientDataRetentionSweep',
    'Providers',
] as const;

/** Mounted on BOTH branches — see the layout on why this one stays. */
const SHARED = 'WebVitalsReporter';

export interface Branches {
    readonly beforeTernary: string;
    readonly whenPublic: string;
    readonly whenApp: string;
}

/**
 * Split the layout's `isPublic ? … : …` into its two branches.
 *
 * Takes source text so the controls below can hand it a synthetic layout; an
 * extractor that only ever sees the real file cannot be shown to discriminate.
 */
export function splitPublicBranch(source: string): Branches | null {
    const code = blankNonCode(source);
    const open = code.indexOf('{isPublic ? (');
    if (open === -1) return null;
    const sep = code.indexOf(') : (', open);
    if (sep === -1) return null;
    return {
        beforeTernary: code.slice(0, open),
        whenPublic: code.slice(open, sep),
        whenApp: code.slice(sep),
    };
}

describe('the public surface skips the app’s client chrome', () => {
    const source = fs.readFileSync(LAYOUT, 'utf8');

    it('found the branch it is asserting about', () => {
        // Without this the assertions below pass for free on a layout that
        // stopped branching at all — the exact shape of regression this
        // guards, reported as green.
        const branches = splitPublicBranch(source);
        expect(branches).not.toBeNull();
        expect(branches!.whenApp).toContain('children');
        expect(branches!.whenPublic).toContain('children');
    });

    it.each(APP_ONLY_CHROME)('%s mounts only on the app branch', (component) => {
        const b = splitPublicBranch(source)!;
        expect(b.whenApp).toContain(`<${component}`);
        expect(b.whenPublic).not.toContain(`<${component}`);
    });

    it('WebVitalsReporter is shared, mounted before the branch', () => {
        // Named explicitly so a future "trim everything" change has to decide
        // about it rather than sweeping it up: it needs no provider, and
        // dropping field data from the one page with a performance budget
        // while chasing that budget would be a strange trade.
        const b = splitPublicBranch(source)!;
        expect(b.beforeTernary).toContain(`<${SHARED}`);
    });

    it('detects chrome that leaked into the public branch', () => {
        // The positive control. Every assertion above is "not present", which
        // an extractor returning empty strings satisfies for free.
        const leaked = `
            <NextIntlClientProvider>
                {isPublic ? (
                    <>
                        <Providers userId={u}>{children}</Providers>
                    </>
                ) : (
                    <>{children}</>
                )}
            </NextIntlClientProvider>`;
        const b = splitPublicBranch(leaked)!;
        expect(b.whenPublic).toContain('<Providers');
        expect(b.whenApp).not.toContain('<Providers');
    });

    it('is not fooled by the component names in prose', () => {
        // `layout.tsx` explains the exclusion by naming what it excludes. A
        // raw-text search would read the explanation as the thing itself.
        const prose = `
            // <Providers> and <ServiceWorkerRegistrar> are excluded here.
            {isPublic ? (
                <>{children}</>
            ) : (
                <><Providers userId={u}>{children}</Providers></>
            )}`;
        const b = splitPublicBranch(prose)!;
        expect(b.whenPublic).not.toContain('<Providers');
        expect(b.whenApp).toContain('<Providers');
    });

    it('returns null when there is no branch, rather than guessing', () => {
        expect(splitPublicBranch('const x = 1;')).toBeNull();
    });
});
