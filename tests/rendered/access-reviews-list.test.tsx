/**
 * Epic G-4 — Access reviews list page render test.
 *
 *   1. Renders the title + create button.
 *   2. Renders one CARD per campaign on a phone and one table ROW per
 *      campaign on a desktop — both with the detail-page link, and the
 *      desktop branch with the progress column header. (Two viewports
 *      because `<DataTable mobileFallback="card">` renders only ONE of
 *      the two, and the jsdom default is a phone.)
 *   3. Empty state renders when no campaigns exist.
 *   4. Truncation banner renders when the backfill cap fired.
 *   5. Clicking "New campaign" opens the create modal.
 */
import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/access-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
}));

import { AccessReviewsClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient';

function withClient(ui: React.ReactNode) {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const sample = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'rev_1',
        name: 'Q1 access review',
        scope: 'ALL_USERS' as const,
        status: 'OPEN' as const,
        periodStartAt: null,
        periodEndAt: null,
        dueAt: null,
        closedAt: null,
        createdAt: new Date('2026-04-01').toISOString(),
        reviewerUserId: 'usr_reviewer',
        createdByUserId: 'usr_creator',
        _count: { decisions: 4 },
        ...overrides,
    });

describe('AccessReviewsClient', () => {
    afterEach(restoreViewport);

    beforeEach(() => {
        // Provide a non-pending fetch so the SWR hook hydrates with
        // initialData rather than spinning.
        (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ rows: [], truncated: false }),
        }));
    });

    const twoCampaigns = () =>
        render(
            withClient(
                <AccessReviewsClient
                    tenantSlug="acme"
                    initialReviews={[
                        sample({ id: 'rev_1', name: 'Q1' }),
                        sample({ id: 'rev_2', name: 'Q2', status: 'IN_REVIEW' }),
                    ]}
                />,
            ),
        );

    it('renders title and create-button', () => {
        twoCampaigns();
        expect(screen.getByTestId('access-reviews-title')).toBeTruthy();
        expect(screen.getByTestId('access-review-new-campaign-button')).toBeTruthy();
    });

    it('renders one CARD per campaign on a phone, each linking to its detail page', () => {
        // The jsdom default viewport is a phone (see `./viewport`), and
        // `AccessReviewsClient` is a `<DataTable mobileFallback="card">` — so
        // this, not the table, is the branch a default-viewport render
        // reaches. Pinned explicitly rather than inherited.
        //
        // This replaces a pair of `getByTestId('access-review-row-<id>')`
        // assertions that could not fail: those testids belong to a
        // `<div hidden>` sidecar of empty <span>s that `AccessReviewsClient`
        // renders ALONGSIDE the DataTable purely for tests. The sidecar is
        // present whether the table renders, the cards render, or neither —
        // so "one row per campaign" was asserted against markup that is not
        // a row and never was.
        setViewport('mobile');
        twoCampaigns();

        expect(screen.queryByRole('table')).toBeNull();
        // Scoped to the card list by id — the page header's breadcrumb is
        // also an <ol>, so a bare getByRole('list') matches two elements.
        const cardList = document.getElementById('mobile-card-list')!;
        expect(cardList).not.toBeNull();
        const cards = within(cardList).getAllByRole('listitem');
        expect(cards).toHaveLength(2);

        // The campaign name is the card title slot, and carries the Link.
        expect(
            within(cards[0]).getByRole('link', { name: 'Q1' }),
        ).toHaveAttribute('href', '/t/acme/access-reviews/rev_1');
        expect(
            within(cards[1]).getByRole('link', { name: 'Q2' }),
        ).toHaveAttribute('href', '/t/acme/access-reviews/rev_2');
        // The status column is the card's status slot.
        expect(within(cards[1]).getByText('IN_REVIEW')).toBeInTheDocument();
    });

    it('renders one table ROW per campaign on a desktop, with the progress column', () => {
        // The branch the original test was written for and never reached.
        // `progress` and `period` have no card slot in the desktop sense —
        // the card shows progress as a key/value meta row while the table
        // shows it as its own column under a real `<th>`.
        setViewport('desktop');
        twoCampaigns();

        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(document.getElementById('mobile-card-list')).toBeNull();
        // Two body rows (getAllByRole('row') would also count the header).
        expect(document.querySelectorAll('tbody tr')).toHaveLength(2);

        const rowQ1 = screen.getByText('Q1').closest('tr')!;
        expect(rowQ1).not.toBeNull();
        expect(
            within(rowQ1).getByRole('link', { name: 'Q1' }),
        ).toHaveAttribute('href', '/t/acme/access-reviews/rev_1');
        // Column headers exist only in this branch. i18n is key-echoing in
        // this file's next-intl mock, so the header renders as its key.
        expect(
            screen.getByRole('columnheader', { name: 'colProgress' }),
        ).toBeInTheDocument();
    });

    it('renders empty state when there are no campaigns', () => {
        render(
            withClient(
                <AccessReviewsClient tenantSlug="acme" initialReviews={[]} />,
            ),
        );
        expect(screen.getByTestId('access-reviews-empty')).toBeTruthy();
    });

    it('clicking New campaign opens the create modal', () => {
        render(
            withClient(
                <AccessReviewsClient tenantSlug="acme" initialReviews={[]} />,
            ),
        );
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        expect(screen.getByTestId('access-review-new-name')).toBeTruthy();
        expect(screen.getByTestId('access-review-new-reviewer')).toBeTruthy();
        expect(screen.getByTestId('access-review-new-submit')).toBeTruthy();
    });

    it('scope radios: default is checked and clicking a label switches selection', () => {
        render(
            withClient(
                <AccessReviewsClient tenantSlug="acme" initialReviews={[]} />,
            ),
        );
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));

        const allUsers = document.getElementById('access-review-scope-ALL_USERS')!;
        const adminOnly = document.getElementById('access-review-scope-ADMIN_ONLY')!;
        // Default scope (ALL_USERS) renders CHECKED — the bug report was
        // a blank radio group (neither selected) + unclickable rows.
        expect(allUsers.getAttribute('data-state')).toBe('checked');
        expect(adminOnly.getAttribute('data-state')).toBe('unchecked');

        // Clicking the LABEL (htmlFor → id) must switch the selection —
        // the previous label-wrapped form didn't associate the control.
        // i18n: useTranslations is mocked to echo the key, so the scope
        // label renders as its message key.
        fireEvent.click(screen.getByText('scopeAdminOnly'));
        expect(adminOnly.getAttribute('data-state')).toBe('checked');
        expect(allUsers.getAttribute('data-state')).toBe('unchecked');
    });

    it('create-modal shows error when name + reviewer are missing', () => {
        render(
            withClient(
                <AccessReviewsClient tenantSlug="acme" initialReviews={[]} />,
            ),
        );
        fireEvent.click(screen.getByTestId('access-review-new-campaign-button'));
        fireEvent.click(screen.getByTestId('access-review-new-submit'));
        expect(screen.getByTestId('access-review-new-error').textContent).toMatch(
            /required/i,
        );
    });
});
