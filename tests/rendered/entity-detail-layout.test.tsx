/**
 * `<EntityDetailLayout>` rendered tests.
 *
 * Locks the shell's structural contract:
 *   - header (back link + title + meta + actions) renders all four
 *     when supplied, omits each cleanly when undefined
 *   - tabs render as a tablist with role="tab" + aria-selected
 *   - clicking a tab fires onTabChange with the right key
 *   - active tab gets the brand-default underline class signal
 *   - children render in a tabpanel with aria-labelledby pointing
 *     at the active tab
 *   - state branches (loading / error / empty) replace the body
 *     and short-circuit children
 *   - tabs prop is optional — pages without tabs still render header + body
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';

describe('EntityDetailLayout — header', () => {
    it('renders back link, title, meta, actions when all supplied', () => {
        render(
            <EntityDetailLayout
                back={{ href: '/t/acme/practices', label: 'Practices' }}
                title="AC-1: Access Control"
                meta={<span data-testid="meta-badge">Implemented</span>}
                actions={
                    <button type="button" data-testid="action-btn">
                        Action
                    </button>
                }
            >
                <div>body</div>
            </EntityDetailLayout>,
        );

        // v2-PR-5 — EntityDetailLayout now delegates to <PageHeader>;
        // assert via the canonical page-header-* test ids.
        const back = screen.getByTestId('page-header-back');
        expect(back).toHaveAttribute('href', '/t/acme/practices');
        expect(back.textContent).toContain('Practices');

        expect(screen.getByTestId('page-header-title').textContent).toBe(
            'AC-1: Access Control',
        );
        expect(screen.getByTestId('meta-badge')).toBeInTheDocument();
        expect(screen.getByTestId('action-btn')).toBeInTheDocument();
    });

    it('omits the back link when not supplied', () => {
        render(
            <EntityDetailLayout title="No back">
                <div>body</div>
            </EntityDetailLayout>,
        );
        expect(screen.queryByTestId('page-header-back')).toBeNull();
    });

    it('omits the meta row when not supplied', () => {
        render(
            <EntityDetailLayout title="No meta">
                <div>body</div>
            </EntityDetailLayout>,
        );
        expect(screen.queryByTestId('page-header-meta')).toBeNull();
    });

    it('omits the actions slot when not supplied', () => {
        render(
            <EntityDetailLayout title="No actions">
                <div>body</div>
            </EntityDetailLayout>,
        );
        expect(screen.queryByTestId('page-header-actions')).toBeNull();
    });
});

describe('EntityDetailLayout — tabs', () => {
    function renderWithTabs(activeTab = 'overview') {
        const onTabChange = jest.fn();
        render(
            <EntityDetailLayout
                title="Practice"
                tabs={[
                    { key: 'overview', label: 'Overview' },
                    { key: 'tasks', label: 'Tasks', count: 3 },
                    { key: 'evidence', label: 'Evidence' },
                ]}
                activeTab={activeTab}
                onTabChange={onTabChange}
            >
                <div data-testid="active-content">{activeTab} body</div>
            </EntityDetailLayout>,
        );
        return { onTabChange };
    }

    it('renders a tablist with role="tab" + aria-selected on active', () => {
        renderWithTabs('overview');
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(3);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        expect(tabs[1].getAttribute('aria-selected')).toBe('false');
        expect(tabs[2].getAttribute('aria-selected')).toBe('false');
    });

    it('renders count badge on tabs that have one', () => {
        renderWithTabs('overview');
        // Tasks tab (3 count) shows "(3)" suffix; Overview tab does not.
        const tasksTab = screen.getByTestId('tab-tasks');
        expect(tasksTab.textContent).toMatch(/\(3\)/);
        const overviewTab = screen.getByTestId('tab-overview');
        expect(overviewTab.textContent).not.toMatch(/\(\d+\)/);
    });

    it('clicking a tab fires onTabChange with that key', () => {
        const { onTabChange } = renderWithTabs('overview');
        fireEvent.click(screen.getByTestId('tab-tasks'));
        expect(onTabChange).toHaveBeenCalledWith('tasks');
    });

    it('renders children in a tabpanel with aria-labelledby pointing at the active tab', () => {
        renderWithTabs('tasks');
        const panel = screen.getByTestId('entity-detail-tabpanel');
        expect(panel.getAttribute('role')).toBe('tabpanel');
        expect(panel.getAttribute('aria-labelledby')).toBe('tab-tasks');
        // The harness re-renders body text from activeTab.
        expect(screen.getByTestId('active-content').textContent).toBe(
            'tasks body',
        );
    });

    it('disabled tabs are not clickable and carry the disabled attribute', () => {
        const onTabChange = jest.fn();
        render(
            <EntityDetailLayout
                title="Practice"
                tabs={[
                    { key: 'overview', label: 'Overview' },
                    { key: 'tests', label: 'Tests', disabled: true },
                ]}
                activeTab="overview"
                onTabChange={onTabChange}
            >
                <div>body</div>
            </EntityDetailLayout>,
        );
        const testsTab = screen.getByTestId('tab-tests') as HTMLButtonElement;
        expect(testsTab.disabled).toBe(true);
        fireEvent.click(testsTab);
        expect(onTabChange).not.toHaveBeenCalled();
    });

    it('omits the tab bar entirely when tabs prop is undefined', () => {
        render(
            <EntityDetailLayout title="No tabs">
                <div>body</div>
            </EntityDetailLayout>,
        );
        expect(screen.queryByTestId('entity-detail-tabs')).toBeNull();
        expect(screen.getByTestId('entity-detail-body')).toBeInTheDocument();
    });
});

// mobile-native-feel PR-1 — the active tab is scrolled into view on
// mount AND on every active-tab change, so deep-linking to a later tab
// (or switching tabs) never leaves it off-screen on a phone.
describe('EntityDetailLayout — active tab auto-scroll', () => {
    let scrollSpy: jest.SpyInstance;
    beforeEach(() => {
        scrollSpy = jest
            .spyOn(HTMLElement.prototype, 'scrollIntoView')
            .mockImplementation(() => {});
    });
    afterEach(() => scrollSpy.mockRestore());

    function renderTabs(activeTab: string) {
        return render(
            <EntityDetailLayout
                title="Practice"
                tabs={[
                    { key: 'overview', label: 'Overview' },
                    { key: 'tasks', label: 'Tasks' },
                    { key: 'evidence', label: 'Evidence' },
                ]}
                activeTab={activeTab}
                onTabChange={jest.fn()}
            >
                <div>body</div>
            </EntityDetailLayout>,
        );
    }

    it('scrolls the active tab into view on mount', () => {
        renderTabs('evidence');
        expect(scrollSpy).toHaveBeenCalled();
        // The element scrolled is the ACTIVE tab button.
        const activeTab = screen.getByTestId('tab-evidence');
        const scrolled = scrollSpy.mock.instances.some(
            (inst) => inst === activeTab,
        );
        expect(scrolled).toBe(true);
        // Called with an inline:'nearest' options object (native tabs contract).
        expect(scrollSpy).toHaveBeenCalledWith(
            expect.objectContaining({ inline: 'nearest' }),
        );
    });

    it('re-scrolls when the active tab changes', () => {
        const { rerender } = renderTabs('overview');
        scrollSpy.mockClear();
        rerender(
            <EntityDetailLayout
                title="Practice"
                tabs={[
                    { key: 'overview', label: 'Overview' },
                    { key: 'tasks', label: 'Tasks' },
                    { key: 'evidence', label: 'Evidence' },
                ]}
                activeTab="tasks"
                onTabChange={jest.fn()}
            >
                <div>body</div>
            </EntityDetailLayout>,
        );
        expect(scrollSpy).toHaveBeenCalled();
        const tasksTab = screen.getByTestId('tab-tasks');
        expect(
            scrollSpy.mock.instances.some((inst) => inst === tasksTab),
        ).toBe(true);
    });
});

describe('EntityDetailLayout — lifecycle states', () => {
    it('loading replaces the body with a skeleton', () => {
        render(
            <EntityDetailLayout loading title="Loading…">
                <div data-testid="body-content">should not render</div>
            </EntityDetailLayout>,
        );
        expect(
            screen.getByTestId('entity-detail-loading'),
        ).toBeInTheDocument();
        expect(screen.queryByTestId('body-content')).toBeNull();
    });

    it('error replaces the body with a token-error inline message', () => {
        render(
            <EntityDetailLayout error="Boom" title="Errored">
                <div data-testid="body-content">should not render</div>
            </EntityDetailLayout>,
        );
        const errorEl = screen.getByTestId('entity-detail-error');
        expect(errorEl.textContent).toBe('Boom');
        expect(errorEl.getAttribute('role')).toBe('alert');
        expect(screen.queryByTestId('body-content')).toBeNull();
    });

    it('empty replaces the body with the supplied message', () => {
        render(
            <EntityDetailLayout
                empty={{ message: 'Practice not found.' }}
                title=""
            >
                <div data-testid="body-content">should not render</div>
            </EntityDetailLayout>,
        );
        expect(
            screen.getByTestId('entity-detail-empty').textContent,
        ).toBe('Practice not found.');
        expect(screen.queryByTestId('body-content')).toBeNull();
    });
});

// v2-fu-4 — breadcrumbs/back must survive every lifecycle state so
// the user always has navigation affordance, especially during the
// data fetch. Previously loading/error/empty branches returned
// before the PageHeader was rendered.
describe('EntityDetailLayout — breadcrumbs survive every state', () => {
    const breadcrumbs = [
        { label: 'Dashboard', href: '/t/acme/dashboard' },
        { label: 'Risks', href: '/t/acme/risks' },
        { label: 'Risk' },
    ];

    it('breadcrumbs render during loading', () => {
        render(
            <EntityDetailLayout
                loading
                title="Loading…"
                breadcrumbs={breadcrumbs}
            >
                <></>
            </EntityDetailLayout>,
        );
        const crumb = screen.getByTestId('page-header-breadcrumbs');
        expect(crumb).toBeInTheDocument();
        expect(crumb.textContent).toContain('Dashboard');
        expect(crumb.textContent).toContain('Risks');
    });

    it('breadcrumbs render during error', () => {
        render(
            <EntityDetailLayout
                error="Boom"
                title=""
                breadcrumbs={breadcrumbs}
            >
                <></>
            </EntityDetailLayout>,
        );
        expect(
            screen.getByTestId('page-header-breadcrumbs'),
        ).toBeInTheDocument();
        // Error message also renders alongside.
        expect(
            screen.getByTestId('entity-detail-error').textContent,
        ).toBe('Boom');
    });

    it('breadcrumbs render during empty (entity not found)', () => {
        render(
            <EntityDetailLayout
                empty={{ message: 'Risk not found.' }}
                title=""
                breadcrumbs={breadcrumbs}
            >
                <></>
            </EntityDetailLayout>,
        );
        expect(
            screen.getByTestId('page-header-breadcrumbs'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('entity-detail-empty').textContent,
        ).toBe('Risk not found.');
    });

    it('back link renders during loading too', () => {
        render(
            <EntityDetailLayout
                loading
                title="Loading…"
                back={{ href: '/t/acme/risks', label: 'Risks' }}
            >
                <></>
            </EntityDetailLayout>,
        );
        const back = screen.getByTestId('page-header-back');
        expect(back).toHaveAttribute('href', '/t/acme/risks');
        expect(back.textContent).toContain('Risks');
    });
});
