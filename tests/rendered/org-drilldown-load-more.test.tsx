/**
 * Epic E — Portfolio drill-down "Load more" behavioural test.
 *
 * Renders the three drill-down tables (controls / risks / evidence)
 * with seeded first-page data + a non-null cursor, mocks `global.fetch`
 * with a deterministic second page, and asserts that:
 *
 *   - the Load-more button surfaces only when nextCursor is non-null
 *   - clicking it calls the canonical API URL
 *     `/api/org/<slug>/portfolio?view=<view>&cursor=<encoded>`
 *   - the response rows are APPENDED (not replaced) — proving the
 *     "browse beyond 50 rows" regression is fixed
 *   - tenant attribution (tenantSlug, tenantName, drillDownUrl)
 *     survives the merge intact for accumulated rows
 *   - the Load-more button disappears when the response's nextCursor
 *     is null
 *   - a non-2xx response surfaces a stable inline error affordance
 *
 * The render path goes through the real DataTable platform — these
 * tests double as a smoke check that the wired-up tables render
 * accumulated rows without breaking the platform.
 *
 * ── Which DataTable branch these exercise ───────────────────────────
 *
 * All three drill-downs are `<DataTable mobileFallback="card">`, and the
 * jsdom default viewport is a PHONE (see `./viewport`) — so the tests
 * below that don't pin a viewport render `<MobileCardList>`, NOT a
 * `<table>`. They still lock the accumulator honestly: every column in
 * all three tables carries a `meta.mobileCard` slot, so the row content
 * they assert on is present in either branch, and the load-more button
 * lives outside the table entirely.
 *
 * What that default DID hide is the desktop `<table>` branch — the
 * claim in the paragraph above was true of the code and false of the
 * test run. `renders accumulated rows as real table rows on a desktop`
 * closes that: it is the only test here that reaches the `<table>`.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { ControlsTable } from '@/app/org/[orgSlug]/(app)/controls/ControlsTable';
import { RisksTable } from '@/app/org/[orgSlug]/(app)/risks/RisksTable';
import { EvidenceTable } from '@/app/org/[orgSlug]/(app)/evidence/EvidenceTable';

import type {
    NonPerformingControlRow,
    CriticalRiskRow,
    OverdueEvidenceRow,
} from '@/app-layer/schemas/portfolio';

import { restoreViewport, setViewport } from './viewport';

// ─── Fixtures ────────────────────────────────────────────────────────

const ORG = 'acme-org';

function controlRow(
    n: number,
    tenant: 'alpha' | 'beta',
): NonPerformingControlRow {
    return {
        controlId: `${tenant}-c-${n}`,
        tenantId: `t-${tenant}`,
        tenantSlug: tenant,
        tenantName: tenant === 'alpha' ? 'Alpha Co' : 'Beta Co',
        name: `${tenant} control ${n}`,
        code: `${tenant.toUpperCase()}-${n}`,
        status: 'NOT_STARTED',
        updatedAt: new Date(2026, 0, n + 1).toISOString(),
        drillDownUrl: `/t/${tenant}/controls/${tenant}-c-${n}`,
    };
}

function riskRow(n: number, tenant: 'alpha' | 'beta'): CriticalRiskRow {
    return {
        riskId: `${tenant}-r-${n}`,
        tenantId: `t-${tenant}`,
        tenantSlug: tenant,
        tenantName: tenant === 'alpha' ? 'Alpha Co' : 'Beta Co',
        title: `${tenant} risk ${n}`,
        inherentScore: 18,
        status: 'OPEN',
        updatedAt: new Date(2026, 0, n + 1).toISOString(),
        drillDownUrl: `/t/${tenant}/risks/${tenant}-r-${n}`,
    };
}

function evidenceRow(n: number, tenant: 'alpha' | 'beta'): OverdueEvidenceRow {
    return {
        evidenceId: `${tenant}-e-${n}`,
        tenantId: `t-${tenant}`,
        tenantSlug: tenant,
        tenantName: tenant === 'alpha' ? 'Alpha Co' : 'Beta Co',
        title: `${tenant} evidence ${n}`,
        nextReviewDate: '2026-02-01',
        daysOverdue: 5 + n,
        status: 'SUBMITTED',
        drillDownUrl: `/t/${tenant}/evidence/${tenant}-e-${n}`,
    };
}

// ─── Fetch stub ──────────────────────────────────────────────────────

interface CannedResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}
function canned(body: unknown, ok = true, status = 200): CannedResponse {
    return { ok, status, json: async () => body };
}

function installFetchStub(): jest.Mock {
    const impl = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = impl;
    return impl;
}

afterEach(() => {
    jest.restoreAllMocks();
    restoreViewport();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('Epic E — controls drill-down load-more', () => {
    it('appends a second page of controls on click and preserves tenant attribution', async () => {
        const fetchImpl = installFetchStub();
        const page1: NonPerformingControlRow[] = [
            controlRow(1, 'alpha'),
            controlRow(2, 'beta'),
        ];
        const page2: NonPerformingControlRow[] = [
            controlRow(3, 'alpha'),
            controlRow(4, 'beta'),
        ];
        fetchImpl.mockResolvedValueOnce(
            canned({ rows: page2, nextCursor: null }),
        );

        render(
            <ControlsTable
                rows={page1}
                nextCursor="cursor-page-2"
                orgSlug={ORG}
            />,
        );

        // Initial render — page-1 rows + Load more visible.
        expect(
            screen.getByTestId(`org-control-link-${page1[0].controlId}`),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId(`org-control-link-${page1[1].controlId}`),
        ).toBeInTheDocument();
        expect(
            screen.queryByTestId(`org-control-link-${page2[0].controlId}`),
        ).toBeNull();
        const loadMore = screen.getByTestId('org-controls-load-more');
        expect(loadMore).toBeInTheDocument();

        const user = userEvent.setup();
        await act(async () => {
            await user.click(loadMore);
        });

        // Canonical API URL.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][0]).toBe(
            `/api/org/${ORG}/portfolio?view=controls&cursor=cursor-page-2`,
        );

        // Both pages now visible — accumulator behaviour.
        for (const row of [...page1, ...page2]) {
            expect(
                screen.getByTestId(`org-control-link-${row.controlId}`),
            ).toBeInTheDocument();
        }

        // Tenant attribution survives the merge for accumulated rows.
        // (At least one cell per tenantSlug from each page.)
        expect(
            screen.getAllByTestId(/org-control-tenant-alpha/),
        ).toHaveLength(2);
        expect(
            screen.getAllByTestId(/org-control-tenant-beta/),
        ).toHaveLength(2);

        // Last page reached → button gone.
        expect(screen.queryByTestId('org-controls-load-more')).toBeNull();
    });

    it('renders accumulated rows as real table rows on a desktop', async () => {
        // The branch every other test in this file misses. On a desktop the
        // drill-down is a `<table>`, so the accumulator has to append TanStack
        // rows that render as `<tr>`s under one `<tbody>` — and the columns
        // the card branch drops (there are none today, but the card slots are
        // opt-in) come back as real `<th>` column headers.
        //
        // Break: a `data={...}` identity bug that re-seeds the table instead
        // of appending shows up here as a row COUNT that never grows, which
        // the testid-presence assertions elsewhere cannot see.
        setViewport('desktop');
        const fetchImpl = installFetchStub();
        const page1 = [controlRow(1, 'alpha'), controlRow(2, 'beta')];
        const page2 = [controlRow(3, 'alpha'), controlRow(4, 'beta')];
        fetchImpl.mockResolvedValueOnce(canned({ rows: page2, nextCursor: null }));

        const { container } = render(
            <ControlsTable rows={page1} nextCursor="cursor-page-2" orgSlug={ORG} />,
        );

        // Desktop really is the table branch, not the card list.
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(document.getElementById('mobile-card-list')).toBeNull();
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);

        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('org-controls-load-more'));
        });
        await screen.findByTestId(`org-control-link-${page2[0].controlId}`);

        // Appended, not replaced — four rows in ONE tbody.
        expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
        // Every row's tenant attribution cell survives the merge.
        const tenantCells = container.querySelectorAll(
            'tbody tr [data-testid^="org-control-tenant-"]',
        );
        expect(tenantCells).toHaveLength(4);
        // The header row the card branch has no equivalent for.
        expect(
            screen.getByRole('columnheader', { name: /Code/i }),
        ).toBeInTheDocument();
    });

    it('hides the Load more button when nextCursor is null on initial render', () => {
        installFetchStub();
        render(
            <ControlsTable
                rows={[controlRow(1, 'alpha')]}
                nextCursor={null}
                orgSlug={ORG}
            />,
        );
        expect(screen.queryByTestId('org-controls-load-more')).toBeNull();
    });

    it('surfaces an inline error when the API returns non-2xx', async () => {
        const fetchImpl = installFetchStub();
        fetchImpl.mockResolvedValueOnce(canned({ error: 'boom' }, false, 500));

        render(
            <ControlsTable
                rows={[controlRow(1, 'alpha')]}
                nextCursor="cursor-page-2"
                orgSlug={ORG}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('org-controls-load-more'));
        });
        expect(screen.getByTestId('org-controls-load-error')).toHaveTextContent(
            /Failed to load more/i,
        );
    });
});

describe('Epic E — risks drill-down load-more', () => {
    it('appends a second page of risks on click', async () => {
        const fetchImpl = installFetchStub();
        const page1 = [riskRow(1, 'alpha'), riskRow(2, 'beta')];
        const page2 = [riskRow(3, 'alpha'), riskRow(4, 'beta')];
        fetchImpl.mockResolvedValueOnce(
            canned({ rows: page2, nextCursor: null }),
        );

        render(
            <RisksTable
                rows={page1}
                nextCursor="cursor-r-page-2"
                orgSlug={ORG}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('org-risks-load-more'));
        });

        expect(fetchImpl.mock.calls[0][0]).toBe(
            `/api/org/${ORG}/portfolio?view=risks&cursor=cursor-r-page-2`,
        );

        for (const row of [...page1, ...page2]) {
            expect(
                screen.getByTestId(`org-risk-link-${row.riskId}`),
            ).toBeInTheDocument();
        }
        expect(screen.queryByTestId('org-risks-load-more')).toBeNull();
    });
});

describe('Epic E — evidence drill-down load-more', () => {
    it('appends a second page of evidence on click', async () => {
        const fetchImpl = installFetchStub();
        const page1 = [evidenceRow(1, 'alpha'), evidenceRow(2, 'beta')];
        const page2 = [evidenceRow(3, 'alpha'), evidenceRow(4, 'beta')];
        fetchImpl.mockResolvedValueOnce(
            canned({ rows: page2, nextCursor: null }),
        );

        render(
            <EvidenceTable
                rows={page1}
                nextCursor="cursor-e-page-2"
                orgSlug={ORG}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('org-evidence-load-more'));
        });

        expect(fetchImpl.mock.calls[0][0]).toBe(
            `/api/org/${ORG}/portfolio?view=evidence&cursor=cursor-e-page-2`,
        );

        for (const row of [...page1, ...page2]) {
            expect(
                screen.getByTestId(`org-evidence-link-${row.evidenceId}`),
            ).toBeInTheDocument();
        }
        expect(screen.queryByTestId('org-evidence-load-more')).toBeNull();
    });
});

describe('Epic E — regression: drill-down can browse beyond the dashboard top-50', () => {
    // The dashboard summary (`getNonPerformingControls` etc.) caps at
    // 50 rows. The dedicated drill-down was paginated server-side from
    // the start, but the original UI replaced rather than accumulated
    // — meaning users saw only one window of 50 at a time. This test
    // walks 3 pages × 50 rows = 150 total rows through the controls
    // table and asserts every controlId is present in the DOM after
    // the third click.
    it('walks 3 pages × 50 rows via Load more — accumulates 150 rows', async () => {
        const fetchImpl = installFetchStub();

        function pageOf(p: number): NonPerformingControlRow[] {
            return Array.from({ length: 50 }, (_, n) => ({
                controlId: `c-p${p}-${n}`,
                tenantId: n % 2 === 0 ? 't-alpha' : 't-beta',
                tenantSlug: n % 2 === 0 ? 'alpha' : 'beta',
                tenantName: n % 2 === 0 ? 'Alpha Co' : 'Beta Co',
                name: `Page ${p} control ${n}`,
                code: `P${p}-${n}`,
                status: 'NOT_STARTED',
                updatedAt: new Date(2026, 0, n + 1).toISOString(),
                drillDownUrl: `/t/${n % 2 === 0 ? 'alpha' : 'beta'}/controls/c-p${p}-${n}`,
            }));
        }

        fetchImpl.mockResolvedValueOnce(
            canned({ rows: pageOf(2), nextCursor: 'cursor-page-3' }),
        );
        fetchImpl.mockResolvedValueOnce(
            canned({ rows: pageOf(3), nextCursor: null }),
        );

        render(
            <ControlsTable
                rows={pageOf(1)}
                nextCursor="cursor-page-2"
                orgSlug={ORG}
            />,
        );

        const user = userEvent.setup();
        // First click → page 2 appends. WAIT for page 2 to actually render
        // before the next click: under parallel-jest load the post-fetch
        // setState (append rows + advance the cursor) can commit AFTER the
        // act() resolves, so a bare getByTestId for the second click would
        // race the re-render (the source of this test's flakiness). findBy*
        // retries until the page-2 rows + the re-rendered Load-more land.
        await act(async () => {
            await user.click(screen.getByTestId('org-controls-load-more'));
        });
        await screen.findByTestId('org-control-link-c-p2-0');

        // Second click → page 3 appends, cursor null.
        await act(async () => {
            await user.click(screen.getByTestId('org-controls-load-more'));
        });
        // Wait for page 3's last row to settle before the bulk assertions.
        await screen.findByTestId('org-control-link-c-p3-49');

        // Every row from all three pages is in the DOM.
        for (const p of [1, 2, 3]) {
            for (let n = 0; n < 50; n++) {
                expect(
                    screen.getByTestId(`org-control-link-c-p${p}-${n}`),
                ).toBeInTheDocument();
            }
        }
        // Last page reached → button gone.
        expect(screen.queryByTestId('org-controls-load-more')).toBeNull();
    });
});
