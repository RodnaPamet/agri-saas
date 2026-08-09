/**
 * @jest-environment jsdom
 *
 * Panel-level proof of the operator offline flow (the original "Done"
 * criterion: a job marked with no signal queues and syncs on reconnect)
 * plus the cold-reload snapshot hardening:
 *
 *   1. Cold offline open — when the network field-op fetch returns nothing
 *      (SW serves the cached document, but /api is network-only), the panel
 *      renders the job from the offline snapshot instead of "not found".
 *   2. Mark offline — the spray line goes DONE optimistically, the PATCH is
 *      QUEUED (no network), and the snapshot persists the change.
 *   3. Reconnect — the `online` event drains the outbox, the queued PATCH
 *      goes out, and the pending count clears.
 *
 * Exercises the real OfflineFieldPanel + real outbox + real sync; only the
 * SWR fetch, the tenant URL builder, the map, and `navigator.onLine` are
 * stubbed.
 */
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

// Shared in-memory outbox behind getOutboxStore (seedable + assertable).
jest.mock('@/lib/offline/outbox', () => {
    const actual = jest.requireActual('@/lib/offline/outbox');
    const store = new actual.InMemoryOutboxStore();
    return { ...actual, getOutboxStore: () => store, __store: store };
});

// Practicelable SWR return (the field-op the panel loads).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let swrReturn: any = { data: undefined, isLoading: false, mutate: jest.fn(async () => {}) };
jest.mock('@/lib/hooks/use-tenant-swr', () => ({ useTenantSWR: () => swrReturn }));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));
jest.mock('@/components/ui/map/MapCanvas', () => ({ MapCanvas: () => null }));
// OfflineFieldPanel now renders <AgStatusBadge> (→ next-intl). Mock it so
// the ESM module isn't parsed and the label falls back to the English
// default ("Done"/"Pending"/…) via t.has()===false.
jest.mock('next-intl', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('../../messages/en.json');
    const get = (p: string): unknown =>
        p.split('.').reduce<unknown>(
            (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
            en,
        );
    return {
        useTranslations: (ns?: string) => {
            const t = (key: string, values?: Record<string, unknown>) => {
                const full = ns ? `${ns}.${key}` : key;
                const msg = get(full);
                if (typeof msg !== 'string') return full;
                return msg.replace(/\{(\w+)\}/g, (_, k) =>
                    values?.[k] != null ? String(values[k]) : `{${k}}`,
                );
            };
            // Keep has()===false so AgStatusBadge uses its default
            // title-case label rendering (the test asserts on "Done").
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (t as any).has = () => false;
            return t;
        },
    };
});

import * as outbox from '@/lib/offline/outbox';
import { OfflineFieldPanel } from '@/components/offline/OfflineFieldPanel';
import { saveFieldSnapshot } from '@/lib/offline/field-snapshot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = (outbox as any).__store;

function fieldOp(status: 'PENDING' | 'DONE' = 'PENDING') {
    return {
        task: { id: 'task-1', key: 'OP-1', title: 'Spray North', status: 'OPEN' },
        lines: [
            {
                id: 'line-1',
                status,
                doseValue: 2,
                parcel: { id: 'p1', name: 'North 40', areaHa: 40 },
                product: { id: 'i1', name: 'GlyphoMax' },
                doseUnit: { id: 'u1', symbol: 'L/ha' },
            },
        ],
        parcels: [{ id: 'p1', name: 'North 40', areaHa: 40, geometry: null }],
        location: { id: 'loc1', name: 'Home Farm', boundsJson: null },
        progress: { total: 1, done: status === 'DONE' ? 1 : 0 },
    };
}

function setOnline(v: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: v });
}

beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).items = [];
    localStorage.clear();
    setOnline(true);
    swrReturn = { data: undefined, isLoading: false, mutate: jest.fn(async () => {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200 }));
});

describe('OfflineFieldPanel — offline operator flow', () => {
    it('cold offline open: renders the job from the snapshot when SWR has no data', async () => {
        // The operator visited online earlier → snapshot saved; now a cold
        // reload with no signal: SWR delivers nothing.
        saveFieldSnapshot('task-1', fieldOp());
        setOnline(false);

        render(<OfflineFieldPanel taskId="task-1" />);

        // The snapshot's line renders — NOT "Field operation not found".
        expect(await screen.findByText('North 40')).toBeInTheDocument();
        expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
    });

    it('mark offline → queued + optimistic + snapshot; syncs the PATCH on reconnect', async () => {
        swrReturn = { data: fieldOp(), isLoading: false, mutate: jest.fn(async () => {}) };
        render(<OfflineFieldPanel taskId="task-1" />);
        await screen.findByText('North 40');

        // Go offline, then mark the line Done.
        setOnline(false);
        act(() => window.dispatchEvent(new Event('offline')));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        });

        // No network (offline), the PATCH is queued, and the line shows DONE.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((global as any).fetch).not.toHaveBeenCalled();
        expect(await store.all()).toHaveLength(1);
        await waitFor(() => expect(screen.getByText('1 queued')).toBeInTheDocument());
        // AgStatusBadge renders the title-case label ("Done"), not the raw enum.
        expect(screen.getByText('Done')).toBeInTheDocument();

        // The snapshot persisted the optimistic DONE (survives a cold reload).
        const snap = JSON.parse(localStorage.getItem('agri.offline.fieldop.v1.task-1')!);
        expect(snap.lines[0].status).toBe('DONE');

        // Reconnect → the online event drains the outbox; the queued PATCH
        // goes out and the queue empties.
        setOnline(true);
        await act(async () => window.dispatchEvent(new Event('online')));
        await waitFor(() =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((global as any).fetch).toHaveBeenCalledWith(
                '/api/t/acme/field-operations/task-1/parcels/line-1',
                expect.objectContaining({ method: 'PATCH' }),
            ),
        );
        await waitFor(async () => expect(await store.all()).toHaveLength(0));
    });
});
