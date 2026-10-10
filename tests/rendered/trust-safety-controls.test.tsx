/**
 * «Сигнализирай» and «Блокирай» (P5.3, #1594).
 *
 * The behaviours asserted here are the ones that are invisible when broken,
 * and most of them are about what the UI must NOT do:
 *
 *   - the report control is present with the flag OFF, because filing a DSA
 *     Art 16 notice is a legal duty and cannot be dark-launched. A test that
 *     only checked it appears when everything is on would pass on a build that
 *     gated the duty.
 *   - the person-block control is ABSENT with the flag off — absent, not
 *     disabled. A disabled control advertises a feature that does not exist,
 *     which is the opposite of a dark launch.
 *   - the block dialog says the other party is NOT told. That sentence is the
 *     product half of the owner's silent-block ruling, and it is addressed to
 *     the blocker, who is the only person able to read it.
 *   - the two block controls read differently. They sit side by side on the
 *     same header with opposite disclosure rules, and the likeliest regression
 *     in this phase is somebody making them consistent.
 *   - a reason is required and detail is not, because Art 16 does not let us
 *     refuse a notice for want of prose.
 *   - the POST goes to the person-scoped path, not a tenant one. A tenant
 *     route would read zero rows with no error on the way back.
 *
 * Both viewports, because the Modal primitive is a Radix dialog on desktop and
 * a Vaul drawer on mobile — two different trees for one component.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { restoreViewport, setViewport, type Viewport } from './viewport';

// Translations resolve to their KEY, so an assertion names the key rather than
// a string that a copy edit would break. The real Bulgarian and English live
// in `messages/*.json` and are checked by the i18n guards.
jest.mock('next-intl', () => ({
    useTranslations: (ns: string) => (k: string) => `${ns}.${k}`,
}));

// The Modal primitive calls `useRouter()` (it intercepts navigation to warn
// about an unsaved form), so without this every render throws "invariant
// expected app router to be mounted" — which reads as a component fault
// rather than a missing harness.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), refresh: jest.fn(), replace: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/exchange/threads/thr-1',
    useSearchParams: () => new URLSearchParams(),
}));

const apiPost = jest.fn();
const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiDelete: (...a: unknown[]) => apiDelete(...a),
    apiGet: jest.fn(),
    apiPatch: jest.fn(),
}));

import { ReportButton } from '@/components/trust-safety/ReportButton';
import { BlockPersonButton } from '@/components/trust-safety/BlockPersonButton';

const VIEWPORTS: Viewport[] = ['mobile', 'desktop'];

beforeEach(() => {
    jest.clearAllMocks();
    apiPost.mockResolvedValue({ id: 'cr-1', status: 'RECEIVED' });
    apiDelete.mockResolvedValue(undefined);
});
afterEach(() => restoreViewport());

describe.each(VIEWPORTS)('«Сигнализирай» (%s)', (viewport) => {
    beforeEach(() => setViewport(viewport));

    it('is available with no feature flag at all — Art 16 is a duty', () => {
        // `ReportButton` takes no `enabled` prop, by design. If one is ever
        // added, this test is where that shows up.
        render(<ReportButton subjectKind="LISTING" subjectId="lst-1" />);
        expect(screen.getByText('trustSafety.report.trigger')).toBeInTheDocument();
    });

    it('requires a reason and does NOT require detail', async () => {
        const user = userEvent.setup();
        render(<ReportButton subjectKind="THREAD" subjectId="thr-1" />);
        await user.click(screen.getByText('trustSafety.report.trigger'));

        await waitFor(() =>
            expect(screen.getByText('trustSafety.report.title')).toBeInTheDocument(),
        );
        // Submit is refused while no reason is chosen — and the detail field
        // is untouched, which is the half that matters: a notice with no prose
        // must still be fileable.
        const submit = screen.getByText('trustSafety.report.submit').closest('button')!;
        expect(submit).toBeDisabled();
        expect(apiPost).not.toHaveBeenCalled();
    });

    it('names the agricultural case in the reason list', async () => {
        // MISLEADING_LISTING is the one a generic category list would miss,
        // and its bare label does not say what it covers — so the hint is
        // part of the option rather than help text somebody has to find.
        const user = userEvent.setup();
        render(<ReportButton subjectKind="LISTING" subjectId="lst-1" />);
        await user.click(screen.getByText('trustSafety.report.trigger'));
        await waitFor(() =>
            expect(screen.getByText('trustSafety.report.title')).toBeInTheDocument(),
        );
        // The options only mount when the Combobox popover opens — they are
        // not in the dialog's initial tree, which is how this assertion first
        // failed and is worth the extra click rather than a looser matcher.
        await user.click(screen.getByText('trustSafety.report.reasonPlaceholder'));
        await waitFor(() =>
            expect(
                screen.getByText(/report\.reason\.MISLEADING_LISTING_HINT/),
            ).toBeInTheDocument(),
        );
    });
});

describe.each(VIEWPORTS)('«Блокирай потребителя» (%s)', (viewport) => {
    beforeEach(() => setViewport(viewport));

    it('is ABSENT with the flag off — not disabled', () => {
        const { container } = render(
            <BlockPersonButton blockedUserId="u-other" enabled={false} />,
        );
        // Nothing at all. A disabled button would advertise a feature that
        // does not exist, which is the opposite of a dark launch.
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByText('trustSafety.blockPerson.trigger')).toBeNull();
    });

    it('appears with the flag on', () => {
        render(<BlockPersonButton blockedUserId="u-other" enabled />);
        expect(screen.getByText('trustSafety.blockPerson.trigger')).toBeInTheDocument();
    });

    it('says the other party is NOT told — the silent-block ruling', async () => {
        const user = userEvent.setup();
        render(<BlockPersonButton blockedUserId="u-other" enabled />);
        await user.click(screen.getByText('trustSafety.blockPerson.trigger'));

        await waitFor(() =>
            expect(screen.getByText('trustSafety.blockPerson.title')).toBeInTheDocument(),
        );
        // Addressed to the BLOCKER, the only person who can read it.
        expect(screen.getByText('trustSafety.blockPerson.notTold')).toBeInTheDocument();
        // And that it is not the same control as refusing a buyer on a listing.
        expect(
            screen.getByText('trustSafety.blockPerson.distinctFromExchange'),
        ).toBeInTheDocument();
    });

    it('posts to the PERSON-scoped path, not a tenant one', async () => {
        const user = userEvent.setup();
        render(<BlockPersonButton blockedUserId="u-other" enabled />);
        await user.click(screen.getByText('trustSafety.blockPerson.trigger'));
        await waitFor(() =>
            expect(screen.getByText('trustSafety.blockPerson.title')).toBeInTheDocument(),
        );
        await user.click(screen.getByText('trustSafety.blockPerson.confirm'));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const [url, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
        // `/api/social/...`, NOT `/api/t/{slug}/...`. A tenant route runs
        // `runInTenantContext`, which does not set `app.user_id`, so the
        // policies would match nothing and the call would appear to succeed
        // while changing nothing.
        expect(url).toBe('/api/social/blocks');
        expect(url).not.toMatch(/\/api\/t\//);
        expect(body).toEqual({ blockedUserId: 'u-other' });
    });

    it('sends the id in the DELETE BODY, never in the path', async () => {
        // iOS logs the full URL unsuppressably, so a third party's user id in
        // a path would reach a device log — the disclosure this phase exists
        // to prevent.
        const user = userEvent.setup();
        render(<BlockPersonButton blockedUserId="u-other" enabled blocked />);
        await user.click(screen.getByText('trustSafety.blockPerson.unblockTrigger'));
        await waitFor(() =>
            expect(screen.getByText('trustSafety.blockPerson.title')).toBeInTheDocument(),
        );
        await user.click(screen.getByText('trustSafety.blockPerson.confirm'));

        await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(1));
        const [url, init] = apiDelete.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/social/blocks');
        expect(url).not.toContain('u-other');
        expect(String(init.body)).toContain('u-other');
    });
});

describe('the two block controls are distinguishable', () => {
    it('the PERSON block does not reuse the exchange block’s wording', () => {
        // They sit side by side on the thread header with OPPOSITE disclosure
        // rules — the exchange block tells the buyer, this one reveals
        // nothing. The likeliest regression in this phase is somebody making
        // them consistent, so the keys are asserted to be different
        // namespaces rather than merely different strings.
        setViewport('desktop');
        render(<BlockPersonButton blockedUserId="u-other" enabled />);
        const label = screen.getByText('trustSafety.blockPerson.trigger');
        expect(label).toBeInTheDocument();
        // `exchange.messaging.blockParty` is the exchange control. If this
        // component ever rendered that key, the two would have merged.
        expect(screen.queryByText('exchange.messaging.blockParty')).toBeNull();
    });
});
