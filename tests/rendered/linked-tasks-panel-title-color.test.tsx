/**
 * `<LinkedTasksPanel>` task-title color.
 *
 * Regression (2026-05-30): the linked-task row title used hard-coded
 * `text-white`, which is invisible on the light theme's light surface
 * (practice → Tasks tab). It must use a theme-aware semantic content
 * token instead. Rendered with `canWrite` unset so the create modal
 * (and its heavy deps) never mount — we only need the read-only list.
 */

import { render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

// LinkedTasksPanel statically imports NewTaskModal, which pulls Next
// router hooks at module load — mock them so the import resolves.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/practices/c1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import LinkedTasksPanel from '@/components/LinkedTasksPanel';

describe('LinkedTasksPanel — task title color', () => {
    beforeEach(() => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                rows: [{ id: 't1', title: 'My Linked Task', status: 'OPEN' }],
            }),
        })) as unknown as typeof fetch;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('renders the task title with a theme-aware content token (not text-white)', async () => {
        render(
            <LinkedTasksPanel
                apiBase="/api/t/acme"
                entityType="PRACTICE"
                entityId="c1"
                tenantHref={(p) => p}
            />,
        );

        const title = await screen.findByText('My Linked Task');
        // Light-theme-safe: the title must resolve through a semantic
        // content token, never raw white (invisible on a light surface).
        expect(title).toHaveClass('text-content-emphasis');
        expect(title.className).not.toContain('text-white');
    });

    it('strips the trailing slash so the list fetch stays same-origin', async () => {
        render(
            <LinkedTasksPanel
                apiBase="/api/t/acme/"
                entityType="PRACTICE"
                entityId="c1"
                tenantHref={(p) => p}
            />,
        );
        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalled();
        });
        const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
        // No `//tasks` double slash (which Next 308-redirects to an
        // absolute https URL and breaks over HTTP).
        expect(url).not.toContain('//tasks');
        expect(url).toContain('/api/t/acme/tasks?linkedEntityType=PRACTICE');
    });
});
