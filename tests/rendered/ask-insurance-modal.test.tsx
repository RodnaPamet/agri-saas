/**
 * Insurance quote requests survive a navigation.
 *
 * Issue #664 — the sibling of #651, and the same defect: `AskInsuranceModal`
 * recorded "sent" in a component-local `useState(false)` whose only consumer
 * was `disabled={sent}`. It died on unmount.
 *
 * As with the offers modal, the harm is NOT a duplicate request.
 * `InsuranceLead` carries `@@unique([parcelId, inquirerTenantId])` and
 * `createInsuranceLead` turns the P2002 into `conflict('You have already
 * requested a quote for this parcel')`, so Postgres refuses the second write.
 * The harm is one layer up: the operator is invited to retype a quote request
 * and is then shown a raw English server string in a UI that defaults to
 * Bulgarian.
 *
 * What #651 could reuse and this could not: `/offers` is a server component
 * that already loaded the row, so the durable flag was one `select` field.
 * Here **nothing in `src/app-layer` read `InsuranceLead` at all** — the only
 * queries were the retention job's cross-tenant sweep — so the read path had
 * to be built: `listInquiredParcelIds` + `GET /insurance/leads`, fetched ONCE
 * for the page rather than per card.
 *
 * Copy comes from the REAL `messages/en.json` via the project-wide next-intl
 * mock in `tests/rendered/setup.ts`.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import enMessages from '../../messages/en.json';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/farm-risk',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
}));

const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));

const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({
        success: toastSuccess,
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AskInsuranceModal } from '@/app/t/[tenantSlug]/(app)/farm-risk/AskInsuranceModal';

const COPY = enMessages.ag.risk.ask;
const RISK = { overall: 'MEDIUM', ndvi: 0.42, ndmi: 0.31 };

function mount(hasRequested = false, onRequested = jest.fn()) {
    return {
        onRequested,
        ...render(
            <TooltipProvider delayDuration={0}>
                <AskInsuranceModal
                    parcelId="parcel-1"
                    locationId="loc-1"
                    risk={RISK}
                    hasRequested={hasRequested}
                    onRequested={onRequested}
                />
            </TooltipProvider>,
        ),
    };
}

/** `FormField` renders its label as a sibling span, so target the placeholder. */
const messageBox = () => screen.getByPlaceholderText(COPY.messagePlaceholder);

beforeEach(() => {
    setViewport('desktop');
    apiPost.mockReset().mockResolvedValue({ id: 'lead-1', status: 'PENDING' });
    toastSuccess.mockReset();
});

afterEach(() => {
    restoreViewport();
    jest.clearAllMocks();
});

describe('AskInsuranceModal — the sent state', () => {
    it('offers the trigger when nothing has been sent', () => {
        mount(false);
        expect(screen.getByRole('button', { name: COPY.open })).toBeEnabled();
    });

    it('suppresses the trigger when the SERVER says a lead already exists', () => {
        // The regression. Before `hasRequested` this prop did not exist and a
        // fresh mount always offered the button, whatever the database held.
        mount(true);
        expect(screen.queryByRole('button', { name: COPY.open })).not.toBeInTheDocument();
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
    });

    it('survives a remount, which is what a navigation is', () => {
        const { unmount } = mount(true);
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
        unmount();

        // Same server truth, brand-new component instance, brand-new useState.
        mount(true);
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: COPY.open })).not.toBeInTheDocument();
    });

    it('explains why the control is spent, and keeps it focusable', () => {
        mount(true);
        // `disabled` would drop it out of the tab order, putting the reason
        // out of reach of the users most likely to need it.
        expect(screen.getByText(COPY.sent)).toHaveAttribute('tabindex', '0');
    });
});

describe('AskInsuranceModal — sending', () => {
    it('POSTs the parcel, risk snapshot and message, then confirms', async () => {
        const { onRequested } = mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        await userEvent.type(messageBox(), 'Hail cover for this block');
        await userEvent.click(screen.getByRole('button', { name: COPY.submit }));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(apiPost.mock.calls[0][1]).toMatchObject({
            parcelId: 'parcel-1',
            locationId: 'loc-1',
            message: 'Hail cover for this block',
            risk: RISK,
        });

        // The modal closing is what Cancel does too, so it is not by itself a
        // confirmation.
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
        // …and the page-level server read is refreshed, so the durable flag
        // catches up rather than relying on the optimistic one forever.
        expect(onRequested).toHaveBeenCalledTimes(1);
        expect(await screen.findByText(COPY.sent)).toBeInTheDocument();
    });

    it('leaves the modal open and shows the error when the POST fails', async () => {
        apiPost.mockRejectedValueOnce(
            new Error('You have already requested a quote for this parcel'),
        );
        const { onRequested } = mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        await userEvent.type(messageBox(), 'Anything');
        await userEvent.click(screen.getByRole('button', { name: COPY.submit }));

        expect(
            await screen.findByText('You have already requested a quote for this parcel'),
        ).toBeInTheDocument();
        expect(screen.queryByText(COPY.sent)).not.toBeInTheDocument();
        expect(toastSuccess).not.toHaveBeenCalled();
        // No refresh on a failed write — there is nothing new to read.
        expect(onRequested).not.toHaveBeenCalled();
    });

    it('does not carry the drafted message across a cancel', async () => {
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        await userEvent.type(messageBox(), 'Draft text');
        await userEvent.click(screen.getByRole('button', { name: COPY.cancel }));

        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        expect(messageBox()).toHaveValue('');
    });
});
