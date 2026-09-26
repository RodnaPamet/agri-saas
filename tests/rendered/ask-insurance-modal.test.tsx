/**
 * Insurance quote requests survive a navigation.
 *
 * Issue #664 — the sibling of #651, and the same defect: `AskInsuranceModal`
 * recorded "sent" in a component-local `useState(false)` whose only consumer
 * was `disabled={sent}`. It died on unmount.
 *
 * The harm was never a duplicate row. It is one layer up: the operator is
 * invited to retype a quote request, and is then shown a raw English server
 * string in a UI that defaults to Bulgarian.
 *
 * This docblock used to say Postgres refused the second write, because
 * `InsuranceLead` carried `@@unique([parcelId, inquirerTenantId])` and
 * `createInsuranceLead` turned the P2002 into a 409. That unique was DROPPED on
 * 2026-09-24 precisely so a farmer can re-ask with a corrected land size, and
 * the sentence survived the change it was describing. What collapses a retry
 * now is idempotency on an explicit `Idempotency-Key` (#1119) — which is a
 * different mechanism with a different guarantee: it de-duplicates the SAME
 * request without ever refusing a genuinely new one.
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
    useTenantCurrencySymbol: () => '€',
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
                    parcelName="North Block"
                    risk={RISK}
                    hasRequested={hasRequested}
                    onRequested={onRequested}
                />
            </TooltipProvider>,
        ),
    };
}

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

    it('still offers the trigger when a lead exists — re-asking is allowed', () => {
        // This test used to assert the OPPOSITE, and it kept passing through
        // the change that reversed the behaviour: it checked only that no
        // button carried the FIRST-ASK label, and the re-ask button carries a
        // different one. A blind assertion, and exactly the shape that lets a
        // behaviour change land unnoticed.
        //
        // The behaviour itself changed when the unique on
        // (parcelId, inquirerTenantId) was dropped so a farmer can re-ask with
        // a corrected land size. Suppressing the trigger would make that
        // unreachable from the UI.
        mount(true);
        expect(screen.getByRole('button', { name: COPY.askAgain })).toBeInTheDocument();
        // …and the farmer is still told they have asked before.
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
    });

    it('offers the FIRST-ask label when no lead exists', () => {
        // The other half, so the two labels cannot silently collapse into one.
        mount(false);
        expect(screen.getByRole('button', { name: COPY.open })).toBeInTheDocument();
        expect(screen.queryByText(COPY.sent)).not.toBeInTheDocument();
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

describe('AskInsuranceModal — what one tap opens', () => {
    const QUOTE = enMessages.ag.risk.quote;

    it('goes straight to step 1 of the calculator, with nothing in between', async () => {
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));

        // Step 1's question is the drawer heading. ONE tap reaches it: no
        // message box, no confirmation, no intermediate screen.
        expect(await screen.findByText(QUOTE.step1Title)).toBeInTheDocument();
    });

    it('no longer shows the message-only form the calculator replaced', async () => {
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        await screen.findByText(QUOTE.step1Title);

        // The old body was a single required Textarea and a Send button. If
        // either reappears here, the calculator has been bypassed.
        expect(screen.queryByPlaceholderText(COPY.messagePlaceholder)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: COPY.submit })).not.toBeInTheDocument();
    });

    it('opens on step 1 even when the satellite read failed (risk: null)', async () => {
        // The calculator uses no reading, so a cloudy week must not cost the
        // farmer a quote. This is the regression guard for moving the trigger
        // out of FarmRiskClient's `risk ? … : unavailable` branch.
        render(
            <TooltipProvider delayDuration={0}>
                <AskInsuranceModal
                    parcelId="parcel-1"
                    locationId="loc-1"
                    parcelName="North Block"
                    risk={null}
                    hasRequested={false}
                    onRequested={jest.fn()}
                />
            </TooltipProvider>,
        );
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        expect(await screen.findByText(QUOTE.step1Title)).toBeInTheDocument();
    });
});
