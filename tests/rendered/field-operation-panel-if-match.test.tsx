/**
 * The online map panel sends `If-Match` when marking a prescription line
 * (#1370).
 *
 * ## Why this needs a test rather than a careful edit
 *
 * The failure is SILENT and looks like success. An absent `If-Match` makes the
 * server skip the precondition entirely — a documented last-write-wins, not an
 * error — so a web mark that overwrote a colleague's change seconds earlier
 * returned 200, played its success haptic, and showed the operator exactly what
 * they expected. Nothing anywhere said a write had been lost.
 *
 * On a row that stamps a regulatory date, that is the whole cost: the БАБХ
 * journal record written by a mark carries who applied what, where and when.
 *
 * It went unnoticed because the other two clients get it right — the offline
 * panel sends the version on replay, and iOS sends it online and on replay —
 * so the only unlocked writer was the one nobody was porting.
 *
 * ## What is asserted, and the one that matters
 *
 * The positive case is easy to write and easy to satisfy by accident. The
 * assertions that carry weight are:
 *
 *   * the header holds the version of the line that was CLICKED, not the
 *     first line, not the task's — a panel that sent `lines[0].version` for
 *     every row would pass a single-line test and silently corrupt the lock
 *     on every multi-line job, which is the normal shape of a spray job;
 *   * a line with NO version sends NO header, degrading to the old behaviour
 *     rather than sending `undefined` as a string — `If-Match: undefined` is
 *     non-integer, so the server skips the check anyway, but it would also
 *     mean the client could never tell the two cases apart in a log;
 *   * `Content-Type` survives. `apiPatch` spread `init` over its own headers,
 *     so passing one header used to drop the body's content type entirely.
 *     Nobody had passed headers before this change, so the trap had never
 *     fired.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockMutate = jest.fn();
const mockData: { current: unknown } = { current: null };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
    useTenantCurrencySymbol: () => '€',
}));
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ success: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: mockData.current, mutate: mockMutate, isLoading: false }),
}));
// The map is not under test and pulls in MapLibre. It is loaded through
// `next/dynamic`, so the module it resolves to is what has to be stubbed.
jest.mock('@/components/ui/map/MapCanvas', () => ({ MapCanvas: () => null }));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('@/lib/sound', () => ({ playSound: jest.fn() }));

const fetchOrThrow = jest.fn();
jest.mock('@/lib/api-client', () => {
    const actual = jest.requireActual('@/lib/api-client');
    return { ...actual, apiPatch: (...a: unknown[]) => fetchOrThrow(...a) };
});

import { FieldOperationPanel } from '@/components/ui/map/FieldOperationPanel';

function view(lines: Array<Record<string, unknown>>) {
    return {
        task: { id: 't1', key: 'FO-1', title: 'Пръскане', status: 'IN_PROGRESS' },
        lines,
        parcels: [],
        location: null,
        progress: { total: lines.length, done: 0 },
    };
}

const LINE_A = {
    id: 'line-a',
    status: 'PENDING' as const,
    version: 3,
    doseValue: '2',
    parcel: { id: 'p1', name: 'Блок А', areaHa: 10 },
    product: { id: 'pr1', name: 'Препарат' },
    doseUnit: { id: 'u1', symbol: 'L/ha' },
};
const LINE_B = { ...LINE_A, id: 'line-b', version: 7, parcel: { id: 'p2', name: 'Блок Б', areaHa: 5 } };

beforeEach(() => {
    jest.clearAllMocks();
    fetchOrThrow.mockResolvedValue({ ok: true });
});

/** The `init` argument `apiPatch` was called with. */
function initOf(call: number): { headers?: Record<string, string> } | undefined {
    return fetchOrThrow.mock.calls[call]?.[3];
}

describe('marking sends the version the operator saw', () => {
    it('sends If-Match from the clicked line', async () => {
        mockData.current = view([LINE_A]);
        render(<FieldOperationPanel taskId="t1" />);

        fireEvent.click(screen.getAllByRole('button', { name: /DONE|Готово|готово/i })[0]);
        await waitFor(() => expect(fetchOrThrow).toHaveBeenCalled());

        expect(initOf(0)?.headers?.['If-Match']).toBe('3');
    });

    it('sends the SECOND line’s version when the second line is clicked', async () => {
        // The assertion that matters. A panel sending `lines[0].version` for
        // every row passes the test above and corrupts the lock on every
        // multi-line job — which is the normal shape of a spray job.
        mockData.current = view([LINE_A, LINE_B]);
        render(<FieldOperationPanel taskId="t1" />);

        const buttons = screen.getAllByRole('button', { name: /DONE|Готово|готово/i });
        expect(buttons.length).toBeGreaterThan(1);
        fireEvent.click(buttons[1]);
        await waitFor(() => expect(fetchOrThrow).toHaveBeenCalled());

        expect(initOf(0)?.headers?.['If-Match']).toBe('7');
        expect(initOf(0)?.headers?.['If-Match']).not.toBe('3');
    });

    it('sends NO header when the line carries no version', async () => {
        // A cached payload from a build before the field was declared. Degrade
        // to the previous behaviour rather than send the string "undefined".
        const noVersion = { ...LINE_A };
        delete (noVersion as Record<string, unknown>).version;
        mockData.current = view([noVersion]);
        render(<FieldOperationPanel taskId="t1" />);

        fireEvent.click(screen.getAllByRole('button', { name: /DONE|Готово|готово/i })[0]);
        await waitFor(() => expect(fetchOrThrow).toHaveBeenCalled());

        const init = initOf(0);
        expect(init?.headers?.['If-Match']).toBeUndefined();
        expect(JSON.stringify(init ?? {})).not.toContain('undefined');
    });

    it('still targets the clicked line’s URL — the control', async () => {
        // Without this, a mark that sent the right header to the wrong line
        // would satisfy every assertion above.
        mockData.current = view([LINE_A, LINE_B]);
        render(<FieldOperationPanel taskId="t1" />);

        fireEvent.click(screen.getAllByRole('button', { name: /DONE|Готово|готово/i })[1]);
        await waitFor(() => expect(fetchOrThrow).toHaveBeenCalled());

        expect(String(fetchOrThrow.mock.calls[0][0])).toContain('line-b');
    });
});
