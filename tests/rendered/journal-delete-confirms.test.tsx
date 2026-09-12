/** @jest-environment jsdom */
/**
 * Deleting a journal entry must not claim success before the server confirms.
 *
 * `handleDeleteEntry` called `router.push` on the SAME TICK as the undo toast,
 * so the operator read "Entry deleted", navigated away, and the DELETE fired
 * five seconds later with nobody watching. `useToastWithUndo` deliberately does
 * not re-throw, and the page passed no `onError`, so a rejection was swallowed
 * whole. Soft delete, so the record survived — the risk was a duplicate
 * re-entry into a БАБХ journal.
 *
 * Moving navigation into `onCommit` fixes that and CREATES a state that did not
 * exist before: the operator now stands on a fully interactive entry for the
 * whole undo window. Edit was still live there, and an edit saved inside the
 * window is destroyed by the delayed commit — with `restoreLogEntry` being
 * assertCanAdmin, an EDITOR could not recover it. The interlocks are therefore
 * part of the fix, not polish.
 *
 * NOTE: next-intl is deliberately NOT mocked here. tests/rendered/setup.ts
 * resolves REAL en.json strings, and a per-file key-echo factory would OVERRIDE
 * it — under key-echo every assertion on copy passes whether or not the key
 * exists in either catalogue.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme', id: 'entry-1' }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        permissions: { canRead: true, canWrite: true, canAdmin: false },
        appPermissions: {},
        availableModules: ['JOURNAL'],
    }),
}));

const ENTRY = {
    id: 'entry-1', type: 'OBSERVATION', title: 'Scouted aphids', status: 'DONE',
    occurredAt: '2026-09-01T00:00:00.000Z', notes: null, quantities: [],
    locations: [], equipment: [], files: [], costAmount: null,
};
// Key-AWARE. A mock that returns the entry for every key hands `/units` an
// object where the component maps an array — a double that is not merely
// lenient but WRONG, and it fails somewhere unrelated to what is under test.
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => ({
        data: key && String(key).includes(`/journal/`) && !String(key).endsWith('/files')
            ? ENTRY
            : [],
        error: undefined,
        isLoading: false,
        mutate: jest.fn(),
    }),
    usePrefetchTenant: () => () => {},
}));

// Tooltip needs a radix provider this page does not mount itself; nothing here
// tests tooltips, and the buttons keep their aria-labels either way.
jest.mock('@/components/ui/tooltip', () => ({
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// sanitize-html is ESM and jest cannot parse it; the page reaches it through
// src/lib/security/sanitize. Every other suite that mounts this tree does the
// same, and nothing here exercises sanitisation.
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (v: string) => v,
    sanitizeRichTextHtml: (v: string) => v,
}));

const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => {
    const actual = jest.requireActual('@/lib/api-client');
    return { ...actual, apiDelete: (...a: unknown[]) => apiDelete(...a) };
});

// Drive the undo window by hand: capture the input and fire its callbacks.
let captured: Record<string, ((v?: unknown) => void) | undefined> = {};
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useToast: () => ({ error: jest.fn(), success: jest.fn() }),
        useToastWithUndo: () => (input: Record<string, unknown>) => { captured = input as never; },
    };
});

import JournalDetailPage from '@/app/t/[tenantSlug]/(app)/journal/[id]/page';

function clickDelete() {
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
}

beforeEach(() => { push.mockClear(); apiDelete.mockReset(); captured = {}; });

describe('the page does not navigate before the server confirms', () => {
    it('does NOT push on click — navigation waits for onCommit', async () => {
        await act(async () => { render(<JournalDetailPage />); });
        await act(async () => { clickDelete(); });

        // The defect, stated as a property: clicking must not move the user.
        expect(push).not.toHaveBeenCalled();
        expect(typeof captured.onCommit).toBe('function');
    });

    it('pushes once the commit lands', async () => {
        await act(async () => { render(<JournalDetailPage />); });
        await act(async () => { clickDelete(); });
        await act(async () => { captured.onCommit?.(); });

        expect(push).toHaveBeenCalledWith('/t/acme/journal');
    });

    it('reports a failed delete on the page', async () => {
        await act(async () => { render(<JournalDetailPage />); });
        await act(async () => { clickDelete(); });
        await act(async () => { captured.onError?.(new Error('boom')); });

        // Real en.json copy — proves the key exists in the catalogue.
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(screen.getByText(/did not confirm the delete/i)).toBeInTheDocument();
        // And it must NOT have navigated away on a failure.
        expect(push).not.toHaveBeenCalled();
    });

    it('says something different when the delete never left the phone', async () => {
        const { ApiClientError, API_OFFLINE_CODE } = jest.requireActual('@/lib/api-client');
        await act(async () => { render(<JournalDetailPage />); });
        await act(async () => { clickDelete(); });
        await act(async () => { captured.onError?.(new ApiClientError('x', API_OFFLINE_CODE, 0)); });

        expect(screen.getByText(/never reached the server/i)).toBeInTheDocument();
    });
});

describe('the undo window is interlocked', () => {
    it('disables Edit while a delete is pending — the work-loss path', async () => {
        // Without this the fix INTRODUCES a defect: an edit saved inside the
        // window is destroyed by the delayed commit, and restore is admin-only.
        await act(async () => { render(<JournalDetailPage />); });
        const edit = screen.getByRole('button', { name: /edit/i });
        expect(edit).not.toBeDisabled();

        await act(async () => { clickDelete(); });
        expect(edit).toBeDisabled();
    });

    it('disables a second Delete — a repeat is a 404, not a no-op', async () => {
        await act(async () => { render(<JournalDetailPage />); });
        await act(async () => { clickDelete(); });
        expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
    });

    it('re-enables both when the operator taps Undo', async () => {
        // Otherwise the page stays locked forever on a cancelled delete.
        await act(async () => { render(<JournalDetailPage />); });
        await act(async () => { clickDelete(); });
        await act(async () => { captured.onUndo?.(); });

        expect(screen.getByRole('button', { name: /edit/i })).not.toBeDisabled();
        expect(screen.getByRole('button', { name: /delete/i })).not.toBeDisabled();
    });
});
