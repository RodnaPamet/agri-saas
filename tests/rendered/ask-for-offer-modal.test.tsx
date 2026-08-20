/**
 * Offer inquiry — the "Request sent" state must survive a remount, and the
 * consent tick must not.
 *
 * Issue #651. `AskForOfferModal` recorded "sent" in a component-local
 * `useState(false)` whose only consumer was `disabled={sent}`. It died on
 * unmount, so navigating away and back re-enabled the button.
 *
 * The issue framed the harm as "the operator can re-send". At the data layer
 * that is not what happens — `PromotionLead` carries
 * `@@unique([promotionId, inquirerTenantId])` and `createPromotionLead`
 * converts the P2002 into a 409, so Postgres refuses the second write. The
 * real harm is one layer up and worse than a duplicate: the operator is
 * invited to retype a whole message and re-tick a consent box, and is then
 * shown a raw English server string in a UI that defaults to Bulgarian.
 *
 * What this file locks:
 *
 *   1. **`hasRequested` (server-read) suppresses the trigger across a
 *      remount.** This is the actual fix. A test that only drove the
 *      optimistic flag would pass against the old code.
 *   2. **The optimistic flag still works within one mount**, so the fix did
 *      not trade a live confirmation for a page refresh.
 *   3. **Consent does not survive a close.** `consentedAt` is the lawfulness
 *      record; a tick left over from an abandoned attempt would be a consent
 *      the operator did not knowingly give on the next open. The old comment
 *      claimed this already happened. Nothing implemented it.
 *   4. **The consent label renders real copy**, not the literal key path.
 *      `ag.offers.ask.consent` and `.privacyLink` existed in neither locale,
 *      so next-intl rendered the key. No i18n guard caught it, because they
 *      all compare en↔bg and the key was missing from both (see #662).
 *
 * Copy comes from the REAL `messages/en.json` via the project-wide next-intl
 * mock in `tests/rendered/setup.ts`, so these assertions are byte-identical
 * to production output.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import enMessages from '../../messages/en.json';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/offers',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantName: 'Acme Farms',
        tenantSlug: 'acme',
        currencySymbol: '€',
    }),
}));

const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiPost: (...args: unknown[]) => apiPost(...args),
}));

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
import { AskForOfferModal } from '@/app/t/[tenantSlug]/(app)/offers/AskForOfferModal';

const COPY = enMessages.ag.offers.ask;
const COMPANY = 'AgriChem Ltd';

function mount(hasRequested = false) {
    // `TooltipProvider` is mounted app-wide in `providers.tsx`; the component
    // is only ever rendered under it in production.
    return render(
        <TooltipProvider delayDuration={0}>
            <AskForOfferModal promotionId="promo-1" company={COMPANY} hasRequested={hasRequested} />
        </TooltipProvider>,
    );
}

/**
 * `FormField` renders its label as a sibling `<span>`, not an htmlFor-bound
 * `<label>`, so `getByLabelText` does not reach the textarea. The field is
 * the only textbox in the modal.
 */
function messageBox(): HTMLElement {
    return screen.getByPlaceholderText(COPY.messagePlaceholder);
}

/** The consent label, with the company interpolated the way next-intl does. */
const consentLabel = COPY.consent.replace('{company}', COMPANY);

beforeEach(() => {
    setViewport('desktop');
    apiPost.mockReset().mockResolvedValue({ id: 'lead-1', status: 'PENDING' });
    toastSuccess.mockReset();
});

afterEach(() => {
    restoreViewport();
    jest.clearAllMocks();
});

describe('AskForOfferModal — the sent state', () => {
    it('renders the trigger when nothing has been sent', () => {
        mount(false);
        expect(screen.getByRole('button', { name: COPY.open })).toBeEnabled();
        expect(screen.queryByText(COPY.sent)).not.toBeInTheDocument();
    });

    it('suppresses the trigger when the SERVER says a lead already exists', () => {
        // The regression. Before `hasRequested` this prop did not exist and
        // a fresh mount always rendered an enabled "Ask for offer" button,
        // whatever the database held.
        mount(true);
        expect(screen.queryByRole('button', { name: COPY.open })).not.toBeInTheDocument();
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
    });

    it('survives a remount, which is what a navigation is', () => {
        const { unmount } = mount(true);
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
        unmount();

        // Same server truth, brand-new component instance and brand-new
        // `useState`. The old implementation showed the enabled trigger here.
        mount(true);
        expect(screen.getByText(COPY.sent)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: COPY.open })).not.toBeInTheDocument();
    });

    it('explains WHY the control is spent, and keeps it focusable', () => {
        mount(true);
        const note = screen.getByText(COPY.sent);
        // `disabled` would drop it out of the tab order, putting the reason
        // out of reach of the users most likely to need it.
        expect(note).toHaveAttribute('tabindex', '0');
    });
});

describe('AskForOfferModal — sending', () => {
    it('POSTs, confirms with a toast, and flips optimistically within the mount', async () => {
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));

        await userEvent.type(messageBox(), 'Need 20t of urea');
        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.click(screen.getByRole('button', { name: COPY.submit }));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(apiPost.mock.calls[0][1]).toMatchObject({
            promotionId: 'promo-1',
            message: 'Need 20t of urea',
            consent: true,
        });

        // The modal closing is what Cancel does too, so it is not by itself
        // a confirmation.
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
        expect(await screen.findByText(COPY.sent)).toBeInTheDocument();
    });

    it('leaves the modal open and shows the error when the POST fails', async () => {
        apiPost.mockRejectedValueOnce(new Error('You have already requested an offer for this promotion'));
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        await userEvent.type(messageBox(), 'Anything');
        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.click(screen.getByRole('button', { name: COPY.submit }));

        expect(
            await screen.findByText('You have already requested an offer for this promotion'),
        ).toBeInTheDocument();
        // Not marked sent — the write did not happen.
        expect(screen.queryByText(COPY.sent)).not.toBeInTheDocument();
        expect(toastSuccess).not.toHaveBeenCalled();
    });
});

describe('AskForOfferModal — consent', () => {
    it('renders real copy, not the literal message key', async () => {
        // `ag.offers.ask.consent` existed in neither locale, so next-intl
        // rendered `ag.offers.ask.consent` as the label of a GDPR consent
        // checkbox. Every i18n guard passed, because they compare en↔bg and
        // it was absent from both.
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));

        expect(await screen.findByText(consentLabel, { exact: false })).toBeInTheDocument();
        expect(screen.queryByText(/ag\.offers\.ask\./)).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: COPY.privacyLink })).toBeInTheDocument();
    });

    it('does not carry a tick across a cancel', async () => {
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));

        const box = await screen.findByRole('checkbox');
        await userEvent.click(box);
        expect(box).toBeChecked();

        await userEvent.click(screen.getByRole('button', { name: COPY.cancel }));
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));

        // `consentedAt` is the lawfulness record. A tick surviving an
        // abandoned attempt is consent the operator did not knowingly give.
        expect(await screen.findByRole('checkbox')).not.toBeChecked();
    });

    it('does not carry the drafted message across a cancel either', async () => {
        mount(false);
        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        await userEvent.type(messageBox(), 'Draft text');
        await userEvent.click(screen.getByRole('button', { name: COPY.cancel }));

        await userEvent.click(screen.getByRole('button', { name: COPY.open }));
        expect(messageBox()).toHaveValue('');
    });
});
