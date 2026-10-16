/**
 * Rendered — `LeasePaymentsPanel` discards a superseded lease's response (#1952).
 *
 * The panel is mounted as `{editingId ? <LeasePaymentsPanel leaseId={editingId}
 * …/> : null}` in the Rent editor, so switching straight from lease A to lease
 * B keeps it MOUNTED and changes the prop. Before #1952 both requests were in
 * flight with no guard, and whichever resolved last won — so A's settlements
 * could paint inside B's panel.
 *
 * Nothing in the row shape would reveal that: a row is
 * `{seasonYear} · {amountPaid} · {date}` with no lease id in it, and `loading`
 * has already cleared. A wrong number in a rent register reads as
 * authoritative, which is why this is tested rather than reasoned about.
 */
jest.mock('@/lib/tenant-context-provider', () => {
    // Hoisted so the builder is referentially stable, exactly as the real
    // `useCallback`-memoised hook is — an unstable one would re-fire the
    // loader every render and the race under test would be drowned in noise.
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
        useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
    };
});

jest.mock('next-intl', () => {
    const makeT = () => {
        const t = (key: string) => key;
        t.has = () => false;
        t.rich = (k: string) => k;
        t.markup = (k: string) => k;
        t.raw = (k: string) => k;
        return t;
    };
    return {
        useLocale: () => 'en',
        useTranslations: () => makeT(),
        useFormatter: () => ({
            number: (v: unknown) => String(v),
            dateTime: (v: unknown) => String(v),
            relativeTime: (v: unknown) => String(v),
        }),
    };
});

jest.mock('@/lib/api-client', () => ({ apiPost: jest.fn(), apiDelete: jest.fn() }));

import { act, render, screen, waitFor } from '@testing-library/react';

import { LeasePaymentsPanel } from '@/components/agro/LeasePaymentsPanel';

interface Pending {
    url: string;
    signal: AbortSignal | undefined;
    settle: (payments: unknown[]) => void;
}

let pending: Pending[] = [];

/**
 * Whether an aborted request REJECTS.
 *
 * Real `fetch` rejects with an AbortError when the signal fires before the
 * response lands — but when the response has already arrived and the body is
 * still being read, the abort lands with the promise chain mid-flight and the
 * code reaches its post-await check instead. The two guards sit on those two
 * paths, so a mock that only ever rejects can never exercise one of them.
 *
 * This was not academic: with reject-always, BOTH mutations of the fix passed
 * and these tests had no teeth at all.
 */
let rejectOnAbort = true;

/** A payment row whose AMOUNT identifies which lease it belongs to. */
const payment = (amount: number) => ({
    id: `p-${amount}`,
    seasonYear: 2026,
    amountPaid: amount,
    unit: null,
    paidAt: '2026-03-01T00:00:00.000Z',
    note: null,
});

beforeEach(() => {
    pending = [];
    rejectOnAbort = true;
    global.fetch = jest.fn((input: unknown, init?: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
            const entry: Pending = {
                url: String(input),
                signal: init?.signal,
                settle: (payments) =>
                    resolve({ ok: true, json: async () => ({ payments }) } as Response),
            };
            init?.signal?.addEventListener('abort', () => {
                if (rejectOnAbort) {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }
            });
            pending.push(entry);
        });
    }) as unknown as typeof fetch;
});

/**
 * Drain everything the component could still do.
 *
 * Two `await Promise.resolve()` hops were NOT enough: the rejection chain is
 * `await fetch` → catch → finally → setState → re-render, and asserting
 * before it completed is how both of these tests first passed against a
 * mutated fix. A macrotask turn drains all of it.
 */
async function settleAll(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function renderPanel(leaseId: string) {
    return render(
        <LeasePaymentsPanel leaseId={leaseId} rentUnit={null} canWrite={false} />,
    );
}

describe('LeasePaymentsPanel — a superseded lease cannot win (#1952)', () => {
    it('control: it renders the rows it is given', async () => {
        // Without this the two assertions below could both pass on a panel
        // that renders nothing at all.
        renderPanel('lease-A');
        await waitFor(() => expect(pending).toHaveLength(1));
        pending[0].settle([payment(111)]);
        expect(await screen.findByText(/111/)).toBeInTheDocument();
    });

    it('a late response for the PREVIOUS lease does not paint', async () => {
        // The response arrived before the abort did, so the request does NOT
        // reject — it continues and reaches the post-await check. That is the
        // path this guard is for, and modelling the abort as always-rejecting
        // makes it unreachable.
        rejectOnAbort = false;
        const { rerender } = renderPanel('lease-A');
        await waitFor(() => expect(pending).toHaveLength(1));
        const first = pending[0];
        expect(first.url).toContain('lease-A');

        // The editor switches straight to another lease. The panel stays
        // mounted; only the prop changes.
        rerender(<LeasePaymentsPanel leaseId="lease-B" rentUnit={null} canWrite={false} />);
        await waitFor(() => expect(pending).toHaveLength(2));
        const second = pending[1];
        expect(second.url).toContain('lease-B');

        // B answers first, then A arrives late — the losing order before the
        // guard existed.
        second.settle([payment(222)]);
        expect(await screen.findByText(/222/)).toBeInTheDocument();

        first.settle([payment(111)]);
        // FLUSH, then assert. `waitFor` around a NEGATED assertion passes on
        // its first check — before React has applied the state update it is
        // supposed to be watching for — so it reported success against a
        // build that did paint A's row. Measured: `setRows` ran with the
        // stale payload and this test still passed.
        await settleAll();
        expect(screen.queryByText(/111/)).not.toBeInTheDocument();
        expect(screen.getByText(/222/)).toBeInTheDocument();
    });

    it('an IN-FLIGHT request that is aborted cannot report "no settlements"', async () => {
        // The first request must still be in flight when the switch happens,
        // or there is nothing to abort and this guard is never reached. An
        // earlier version of this test settled it first, so the abort
        // rejected an already-resolved promise — a no-op — and the test
        // passed against a build with the guards removed.
        //
        // Unguarded, the aborted request's `catch` ran `setRows([])` and its
        // `finally` ran `setLoading(false)`. Together those render the
        // empty-state branch: a settlement log reporting NO payments for a
        // lease whose payments have not been fetched yet. A blank log reads
        // as an answer, which is worse than a spinner.
        const { rerender } = renderPanel('lease-A');
        await waitFor(() => expect(pending).toHaveLength(1));
        expect(pending[0].url).toContain('lease-A');
        expect(screen.getByText('loading')).toBeInTheDocument();

        // Switch while A is still unanswered.
        rerender(<LeasePaymentsPanel leaseId="lease-B" rentUnit={null} canWrite={false} />);
        await waitFor(() => expect(pending).toHaveLength(2));
        await settleAll();

        // A's abort has rejected and been swallowed as a supersession.
        expect(screen.getByText('loading')).toBeInTheDocument();
        expect(screen.queryByText('none')).not.toBeInTheDocument();

        pending[1].settle([payment(222)]);
        expect(await screen.findByText(/222/)).toBeInTheDocument();
    });
});
