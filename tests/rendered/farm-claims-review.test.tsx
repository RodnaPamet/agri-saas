/**
 * The farm-claim review console — #2963.
 *
 * The properties asserted here are the ones that are invisible when broken:
 *
 *   - **there is no approve-without-typing.** `verifyFarmClaim` takes the ЕИК
 *     the reviewer found in the register and never reads it from the row, so a
 *     one-click approve would let somebody promote a claim without doing the
 *     lookup. The control is a FIELD, and Verify is inert until it has a value.
 *   - **`EIK_MISMATCH` and `DISPUTED_COLLISION` read differently.** The first
 *     is a retryable typo; the second means two farms claim one ЕИК and needs a
 *     decision between them. One "could not verify" message would attach the
 *     wrong remedy to the second.
 *   - **refusing is no harder than approving.** The dispute control exists
 *     (owner ruling 2026-11-10), opens a form rather than acting, and requires
 *     a reason — because both it and the collision case leave `status =
 *     DISPUTED` and the row cannot otherwise say which happened.
 *   - **no ЕИК is displayed anywhere**, because none is held: the claim stores
 *     a blind index, and showing it would turn verification into transcription.
 *
 * Both viewports, because `tests/rendered/setup.ts` answers `matches: false`
 * to every query and the app is a PHONE by default.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'bg',
}));

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/platform/admin/farm-claims',
    useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: jest.fn(),
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiPut: jest.fn(),
    apiDelete: jest.fn(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/platform${p}`,
    useTenantHref: () => (p: string) => `/t/platform${p}`,
}));

const tenantSwr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => tenantSwr(...a),
}));

import { FarmClaimsReviewClient } from '@/app/t/[tenantSlug]/(app)/admin/farm-claims/FarmClaimsReviewClient';

function claim(over: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'c-1',
        tenantId: 't-1',
        tenantName: 'Acme Farm',
        tenantSlug: 'acme',
        status: 'PENDING',
        claimedByUserId: 'u-1',
        createdAt: '2026-10-13T00:00:00.000Z',
        verifiedAt: null,
        disputedAt: null,
        ...over,
    };
}

function mount(claims: unknown[]) {
    const mutate = jest.fn();
    tenantSwr.mockImplementation(() => ({
        data: { claims }, error: undefined, isLoading: false, mutate,
    }));
    return { mutate, ...render(<FarmClaimsReviewClient tenantSlug="platform" />) };
}

beforeEach(() => {
    apiPost.mockReset();
    tenantSwr.mockReset();
});
afterEach(restoreViewport);

describe('the review console', () => {
    for (const viewport of ['mobile', 'desktop'] as const) {
        it(`${viewport}: a PENDING claim gets an ЕИК field, not an approve button`, () => {
            setViewport(viewport);
            mount([claim()]);
            expect(screen.getByLabelText('eikLabel')).toBeInTheDocument();
            // Inert until the reviewer has typed something. A clickable
            // Verify with an empty field is an approve button wearing a
            // field's clothes.
            expect(screen.getByRole('button', { name: 'verify' })).toBeDisabled();
        });
    }

    it('enables Verify once an ЕИК is typed', async () => {
        setViewport('desktop');
        mount([claim()]);
        // The CONTROL for the case above: if the button were disabled
        // unconditionally, that assertion would pass and the console would be
        // unusable.
        await userEvent.type(screen.getByLabelText('eikLabel'), '831391785');
        expect(screen.getByRole('button', { name: 'verify' })).toBeEnabled();
    });

    it('sends the typed ЕИК and no reviewer name', async () => {
        setViewport('desktop');
        apiPost.mockResolvedValue({ result: 'VERIFIED' });
        mount([claim()]);

        await userEvent.type(screen.getByLabelText('eikLabel'), '831391785');
        await userEvent.click(screen.getByRole('button', { name: 'verify' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [path, body] = apiPost.mock.calls[0]!;
        expect(path).toBe('/api/t/platform/admin/farm-claims/c-1/verify');
        expect(body).toEqual({ eik: '831391785' });
        // Attribution comes from the SESSION server-side. A client that sent a
        // reviewer name would be offering the forgery the keyed door allows.
        expect(Object.keys(body as object)).not.toContain('reviewedBy');
    });

    it('renders EIK_MISMATCH and DISPUTED_COLLISION DIFFERENTLY', async () => {
        setViewport('desktop');
        // The two a reviewer must tell apart. Driven through the error path,
        // because the server answers 422 and 409 — a client that only read
        // successes would show the same "failed" for both.
        apiPost.mockRejectedValue({ body: { result: 'EIK_MISMATCH' } });
        const first = mount([claim()]);
        await userEvent.type(screen.getByLabelText('eikLabel'), '111111111');
        await userEvent.click(screen.getByRole('button', { name: 'verify' }));
        await waitFor(() => expect(screen.getByText('outcome.EIK_MISMATCH')).toBeInTheDocument());
        expect(screen.queryByText('outcome.DISPUTED_COLLISION')).not.toBeInTheDocument();
        first.unmount();

        apiPost.mockRejectedValue({ body: { result: 'DISPUTED_COLLISION' } });
        mount([claim()]);
        await userEvent.type(screen.getByLabelText('eikLabel'), '222222222');
        await userEvent.click(screen.getByRole('button', { name: 'verify' }));
        await waitFor(() =>
            expect(screen.getByText('outcome.DISPUTED_COLLISION')).toBeInTheDocument(),
        );
        expect(screen.queryByText('outcome.EIK_MISMATCH')).not.toBeInTheDocument();
    });

    it('REVALIDATES after a collision, because the row it shows is now stale', async () => {
        setViewport('desktop');
        apiPost.mockRejectedValue({ body: { result: 'DISPUTED_COLLISION' } });
        const { mutate } = mount([claim()]);

        await userEvent.type(screen.getByLabelText('eikLabel'), '222222222');
        await userEvent.click(screen.getByRole('button', { name: 'verify' }));

        // A collision CHANGES this claim's status to DISPUTED. A queue still
        // showing PENDING invites a second attempt that cannot succeed.
        await waitFor(() => expect(mutate).toHaveBeenCalled());
    });

    it('does NOT revalidate after a plain mismatch', async () => {
        setViewport('desktop');
        apiPost.mockRejectedValue({ body: { result: 'EIK_MISMATCH' } });
        const { mutate } = mount([claim()]);

        await userEvent.type(screen.getByLabelText('eikLabel'), '111111111');
        await userEvent.click(screen.getByRole('button', { name: 'verify' }));
        await waitFor(() => expect(screen.getByText('outcome.EIK_MISMATCH')).toBeInTheDocument());

        // The CONTROL for the case above: nothing changed server-side, so a
        // refetch would be noise — and if the client revalidated on every
        // refusal, that test would pass while saying nothing about collisions.
        expect(mutate).not.toHaveBeenCalled();
    });

    it('offers DISPUTE, and it opens a form rather than acting', async () => {
        setViewport('desktop');
        mount([claim()]);

        expect(screen.queryByLabelText('reasonLabel')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'dispute' }));

        expect(screen.getByLabelText('reasonLabel')).toBeInTheDocument();
        // Nothing sent yet. A dispute button that acted on first click would
        // record a verdict with no grounds.
        expect(apiPost).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'confirmDispute' })).toBeDisabled();
    });

    it('sends a dispute with its reason once one is typed', async () => {
        setViewport('desktop');
        apiPost.mockResolvedValue({ result: 'DISPUTED' });
        mount([claim()]);

        await userEvent.click(screen.getByRole('button', { name: 'dispute' }));
        await userEvent.type(screen.getByLabelText('reasonLabel'), 'друго дружество');
        await userEvent.click(screen.getByRole('button', { name: 'confirmDispute' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [path, body] = apiPost.mock.calls[0]!;
        expect(path).toBe('/api/t/platform/admin/farm-claims/c-1/dispute');
        expect(body).toEqual({ reason: 'друго дружество' });
    });

    it('says the reason is not shown to the farm', async () => {
        setViewport('desktop');
        mount([claim()]);
        await userEvent.click(screen.getByRole('button', { name: 'dispute' }));
        // The usecase says it and a reviewer cannot know it. Writing the
        // reason as if the farm will read it would be writing for nobody.
        expect(screen.getByText('reasonNotShown')).toBeInTheDocument();
    });

    it('a resolved claim gets NO controls', () => {
        setViewport('desktop');
        mount([claim({ status: 'VERIFIED', verifiedAt: '2026-11-01T00:00:00.000Z' })]);
        expect(screen.queryByLabelText('eikLabel')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'verify' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'dispute' })).not.toBeInTheDocument();
        // The control: the row IS rendered, so the absences above are
        // absences in a populated row rather than in an empty list.
        expect(screen.getByText('Acme Farm')).toBeInTheDocument();
    });

    it('names a deleted farm instead of rendering a blank', () => {
        setViewport('desktop');
        // A claim outlives its farm — `tenantName` is nullable for exactly
        // that — and a blank row reads as a rendering fault.
        mount([claim({ tenantName: null, tenantSlug: null })]);
        expect(screen.getByText('tenantGone')).toBeInTheDocument();
    });

    it('displays NO ЕИК anywhere, because none is held', () => {
        setViewport('desktop');
        mount([claim()]);
        // The claim stores `hashForLookup(eik, 'eik')` and no endpoint returns
        // a number or the hash. If either ever appeared in the payload, this
        // would be the thing that noticed — a console showing the claimed
        // number would turn the check into transcription.
        const body = document.body.textContent ?? '';
        expect(body).not.toMatch(/\b\d{9}\b/);
        expect(body).not.toMatch(/\b\d{13}\b/);
        // The control: the row rendered, so the absence is in real content.
        expect(screen.getByText('Acme Farm')).toBeInTheDocument();
    });

    it('asks the SERVER for the filtered status, not the client', async () => {
        setViewport('desktop');
        mount([claim()]);
        await userEvent.click(screen.getByRole('button', { name: 'status.DISPUTED' }));
        // The filter is a QUERY, not an in-memory predicate: the queue is
        // paginated server-side, so filtering a page here would hide rows the
        // next page holds.
        await waitFor(() =>
            expect(tenantSwr).toHaveBeenCalledWith('/admin/farm-claims?status=DISPUTED'),
        );
    });
});
