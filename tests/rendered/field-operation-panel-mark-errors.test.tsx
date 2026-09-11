/** @jest-environment jsdom */
/**
 * A failed parcel mark must SAY what happened — and say the right thing.
 *
 * `mark` ended `catch (err) { haptic('error'); throw err; }` and every caller
 * is a bare `onClick={() => mark(...)}`, so the rejection was unhandled:
 * nothing in the app listens (the only `unhandledrejection` handler ignores
 * anything that is not a ChunkLoadError). The row stayed PENDING and the whole
 * story an operator got was A BUZZ.
 *
 * The common failure is NOT offline. A MECHANISATOR can open the locations
 * page, the Operations tab renders this panel, and the list is not filtered by
 * assignee — so tapping Done on a COLLEAGUE'S job 403s while fully online.
 * "Try again" would be a lie there.
 *
 * And a timeout must never say "unchanged": a successful mark stamps
 * `completedAt`, which is the printed Дата in the БАБХ ДНЕВНИК. Telling
 * someone to retry a write that landed moves a regulatory date.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';

// next-intl's `t` carries `.has()` and `.rich()`; the component calls `.has`.
// A bare arrow is a double too SMALL for the code under test — it throws before
// any assertion runs, which at least fails loudly rather than passing green.
jest.mock('next-intl', () => ({
    useTranslations: () => Object.assign((key: string) => key, {
        has: () => false,
        rich: (key: string) => key,
        raw: (key: string) => key,
        markup: (key: string) => key,
    }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));
jest.mock('@/components/ui/map/MapCanvas', () => ({ MapCanvas: () => <div data-testid="map" /> }));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn(), playSound: jest.fn() }), { virtual: true });

const apiPatch = jest.fn();
const { ApiClientError, API_OFFLINE_CODE, API_TIMEOUT_CODE } = jest.requireActual('@/lib/api-client');
jest.mock('@/lib/api-client', () => {
    const actual = jest.requireActual('@/lib/api-client');
    return { ...actual, apiPatch: (...a: unknown[]) => apiPatch(...a) };
});

const mutate = jest.fn(async () => undefined);
const swrData = {
    task: { id: 't1', title: 'Spray north', status: 'OPEN' },
    lines: [{ id: 'line-1', status: 'PENDING', parcel: { id: 'p1', name: 'Block A' }, doseValue: 2 }],
    parcels: [], location: null, progress: { total: 1, done: 0 },
};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: swrData, isLoading: false, mutate }),
}));

import { FieldOperationPanel } from '@/components/ui/map/FieldOperationPanel';

async function tapDone() {
    await act(async () => { render(<FieldOperationPanel taskId="t1" />); });
    await act(async () => { fireEvent.click(screen.getByText('fieldOp.done')); });
}

beforeEach(() => { apiPatch.mockReset(); mutate.mockClear(); });

describe('a failed mark explains itself', () => {
    it('403 says it is not your job — never "try again"', async () => {
        // The everyday case, and the one the naive fix got wrong. Retrying can
        // never succeed, so instructing a retry sends an operator into a loop.
        apiPatch.mockRejectedValue(new ApiClientError('Forbidden', 'FORBIDDEN', 403));
        await tapDone();
        expect(screen.getByRole('alert')).toHaveTextContent('fieldOp.markForbidden');
    });

    it('offline promises nothing was saved', async () => {
        apiPatch.mockRejectedValue(new ApiClientError('No connection', API_OFFLINE_CODE, 0));
        await tapDone();
        expect(screen.getByRole('alert')).toHaveTextContent('fieldOp.markOffline');
    });

    it('a TIMEOUT does not claim the parcel is unchanged', async () => {
        // The request may have landed. Claiming "unchanged" invites a re-mark,
        // and a re-mark moves completedAt — the printed compliance date.
        apiPatch.mockRejectedValue(new ApiClientError('Too slow', API_TIMEOUT_CODE, 0));
        await tapDone();
        expect(screen.getByRole('alert')).toHaveTextContent('fieldOp.markTimeout');
    });

    it('anything else gets the generic retryable message', async () => {
        apiPatch.mockRejectedValue(new ApiClientError('Boom', 'INTERNAL', 500));
        await tapDone();
        expect(screen.getByRole('alert')).toHaveTextContent('fieldOp.markFailed');
    });

    it('CONTROL: a successful mark shows NO alert', async () => {
        // Without this every assertion above holds for a panel that shows an
        // error banner permanently.
        apiPatch.mockResolvedValue({});
        await tapDone();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('the failure does not escape as an unhandled rejection', async () => {
        // The original defect: `throw err` into a bare onClick. If it came
        // back, this would reject out of the click handler.
        apiPatch.mockRejectedValue(new ApiClientError('Forbidden', 'FORBIDDEN', 403));
        const onUnhandled = jest.fn();
        window.addEventListener('unhandledrejection', onUnhandled);
        await tapDone();
        window.removeEventListener('unhandledrejection', onUnhandled);
        expect(onUnhandled).not.toHaveBeenCalled();
    });
});
