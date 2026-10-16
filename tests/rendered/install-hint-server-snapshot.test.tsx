/** @jest-environment node */
/**
 * The install hint is absent from SERVER markup, and the warning around it is not.
 *
 * #1471 converted two components from `useState(false)` + an effect to
 * `useSyncExternalStore`. The comment the effect carried was its whole reason:
 *
 *   > Post-mount: `navigator.userAgent` and `matchMedia` are client-only, and
 *   > reading either during render would mismatch the server's markup.
 *
 * That constraint survived the conversion, and **the jsdom suites cannot see
 * it.** `offline-install-hint.test.tsx` covers all nine user-agent and
 * display-mode combinations, and every one runs where `navigator` exists — so
 * a conversion that read the UA during render would pass all nine and still
 * break hydration in production.
 *
 * This renders on the SERVER and is the only test that exercises
 * `getServerSnapshot`.
 *
 * ## What it catches, mutation-tested — and what it does NOT
 *
 * I first wrote that this "is what fails if somebody simplifies the hook to
 * call `installingWouldPersist()` during render". **Measured, that is false.**
 * Replacing the hook body with a direct call leaves both cases GREEN, because
 * Node's own user agent does not match /iphone|ipad|ipod/ — so a render-time
 * read returns `false` on the server by accident and the markup is identical.
 *
 * What it does catch:
 *
 *     getServerSnapshot removed          2 fail — React: "Missing
 *                                        getServerSnapshot, which is required
 *                                        for server-rendered content"
 *     a hook that throws on the server   caught by the no-throw case
 *
 * So the honest scope is "the hook is wired for SSR and does not explode",
 * not "nobody can read a browser global during render". The thing that would
 * actually catch the latter is a jsdom test with an iOS user agent asserting
 * the hint appears only AFTER hydration, and this is not that test.
 *
 * Recording the refuted claim rather than deleting it, because a comment a
 * reader trusts with no body behind it is worse than no comment.
 *
 * ## Reaching the branch, which is the part that makes it mean anything
 *
 * The remedy sentence only renders inside `pending > 0 && storagePersisted ===
 * false`. Asserting its absence without those props would pass on a component
 * that never evaluated the hint at all — a control that cannot express
 * failure. So the props reach the branch, and the test asserts the
 * SURROUNDING warning is present in the same markup. Absent hint, present
 * warning: the branch ran and the hook answered `false`.
 */
import { readCatalogue } from '../helpers/catalogue';
import { renderToString } from 'react-dom/server';

import { OfflineSyncBar } from '@/components/offline/OfflineSyncBar';
const en = readCatalogue('en');

jest.mock('next-intl', () => ({
    useLocale: () => 'en',
    useTranslations: () => (key: string) =>
        ((require('../helpers/catalogue') as typeof import('../helpers/catalogue'))
            .readCatalogue('en').offline as unknown as Record<string, string>)[key] ??
        `offline.${key}`,
}));

const WARNING = en.offline.storageUnprotected;
const REMEDY = en.offline.storageUnprotectedInstallHint;

describe('server markup never claims iOS (#1471)', () => {
    it('renders the storage warning WITHOUT the install remedy', () => {
        // NOT `expect(typeof navigator).toBe('undefined')` — I wrote that
        // first and it failed: **Node 22 has a global `navigator`**, carrying
        // `userAgent: 'Node.js/22...'`. So `display-mode.ts`'s
        // `typeof navigator === 'undefined'` guard no longer fires on the
        // server at all. What keeps `isIos()` false there is simply that
        // Node's user agent does not match /iphone|ipad|ipod/ — a weaker
        // protection than the guard advertises, and worth knowing before
        // anyone relies on that guard for a new check.
        //
        // `window` is genuinely absent, which is what `isStandalone()` guards
        // on, so that half still works as written.
        expect(typeof window).toBe('undefined');

        const html = renderToString(
            <OfflineSyncBar online pending={3} storagePersisted={false} onSyncNow={() => {}} />,
        );

        // The branch RAN — without this the next assertion is vacuous.
        expect(html).toContain(WARNING);
        // And the remedy, which only an iOS client should see, did not render.
        expect(html).not.toContain(REMEDY);
    });

    it('does not throw without a browser global', () => {
        // The loud failure: a conversion that reads `navigator.userAgent`
        // during render throws here rather than mismatching, and a bare
        // absence assertion would pass on the thrown-and-empty case.
        expect(() =>
            renderToString(<OfflineSyncBar online pending={0} onSyncNow={() => {}} />),
        ).not.toThrow();
    });
});
