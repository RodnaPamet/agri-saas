/**
 * Epic 64 — rollout integration coverage.
 *
 * Verifies the three chart-loading integrations and the two
 * sheet/modal `progressiveBlur` opt-ins behave correctly. The
 * primitives themselves are covered exhaustively in
 * `tests/rendered/shimmer-dots.test.tsx` and
 * `tests/rendered/progressive-blur.test.tsx`.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

import KpiCard from '@/components/ui/KpiCard';
import DonutChart from '@/components/ui/DonutChart';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

// ─── KpiCard ───────────────────────────────────────────────────────

describe('Epic 64 — KpiCard loading state', () => {
    it('renders shimmer dots in place of the headline when loading', () => {
        const { container } = render(
            withTooltip(
                <KpiCard label="Coverage" value={75.3} format="percent" loading />,
            ),
        );
        // The loading surface mounts a [data-kpi-loading] container
        // wrapping the shimmer primitive.
        expect(
            container.querySelector('[data-kpi-loading] [data-shimmer-dots]'),
        ).not.toBeNull();
    });

    it('suppresses the trend indicator while loading', () => {
        const { container } = render(
            withTooltip(
                <KpiCard
                    label="Coverage"
                    value={75.3}
                    format="percent"
                    delta={2.4}
                    trendPolarity="up-good"
                    loading
                />,
            ),
        );
        expect(
            container.querySelector('[data-kpi-trend-direction]'),
        ).toBeNull();
    });

    it('renders the headline as usual when loading is false', () => {
        const { container } = render(
            withTooltip(
                <KpiCard
                    label="Coverage"
                    value={75.3}
                    format="percent"
                    loading={false}
                />,
            ),
        );
        expect(container.querySelector('[data-kpi-loading]')).toBeNull();
        // Headline value (animated number) is mounted instead.
        expect(
            container.querySelector('[data-animated-number]'),
        ).not.toBeNull();
    });

    it('null value renders "—" when not loading (preserved behaviour)', () => {
        const { container } = render(
            withTooltip(
                <KpiCard label="Coverage" value={null} format="percent" />,
            ),
        );
        expect(container.querySelector('[data-kpi-loading]')).toBeNull();
        expect(container.textContent).toContain('—');
    });
});

// ─── DonutChart ────────────────────────────────────────────────────

describe('Epic 64 — DonutChart loading state', () => {
    it('renders shimmer dots in place of arcs while loading', () => {
        const { container } = render(
            <DonutChart segments={[]} loading size={120} />,
        );
        const wrapper = container.querySelector('[data-donut-loading]');
        expect(wrapper).not.toBeNull();
        expect(
            wrapper?.querySelector('[data-shimmer-dots]'),
        ).not.toBeNull();
        // No SVG arcs while loading.
        expect(container.querySelector('svg')).toBeNull();
    });

    it('preserves footprint while loading (size flows through)', () => {
        const { container } = render(
            <DonutChart segments={[]} loading size={200} />,
        );
        const innerBox = container.querySelector(
            '[data-donut-loading] > div',
        ) as HTMLElement;
        expect(innerBox.style.width).toBe('200px');
        expect(innerBox.style.height).toBe('200px');
    });

    it('still renders empty-state SVG when loading=false and segments=[]', () => {
        const { container } = render(<DonutChart segments={[]} />);
        expect(container.querySelector('[data-donut-loading]')).toBeNull();
        expect(container.querySelector('svg')).not.toBeNull();
    });

    it('renders the donut as usual when loading=false and segments populated', () => {
        const { container } = render(
            <DonutChart
                segments={[
                    { label: 'Open', value: 5, color: '#f59e0b' },
                    { label: 'Closed', value: 3, color: '#22c55e' },
                ]}
            />,
        );
        expect(container.querySelector('[data-donut-loading]')).toBeNull();
        expect(container.querySelector('svg')).not.toBeNull();
    });
});



// ─── Sheet.Body progressiveBlur ────────────────────────────────────

describe('Epic 64 — Sheet.Body progressiveBlur', () => {
    function bareBody(extra: { progressiveBlur?: boolean | 'top' | 'bottom' | 'both' } = {}) {
        // Rendering Sheet.Body directly skips the Drawer/Vaul mount —
        // the Body export is a thin wrapper around <div> so this is
        // safe and keeps the test focused on the new prop.
        return render(
            <Sheet.Body {...extra}>
                <p>content</p>
            </Sheet.Body>,
        );
    }

    it('default (no prop) does not mount progressive blur', () => {
        const { container } = bareBody();
        expect(
            container.querySelector('[data-progressive-blur]'),
        ).toBeNull();
        expect(
            container
                .querySelector('[data-sheet-body]')
                ?.getAttribute('data-sheet-body-progressive-blur'),
        ).toBeNull();
    });

    it('progressiveBlur={true} mounts top + bottom (the "both" shorthand)', () => {
        const { container } = bareBody({ progressiveBlur: true });
        expect(
            container.querySelector('[data-progressive-blur="top"]'),
        ).not.toBeNull();
        expect(
            container.querySelector('[data-progressive-blur="bottom"]'),
        ).not.toBeNull();
        expect(
            container
                .querySelector('[data-sheet-body]')
                ?.getAttribute('data-sheet-body-progressive-blur'),
        ).toBe('both');
    });

    it.each(['top', 'bottom'] as const)(
        'progressiveBlur="%s" mounts only that edge',
        (edge) => {
            const { container } = bareBody({ progressiveBlur: edge });
            expect(
                container.querySelector(`[data-progressive-blur="${edge}"]`),
            ).not.toBeNull();
            const other = edge === 'top' ? 'bottom' : 'top';
            expect(
                container.querySelector(`[data-progressive-blur="${other}"]`),
            ).toBeNull();
        },
    );

    it('progressiveBlur adds `relative` to the body so the absolute overlay anchors correctly', () => {
        const { container } = bareBody({ progressiveBlur: 'top' });
        const body = container.querySelector('[data-sheet-body]') as HTMLElement;
        expect(body.className).toContain('relative');
    });
});

// ─── Modal.Body progressiveBlur ────────────────────────────────────

describe('Epic 64 — Modal.Body progressiveBlur', () => {
    function bareBody(extra: { progressiveBlur?: boolean | 'top' | 'bottom' | 'both' } = {}) {
        return render(
            <Modal.Body {...extra}>
                <p>content</p>
            </Modal.Body>,
        );
    }

    it('default (no prop) does not mount progressive blur', () => {
        const { container } = bareBody();
        expect(
            container.querySelector('[data-progressive-blur]'),
        ).toBeNull();
    });

    it('progressiveBlur={true} mounts top + bottom (the "both" shorthand)', () => {
        const { container } = bareBody({ progressiveBlur: true });
        expect(
            container.querySelector('[data-progressive-blur="top"]'),
        ).not.toBeNull();
        expect(
            container.querySelector('[data-progressive-blur="bottom"]'),
        ).not.toBeNull();
    });

    it('progressiveBlur="bottom" mounts only the bottom edge', () => {
        const { container } = bareBody({ progressiveBlur: 'bottom' });
        expect(
            container.querySelector('[data-progressive-blur="top"]'),
        ).toBeNull();
        expect(
            container.querySelector('[data-progressive-blur="bottom"]'),
        ).not.toBeNull();
    });

    it('progressiveBlur preserves children (does not unmount the body content)', () => {
        const { container } = bareBody({ progressiveBlur: true });
        expect(container.textContent).toContain('content');
    });
});
