/**
 * The bottom bar's CROSS-CLIENT contract.
 *
 * `User.bottomTabOrder` is shared with the iOS app, so these cases are not
 * really about this function — they are about two clients agreeing. Each one
 * names what iOS does in the same situation, so a future change here that
 * silently breaks the pairing fails with the reason attached rather than just
 * "expected 5, got 4".
 *
 * The contract was agreed with the Agrent-iOS session on 2026-10-04 (read back
 * from `Agrent/Tabs/BottomTabsStore.swift`, not from memory) and the `[]` row
 * was ruled on by the owner.
 */
import {
    BOTTOM_TAB_LIMIT,
    DEFAULT_BOTTOM_TAB_SUFFIXES,
    resolveBottomTabs,
} from '@/lib/nav/resolve-bottom-tabs';

/** A nav item as `useNavSections()` yields it, reduced to what matters here. */
const item = (href: string) => ({ href: `/t/acme${href}` });

/** Every default surface, reachable. The ordinary case. */
const ALL = DEFAULT_BOTTOM_TAB_SUFFIXES.map(item);

const hrefs = (items: { href: string }[]) => items.map((i) => i.href);

describe('null — never chosen', () => {
    it('falls back to the default order (iOS: same)', () => {
        expect(hrefs(resolveBottomTabs(null, ALL))).toEqual(hrefs(ALL));
    });

    it('still gates: a default the member cannot reach is simply absent', () => {
        const gated = ALL.filter((i) => !i.href.endsWith('/exchange'));
        const out = resolveBottomTabs(null, gated);
        expect(hrefs(out)).not.toContain('/t/acme/exchange');
        expect(out).toHaveLength(4);
    });
});

describe('[] — deliberately cleared', () => {
    it('renders NO bar, which is where web and iOS deliberately differ', () => {
        // iOS returns its defaults here: on iOS the tab bar IS the navigation,
        // so zero tabs is a blank screen. The web has a sidebar and a drawer,
        // so honouring the user's choice costs them nothing. Owner-ruled
        // 2026-10-04. If this ever starts returning defaults, the API's
        // documented "deliberately empty" meaning has been retired and
        // `src/lib/openapi/paths/account.paths.ts` must change in the same diff.
        expect(resolveBottomTabs([], ALL)).toEqual([]);
    });
});

describe('a chosen order', () => {
    it('is honoured in the user’s order, not the default one', () => {
        const out = resolveBottomTabs(['/journal', '/dashboard'], ALL);
        expect(hrefs(out)).toEqual(['/t/acme/journal', '/t/acme/dashboard']);
    });

    it('matches by SUFFIX, so the /t/<slug> prefix is irrelevant', () => {
        const out = resolveBottomTabs(['/journal'], [{ href: '/t/some-other-farm/journal' }]);
        expect(hrefs(out)).toEqual(['/t/some-other-farm/journal']);
    });

    it('shows fewer than five rather than padding (iOS: same)', () => {
        const out = resolveBottomTabs(['/journal', '/dashboard'], ALL);
        expect(out).toHaveLength(2);
    });

    it('clamps to five (iOS: `prefix(5)`)', () => {
        const six = [...DEFAULT_BOTTOM_TAB_SUFFIXES, '/grain/costs'];
        const available = six.map(item);
        expect(resolveBottomTabs(six, available)).toHaveLength(BOTTOM_TAB_LIMIT);
    });
});

describe('unreachable ids', () => {
    it('drops a gated-out id and lets the SIXTH choice take the freed slot', () => {
        // The case that decides resolve-then-clamp vs clamp-then-resolve, and
        // the example both sides agreed on. `/admin` is gated off for this
        // member, so it never reaches `available`.
        const saved = [
            '/journal',
            '/admin',
            '/exchange',
            '/locations',
            '/farm-tasks',
            '/dashboard',
        ];
        const out = resolveBottomTabs(saved, ALL);

        // Five tabs, every one of them chosen by the user. Clamping first would
        // have spent a slot on `/admin` and returned only four.
        expect(out).toHaveLength(BOTTOM_TAB_LIMIT);
        expect(hrefs(out)).toEqual([
            '/t/acme/journal',
            '/t/acme/exchange',
            '/t/acme/locations',
            '/t/acme/farm-tasks',
            '/t/acme/dashboard',
        ]);
    });

    it('ignores an id from a NEWER client build', () => {
        // iOS may ship a surface the web does not have yet. It must degrade to
        // "not shown" rather than rejecting the whole arrangement — which is
        // also why the server stores the list without an allowlist.
        const out = resolveBottomTabs(['/journal', '/some-future-ios-surface'], ALL);
        expect(hrefs(out)).toEqual(['/t/acme/journal']);
    });

    it('falls back to defaults when NOTHING chosen is reachable (iOS: same)', () => {
        // The accident, as opposed to the `[]` statement above. The user asked
        // for `/admin`; losing the role must not silently delete their bar.
        const out = resolveBottomTabs(['/admin'], ALL);
        expect(hrefs(out)).toEqual(hrefs(ALL));
    });

    it('and that fallback is NOT reached while even one choice survives', () => {
        // The discriminator for the case above: one surviving choice means the
        // user's order wins, defaults stay out of it.
        const out = resolveBottomTabs(['/admin', '/journal'], ALL);
        expect(hrefs(out)).toEqual(['/t/acme/journal']);
        expect(out).toHaveLength(1);
    });

    it('returns an empty list when the DEFAULTS are unreachable too', () => {
        // Nothing left to fall back to. The bar renders nothing rather than
        // throwing — a tenant with every field surface gated out.
        expect(resolveBottomTabs(['/admin'], [{ href: '/t/acme/settings' }])).toEqual([]);
        expect(resolveBottomTabs(null, [])).toEqual([]);
    });
});

describe('the nesting hazard in the stored vocabulary', () => {
    it('never renders one nav item twice', () => {
        // The ids are href SUFFIXES and they nest: `/costs` is a suffix of
        // `/grain/costs`. Without a used-set, a saved list containing both
        // resolves to the same item twice — a duplicate tab AND a duplicate
        // React key. The server cannot prevent this: it validates uniqueness of
        // the STRINGS, which these are.
        const available = [item('/grain/costs'), item('/journal')];
        const out = resolveBottomTabs(['/costs', '/grain/costs', '/journal'], available);

        expect(hrefs(out)).toEqual(['/t/acme/grain/costs', '/t/acme/journal']);
        expect(new Set(hrefs(out)).size).toBe(out.length);
    });
});

describe('it can only ever narrow, never widen', () => {
    it('returns nothing that was not already reachable', () => {
        // The security-shaped property: this resolves a PREFERENCE against a
        // list the caller may already reach. A saved id can reorder and hide,
        // never grant. Asserted over every case above rather than argued.
        const available = [item('/journal'), item('/dashboard')];
        const reachable = new Set(hrefs(available));
        for (const saved of [
            null,
            [],
            ['/admin'],
            ['/journal', '/admin'],
            ['/exchange'],
            [...DEFAULT_BOTTOM_TAB_SUFFIXES],
        ] as (string[] | null)[]) {
            for (const got of resolveBottomTabs(saved, available)) {
                expect(reachable.has(got.href)).toBe(true);
            }
        }
    });
});
