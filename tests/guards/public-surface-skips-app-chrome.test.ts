/**
 * The public surface must not RENDER the application's client chrome — #1872.
 *
 * ## What this establishes, and what it does not — #1971
 *
 * The verb is load-bearing. Every assertion here is about which branch of the
 * root layout a component sits in, which is a RENDERING property. It is not a
 * statement about what reaches the browser, and the two differ by a measured
 * amount: `src/app/layout.tsx:14` imports `Providers` STATICALLY, so a chunk
 * from that subtree is in the route's client chunk set whether or not the
 * branch renders. Measured 2026-10-16 on a local build whose chunk hashes
 * reproduce CI's: sonner's 8,895 raw bytes arrive on `/f/{handle}`, 0.9% of
 * the 1,023,621 raw bytes of JS that route loads.
 *
 * So this file previously read as "the public surface ships none of the app's
 * chrome" while establishing only that it does not mount it. The assertions
 * were right; the claim was wider than they could support, which is the
 * failure mode worth naming — a guard can be correct and still describe
 * itself as covering more than it does.
 *
 * Deliberately NOT asserted here: that no provider-only library appears in
 * the route's client chunks. That property needs build output, and the cheap
 * alternative — asserting the static import still exists, so the residue is
 * tracked — would be a guard against a FIX: it would fail the moment somebody
 * legitimately removed the import.
 *
 * **It is asserted elsewhere, since #1971**, by
 * `scripts/ci/check-public-chunk-payload.mjs`, run as a step on the Lighthouse
 * `public-farm` leg — the only page load in CI with the
 * `social.public-profile` flag on and a seeded profile row. It reads that
 * run's reports, maps each Script URL back to a file in `.next`, and fails on
 * a provider-only library that is not in its baseline. `sonner` is in that
 * baseline with the reason; a heavier static import landing beside `Providers`
 * is not, and fails there.
 *
 * Two things learned building it, recorded so nobody repeats them:
 *
 *   - **A build manifest cannot answer this.** Measured 2026-10-23: the
 *     client-reference manifests for `/f/[handle]` and for `/login` list the
 *     SAME 134 clientModules. The app router writes a global client registry
 *     per route file, not a per-route payload list, so `clientModules` returns
 *     an identical answer for every route — a detector with no discriminating
 *     power. `app-build-manifest.json` does not exist in this Next version.
 *   - **Two of #1971's own markers were unfalsifiable.** It reported "no
 *     `SWRConfig`, no `floating-ui` anywhere in the public page's chunks" as
 *     confirmation that #1872 worked. Neither string appears anywhere in a
 *     production build — `SWRConfig` is an identifier and minifiers rename
 *     them, and `@floating-ui` ships no distinctive surviving literal. The
 *     rest of that measurement stands.
 *
 * What #1872 DID remove is the bulk, and that is confirmed by the same
 * measurement: no next-intl client runtime, no SWR, no cmdk, no radix and no
 * floating-ui appear in the public page's chunks.
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

/**
 * Client chrome that must never MOUNT for an anonymous visitor.
 *
 * Mount, not ship — see the note at the top of this file on why the
 * distinction is measured rather than pedantic.
 */
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

describe('the public surface does not RENDER the app’s client chrome', () => {
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
