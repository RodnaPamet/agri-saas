/**
 * Epic 47 — Command Palette entity search (UNIFIED ENDPOINT VERSION).
 *
 * Original Epic 57 fan-out (5 parallel calls to per-entity list APIs)
 * was replaced by a single call to `GET /api/t/<slug>/search?q=`. The
 * server returns pre-ranked, pre-shaped `SearchHit[]` rows. These
 * tests assert the unified contract:
 *
 *   1. Outside a tenant route, no fetch fires + the empty state shows.
 *   2. With a long-enough query, the palette hits ONE URL:
 *      `/api/t/<slug>/search?q=<encoded-query>`.
 *   3. Below the threshold, no fetch fires.
 *   4. Hits render grouped by `type` with title/subtitle/badge.
 *   5. Selecting a hit navigates to its `href` and closes the palette.
 *   6. Repeated keystrokes debounce to a single batch.
 *   7. The slug in every URL matches the current pathname.
 *
 * `global.fetch` is stubbed to return canned `SearchResponse` payloads.
 */

import React from 'react';
import {
    render,
    fireEvent,
    act,
    waitFor,
} from '@testing-library/react';
import type { SearchHit, SearchResponse } from '@/lib/search/types';

// Mock next/navigation — the palette reads pathname + router.
const navigationMock = {
    pathname: '/t/acme-corp/dashboard',
    push: jest.fn(),
};
jest.mock('next/navigation', () => ({
    usePathname: () => navigationMock.pathname,
    useRouter: () => ({
        push: (href: string) => navigationMock.push(href),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

jest.mock('next-auth/react', () => ({
    signOut: jest.fn(),
    signIn: jest.fn(),
}));


import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

import {
    CommandPalette,
    CommandPaletteProvider,
    useCommandPalette,
} from '@/components/command-palette';

// ─── Fetch stub ──────────────────────────────────────────────────────

interface CannedResponse {
    ok: boolean;
    json: () => Promise<unknown>;
}

function canned(json: unknown): CannedResponse {
    return { ok: true, json: async () => json };
}

interface FetchCall {
    url: string;
}
const calls: FetchCall[] = [];

/**
 * Build a canned `/search` response. The unified endpoint pre-ranks
 * results across all entity types; tests can pass a curated `hits`
 * list to assert how the palette renders the response.
 */
function searchResponse(
    hits: SearchHit[],
    query: string = 'security',
): SearchResponse {
    return {
        hits,
        meta: {
            query,
            perTypeCounts: {
                control: hits.filter((h) => h.type === 'control').length,
                policy: hits.filter((h) => h.type === 'policy').length,
                evidence: hits.filter((h) => h.type === 'evidence').length,
                framework: hits.filter((h) => h.type === 'framework').length,
                asset: hits.filter((h) => h.type === 'asset').length,
                task: hits.filter((h) => h.type === 'task').length,
                knowledge: hits.filter((h) => h.type === 'knowledge').length,
            },
            truncated: false,
            perTypeLimit: 10,
        },
    };
}

const SAMPLE_HITS: SearchHit[] = [
    {
        type: 'control',
        id: 'ctrl-1',
        title: 'Information security policies',
        subtitle: 'A.5.1',
        badge: 'IMPLEMENTED',
        href: '/t/acme-corp/controls/ctrl-1',
        score: 0.95,
        iconKey: 'shield-check',
        category: 'Controls',
    },
    {
        type: 'policy',
        id: 'pol-1',
        title: 'Access Control Policy',
        subtitle: null,
        badge: 'PUBLISHED',
        href: '/t/acme-corp/policies/pol-1',
        score: 0.85,
        iconKey: 'file-text',
        category: 'Policies',
    },
    {
        type: 'evidence',
        id: 'ev-1',
        title: 'MFA screenshot',
        subtitle: null,
        badge: 'FILE',
        href: '/t/acme-corp/evidence/ev-1',
        score: 0.8,
        iconKey: 'paperclip',
        category: 'Evidence',
    },
    {
        type: 'framework',
        id: 'ISO27001',
        title: 'ISO 27001:2022',
        subtitle: '2022',
        badge: null,
        href: '/t/acme-corp/frameworks/ISO27001',
        score: 0.7,
        iconKey: 'layers',
        category: 'Frameworks',
    },
];

function installFetchStub(hits: SearchHit[] = SAMPLE_HITS) {
    // The real backend ranks results server-side from the `?q=`
    // value. The stub doesn't need to ape ranking — it just returns
    // the canned hits unchanged so the palette has multi-type rows
    // to render. Tests that need filter-aware behaviour can pass a
    // narrower `hits` array to `installFetchStub(...)`.
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
        async (url: string) => {
            calls.push({ url });
            const match = url.match(/[?&]q=([^&]+)/);
            const query = match ? decodeURIComponent(match[1]) : 'security';
            return canned(searchResponse(hits, query));
        },
    );
}

// Helper — type into the palette input. cmdk uses an `<input>` we
// reach via data-testid; fireEvent.change is deliberate so cmdk sees
// a single value update rather than N individual keystrokes.
async function openPaletteAndType(value: string) {
    const input = document.querySelector(
        '[data-testid="command-palette-input"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value } });
    // useEntitySearch debounces 180 ms; flush any pending timers.
    await act(async () => {
        await new Promise((r) => setTimeout(r, 220));
    });
}

function Shell({ children }: { children?: React.ReactNode }) {
    // Test-only inner component: opens the palette imperatively after
    // the provider mounts. Defined inline because it needs to
    // useCommandPalette() under the just-mounted provider; hoisting
    // it would force a context-passing dance for one assertion.

    function OpenOnMount() {
        const { open } = useCommandPalette();
        React.useEffect(() => {
            open();
        }, [open]);
        return null;
    }
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                {/* eslint-disable-next-line react-hooks/static-components */}
                <OpenOnMount />
                {children}
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

beforeEach(() => {
    calls.length = 0;
    navigationMock.pathname = '/t/acme-corp/dashboard';
    navigationMock.push.mockReset();
    installFetchStub();
});

afterEach(() => {
    // Restore to avoid leaking between test files.
    delete (global as unknown as { fetch?: unknown }).fetch;
});

// ─── Behaviour ───────────────────────────────────────────────────────

describe('CommandPalette — entity search (unified /search)', () => {
    it('renders no results and issues no fetch outside a tenant route', async () => {
        navigationMock.pathname = '/login';
        render(<Shell />);
        await openPaletteAndType('security');
        expect(calls).toHaveLength(0);
        // Empty-state copy signals the palette knows there's no tenant.
        const emptyText = document.querySelector('[cmdk-empty]')?.textContent;
        expect(emptyText).toMatch(/after sign-in|search is available/i);
    });

    it('issues exactly one /search request when the query is long enough', async () => {
        render(<Shell />);
        await openPaletteAndType('sec');

        // ONE call — the unified endpoint replaces five fan-out calls.
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(
            /^\/api\/t\/acme-corp\/search\?q=sec$/,
        );
    });

    it('does not fire a request for a query that is shorter than the threshold', async () => {
        render(<Shell />);
        await openPaletteAndType('s');
        expect(calls).toHaveLength(0);
    });

    it('renders hits grouped by type with title/subtitle/badge', async () => {
        render(<Shell />);
        await openPaletteAndType('security');

        await waitFor(() => {
            expect(
                document.querySelector(
                    '[data-testid="command-palette-result-control"]',
                ),
            ).not.toBeNull();
        });

        const row = document.querySelector(
            '[data-testid="command-palette-result-control"]',
        )!;
        expect(row.textContent).toContain('A.5.1');
        expect(row.textContent).toContain('Information security policies');
        expect(row.textContent).toContain('IMPLEMENTED');

        const policy = document.querySelector(
            '[data-testid="command-palette-result-policy"]',
        )!;
        expect(policy.textContent).toContain('Access Control Policy');
        expect(policy.textContent).toContain('PUBLISHED');

        const evidence = document.querySelector(
            '[data-testid="command-palette-result-evidence"]',
        )!;
        expect(evidence.textContent).toContain('MFA screenshot');
        expect(evidence.textContent).toContain('FILE');
    });

    it('renders framework hits returned by the server', async () => {
        // Server-side ranking now decides what frameworks come back.
        // The palette no longer client-filters frameworks — the
        // unified API does it server-side from the same `?q=`. The
        // test asserts a framework hit renders when present in the
        // canned response.
        render(<Shell />);
        await openPaletteAndType('iso');

        await waitFor(() => {
            expect(
                document.querySelectorAll(
                    '[data-testid="command-palette-result-framework"]',
                ).length,
            ).toBeGreaterThan(0);
        });
    });

    it('navigates to the entity detail route on select + closes the palette', async () => {
        const { getByTestId, queryByTestId } = render(<Shell />);
        await openPaletteAndType('security');

        const row = await waitFor(() =>
            getByTestId('command-palette-result-control'),
        );
        const href = row.getAttribute('data-href');
        expect(href).toBe('/t/acme-corp/controls/ctrl-1');

        fireEvent.click(row);
        expect(navigationMock.push).toHaveBeenCalledWith(
            '/t/acme-corp/controls/ctrl-1',
        );
        // Palette closes after navigation.
        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
    });

    it('debounces repeated keystrokes — one /search per quiet period', async () => {
        render(<Shell />);
        const input = document.querySelector(
            '[data-testid="command-palette-input"]',
        ) as HTMLInputElement;
        // Fire several changes in quick succession without waiting.
        fireEvent.change(input, { target: { value: 's' } });
        fireEvent.change(input, { target: { value: 'se' } });
        fireEvent.change(input, { target: { value: 'sec' } });
        await act(async () => {
            await new Promise((r) => setTimeout(r, 250));
        });
        // Only the final query actually fires.
        const searchCalls = calls.filter((c) =>
            c.url.startsWith('/api/t/acme-corp/search'),
        );
        expect(searchCalls).toHaveLength(1);
        expect(searchCalls[0].url).toContain('q=sec');
    });

    it('stays scoped to the tenant in the current URL — cannot reach another tenant', async () => {
        navigationMock.pathname = '/t/tenant-a/controls';
        render(<Shell />);
        await openPaletteAndType('foo');

        expect(calls.every((c) => c.url.startsWith('/api/t/tenant-a/'))).toBe(
            true,
        );
        expect(calls.some((c) => c.url.includes('/api/t/tenant-b/'))).toBe(false);
        // Must have actually hit the network — otherwise the prior
        // assertion is trivially satisfied.
        expect(calls.length).toBeGreaterThan(0);
    });

    it('re-scopes to the new tenant when the URL switches', async () => {
        navigationMock.pathname = '/t/tenant-b/controls';
        render(<Shell />);
        await openPaletteAndType('bar');
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((c) => c.url.startsWith('/api/t/tenant-b/'))).toBe(
            true,
        );
    });
});
