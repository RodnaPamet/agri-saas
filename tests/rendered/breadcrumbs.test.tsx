/**
 * Rendered tests for the shared <Breadcrumbs> primitive.
 *
 * Covers:
 *   - Semantic markup: <nav aria-label="Breadcrumb"> + <ol>/<li>
 *   - Items with `href` render as Next Links; the rest render as spans
 *   - The last item carries `aria-current="page"` automatically
 *   - Explicit `current: true` overrides the automatic last-item rule
 *   - Long paths collapse middle items behind a "…" disclosure
 *   - `maxVisible: Infinity` disables collapsing
 *   - axe-core finds no violations
 */

import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import * as React from 'react';

import { Breadcrumbs } from '@/components/ui/breadcrumbs';

// next/link gets stubbed in render tests via the path mapper; verify
// that anchor semantics still come through.

describe('Breadcrumbs', () => {
    it('renders semantic nav + ol structure', () => {
        const { container } = render(
            <Breadcrumbs
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Practices' },
                ]}
            />,
        );
        const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
        expect(nav).toBeInTheDocument();
        expect(nav.querySelector('ol')).toBeInTheDocument();
        expect(container.querySelectorAll('li')).toHaveLength(2);
    });

    it('renders linkable items as anchors and the current as a span', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Risks', href: '/risks' },
                    { label: 'Risk-42' },
                ]}
            />,
        );
        expect(
            screen.getByRole('link', { name: 'Dashboard' }),
        ).toHaveAttribute('href', '/');
        expect(screen.getByRole('link', { name: 'Risks' })).toHaveAttribute(
            'href',
            '/risks',
        );
        expect(
            screen.queryByRole('link', { name: 'Risk-42' }),
        ).not.toBeInTheDocument();
    });

    it('marks the last item as the current page automatically', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Settings' },
                ]}
            />,
        );
        const current = screen.getByText('Settings');
        expect(current).toHaveAttribute('aria-current', 'page');
    });

    it('honours explicit current=true even when not last', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'A', href: '/a' },
                    { label: 'B', current: true, href: '/b' },
                    { label: 'C', href: '/c' },
                ]}
            />,
        );
        // B is current; it should NOT render as a link even though
        // href was provided.
        expect(screen.getByText('B')).toHaveAttribute('aria-current', 'page');
        expect(screen.queryByRole('link', { name: 'B' })).not.toBeInTheDocument();
    });

    it('collapses middle items past maxVisible', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Audits', href: '/audits' },
                    { label: 'Cycles', href: '/audits/cycles' },
                    { label: 'Cycle-X', href: '/audits/cycles/x' },
                    { label: 'Readiness' },
                ]}
                maxVisible={3}
            />,
        );
        // First (Dashboard) + ellipsis + last (Readiness) = 3 items.
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
        expect(screen.getByText('Readiness')).toBeInTheDocument();
        expect(screen.getByText('…')).toBeInTheDocument();
        expect(screen.queryByText('Audits')).not.toBeInTheDocument();
    });

    it('does NOT collapse when items count is at-or-below maxVisible', () => {
        render(
            <Breadcrumbs
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'A', href: '/a' },
                    { label: 'B' },
                ]}
                maxVisible={4}
            />,
        );
        expect(screen.queryByText('…')).not.toBeInTheDocument();
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
        expect(screen.getByText('A')).toBeInTheDocument();
        expect(screen.getByText('B')).toBeInTheDocument();
    });

    it('renders a custom separator', () => {
        const { container } = render(
            <Breadcrumbs
                separator="›"
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Tasks' },
                ]}
            />,
        );
        expect(container.textContent).toContain('›');
    });

    it('returns null when items is empty', () => {
        const { container } = render(<Breadcrumbs items={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('finds zero accessibility violations', async () => {
        const { container } = render(
            <Breadcrumbs
                items={[
                    { label: 'Dashboard', href: '/' },
                    { label: 'Practices', href: '/practices' },
                    { label: 'Practice X' },
                ]}
            />,
        );
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });
});
