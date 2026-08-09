/**
 * `<CreateFindingModal>` — behavioural render lock.
 *
 * Asserts the create-finding modal exposes the full field set the feature
 * requires (title, type, severity, assignee, due date, description, linked
 * control, compensating control, analysis) and that the
 * submit button gates on the required title + description.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/findings',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CreateFindingModal } from '@/app/t/[tenantSlug]/(app)/findings/CreateFindingModal';

beforeEach(() => {
    // Every lookup (controls / assignable members) resolves empty.
    global.fetch = jest.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    ) as unknown as typeof fetch;
});

function renderModal() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return render(
        <QueryClientProvider client={client}>
            <CreateFindingModal open setOpen={() => {}} tenantSlug="acme" apiUrl={apiUrl} />
        </QueryClientProvider>,
    );
}

const FIELD_IDS = [
    'finding-title',
    'finding-type',
    'finding-severity',
    'finding-assignee',
    'finding-description',
    'finding-control',
    'finding-compensating-control',
    'finding-analysis',
    'submit-finding',
];

describe('CreateFindingModal', () => {
    it('renders every required field', async () => {
        renderModal();
        for (const id of FIELD_IDS) {
            await waitFor(() => expect(document.getElementById(id)).not.toBeNull());
        }
        // Due-date picker (DatePicker doesn't surface its id in jsdom).
        // The implicated-risks linker that used to be asserted here went
        // with the risk register.
        expect(screen.getByText('Due date')).not.toBeNull();
    });

    it('disables submit until title AND description are filled', async () => {
        renderModal();
        const submit = await waitFor(() => {
            const el = document.getElementById('submit-finding');
            if (!el) throw new Error('no submit');
            return el as HTMLButtonElement;
        });
        expect(submit).toBeDisabled();

        fireEvent.change(document.getElementById('finding-title')!, { target: { value: 'A finding' } });
        expect(submit).toBeDisabled(); // description still empty

        fireEvent.change(document.getElementById('finding-description')!, {
            target: { value: 'What was observed' },
        });
        await waitFor(() => expect(submit).not.toBeDisabled());
    });
});
