/** @jest-environment jsdom */
/**
 * MyWorkClient — the MECHANISATOR operator screen. Its three states
 * (loading / empty / list) and the offline-capable "Mark done" flow.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';

// P2.1c — `useLocale` added: it is part of this module, and without it the
// first component calling `useDateFormat()` threw "useLocale is not a
// function". The project-wide mock in tests/rendered/setup.ts already
// provides it; a per-suite factory replaces that wholesale, so each one
// has to carry it too.
jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));
jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

const submit = jest.fn().mockResolvedValue('sent');
jest.mock('@/lib/offline/use-offline-sync', () => ({
    useOfflineSync: () => ({ submit }),
}));

const useTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => useTenantSWR(...a),
}));

import { MyWorkClient } from '@/app/t/[tenantSlug]/(app)/my-work/MyWorkClient';

describe('MyWorkClient', () => {
    beforeEach(() => {
        useTenantSWR.mockReset();
        submit.mockClear();
    });

    it('shows a skeleton while loading and no cards', () => {
        useTenantSWR.mockReturnValue({ data: undefined, isLoading: true, mutate: jest.fn() });
        render(<MyWorkClient tenantSlug="acme" />);
        expect(screen.getByText('title')).toBeInTheDocument();
        expect(screen.queryByText('markDone')).not.toBeInTheDocument();
    });

    it('always offers a link to the fields/locations page', () => {
        useTenantSWR.mockReturnValue({ data: [], isLoading: false, mutate: jest.fn() });
        render(<MyWorkClient tenantSlug="acme" />);
        const link = screen.getByRole('link', { name: 'locations' });
        expect(link).toHaveAttribute('href', '/t/acme/locations');
    });

    it('shows the empty state when there are no open jobs', () => {
        useTenantSWR.mockReturnValue({ data: [], isLoading: false, mutate: jest.fn() });
        render(<MyWorkClient tenantSlug="acme" />);
        expect(screen.getByText('emptyTitle')).toBeInTheDocument();
    });

    it('deep-links a FIELD_OPERATION to the offline field panel', () => {
        useTenantSWR.mockReturnValue({
            data: [{ id: 'op-1', title: 'Spray north', type: 'FIELD_OPERATION', status: 'OPEN', dueAt: null }],
            isLoading: false,
            mutate: jest.fn(),
        });
        render(<MyWorkClient tenantSlug="acme" />);
        const link = screen.getByRole('link', { name: 'openJob' });
        expect(link).toHaveAttribute('href', '/t/acme/field/op-1');
        // A field operation is opened, not completed inline.
        expect(screen.queryByRole('button', { name: 'markDone' })).not.toBeInTheDocument();
    });

    it('completes a FARM_TASK through the offline-capable outbox and drops it optimistically', async () => {
        const mutate = jest.fn().mockResolvedValue(undefined);
        useTenantSWR.mockReturnValue({
            data: [{ id: 'ft-1', title: 'Irrigate south', type: 'FARM_TASK', status: 'OPEN', dueAt: null }],
            isLoading: false,
            mutate,
        });
        render(<MyWorkClient tenantSlug="acme" />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'markDone' }));
        });

        // Optimistic removal ran first (revalidate: false).
        expect(mutate).toHaveBeenCalledWith(expect.any(Function), { revalidate: false });
        // Completion routed through submit() (network-first, outbox fallback).
        expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({
                url: '/api/t/acme/tasks/ft-1/status',
                method: 'POST',
                body: { status: 'RESOLVED', resolution: 'doneResolution' },
                label: 'doneLabel',
            }),
        );
    });
});
