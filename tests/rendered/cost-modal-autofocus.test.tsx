/**
 * The cost modal autofocuses its Amount field 60ms after opening.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `CostEntryFormModal.tsx:459` is
 *
 *     const focusTimer = setTimeout(() => setFocus('amount'), 60);
 *     return () => clearTimeout(focusTimer);
 *
 * Nothing asserted that callback. It ran only when a test happened to outlive
 * 60ms before cleanup called `clearTimeout` — so whether it appeared in the
 * coverage map depended on how busy the machine was.
 *
 * That made it one of the last files where the SHARDED coverage job and the
 * unsharded reference run disagreed, and it is the clearest possible evidence
 * of the problem: across two parity runs the difference FLIPPED DIRECTION —
 * run 1 had the reference covering it and the shard not, run 3 the reverse.
 * A coverage number that changes because a runner was busy is not a
 * measurement.
 *
 * Two sibling cases were fixed the same way (audit-stream's 5-second periodic
 * flush, filter-context's bare-pathname arm) and neither has recurred. The fix
 * is never a tolerance in the parity differ — it is a test, because each of
 * these turned out to be real behaviour nobody had pinned.
 *
 * WHAT THIS DOES NOT ASSERT: an exact 59-vs-60ms boundary. Measured in jsdom,
 * the callback fires at 60ms but focus settles slightly later, because the Radix
 * dialog runs its own focus management after ours. Coverage of line 459 is
 * verified (fn hits 2), which is the point; pinning a millisecond this
 * environment does not guarantee would be a flaky test dressed as a precise one.
 *
 * VIEWPORT: asserted on DESKTOP explicitly. `tests/rendered/setup.ts` answers
 * `matches: false` to every media query, which resolves to a PHONE, and this
 * modal's layout differs by breakpoint. Stating it here so the next reader does
 * not have to infer which branch ran.
 */
import * as React from 'react';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
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
    usePathname: () => '/t/acme/grain/costs',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantCurrencySymbol: () => '€',
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { CostEntryFormModal } from '@/app/t/[tenantSlug]/(app)/grain/costs/CostEntryFormModal';

const AMOUNT_INPUT_ID = 'cost-amount-input';

function renderModal(open: boolean) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    return render(
        <QueryClientProvider client={client}>
            <NextIntlClientProvider locale="en" messages={enMessages}>
                <TooltipProvider>
                    <CostEntryFormModal
                        open={open}
                        setOpen={jest.fn()}
                        tenantSlug="acme"
                    />
                </TooltipProvider>
            </NextIntlClientProvider>
        </QueryClientProvider>,
    );
}

describe('CostEntryFormModal — deferred autofocus', () => {
    beforeEach(() => {
        setViewport('desktop');
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
        restoreViewport();
    });

    it('focuses the Amount field after the deferred-focus timer runs', async () => {
        renderModal(true);

        const amount = document.getElementById(AMOUNT_INPUT_ID);
        expect(amount).not.toBeNull();
        expect(document.activeElement).not.toBe(amount);

        // Deliberately advanced well past the 60ms timer rather than to it
        // exactly. Measured in jsdom: the callback fires at 60ms, but focus
        // settles slightly later because the Radix dialog runs its own focus
        // management after ours. Asserting an exact boundary would be asserting
        // something this environment does not actually guarantee.
        await act(async () => {
            jest.advanceTimersByTime(250);
        });

        expect(document.activeElement).toBe(amount);
    });

    it('cancels the pending focus on unmount', async () => {
        // The cleanup `clearTimeout` is what keeps the deferral benign; without
        // it the callback would fire against an unmounted form.
        const { unmount } = renderModal(true);
        expect(document.getElementById(AMOUNT_INPUT_ID)).not.toBeNull();

        unmount();
        await act(async () => {
            jest.advanceTimersByTime(250);
        });

        // The node is gone, so activeElement falls back to <body>.
        expect(document.activeElement).toBe(document.body);
    });
});
