/**
 * Epic 59 — micro-visual components (MiniAreaChart, ProgressBar,
 * ProgressCircle).
 *
 *   - Render contract: root element, required ARIA role + values,
 *     token-backed classes.
 *   - Edge states: empty data, zero max, overflow (value > max),
 *     negative input, progress === 0, progress === 1, constant-value
 *     sparkline.
 *   - KPI-card integration: the three primitives compose cleanly
 *     inside a card, render the accessible label, and keep the
 *     trend + headline visually separable.
 */

import React from 'react';
import { render } from '@testing-library/react';

// Mock ParentSize so MiniAreaChart can measure a size under jsdom
// (jsdom reports 0×0 by default, which the normal ParentSize code
// path interprets as "skip render").
jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return {
        ...actual,
        ParentSize: ({
            children,
            className,
        }: {
            children: (args: { width: number; height: number }) => React.ReactNode;
            className?: string;
        }) => (
            <div
                data-testid="mini-parent-size"
                className={className}
                style={{ width: 120, height: 40 }}>
                {children({ width: 120, height: 40 })}
            </div>
        ),
    };
});

import { MiniAreaChart } from '@/components/ui/mini-area-chart';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ProgressCircle } from '@/components/ui/progress-circle';

// ─── MiniAreaChart ───────────────────────────────────────────────────

describe('MiniAreaChart', () => {
    const sample = [
        { date: new Date('2026-04-01T00:00:00Z'), value: 70 },
        { date: new Date('2026-04-02T00:00:00Z'), value: 72 },
        { date: new Date('2026-04-03T00:00:00Z'), value: 74 },
        { date: new Date('2026-04-04T00:00:00Z'), value: 76 },
        { date: new Date('2026-04-05T00:00:00Z'), value: 78 },
    ];

    it('renders a sparkline SVG with the aria-label + variant class', () => {
        const { container, getByLabelText } = render(
            <MiniAreaChart data={sample} variant="success" aria-label="Coverage trend" />,
        );
        const svg = getByLabelText('Coverage trend');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.getAttribute('data-mini-chart')).not.toBeNull();
        expect(svg.getAttribute('role')).toBe('img');
        expect(svg.getAttribute('class') ?? '').toContain('text-content-success');
        // Renders at least one path for the line and one for the fill.
        expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
    });

    it('variant defaults to brand when omitted', () => {
        const { getByLabelText } = render(
            <MiniAreaChart data={sample} aria-label="Trend" />,
        );
        const svg = getByLabelText('Trend');
        expect(svg.getAttribute('class') ?? '').toContain('text-brand-emphasis');
    });

    it('empty data renders a dashed baseline, no throw', () => {
        const { getByLabelText } = render(
            <MiniAreaChart data={[]} aria-label="Empty trend" />,
        );
        const svg = getByLabelText('Empty trend');
        expect(svg.getAttribute('data-mini-chart-empty')).not.toBeNull();
        const line = svg.querySelector('line');
        expect(line).not.toBeNull();
        expect(line?.getAttribute('stroke-dasharray')).toBe('2 3');
    });

    it('constant-value data renders without a divide-by-zero', () => {
        const constant = sample.map((d) => ({ ...d, value: 50 }));
        const { container } = render(
            <MiniAreaChart data={constant} aria-label="Flat trend" />,
        );
        // The main line path renders.
        expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
    });

    it('single-point data renders without a divide-by-zero', () => {
        const one = [{ date: new Date('2026-04-01T00:00:00Z'), value: 42 }];
        expect(() =>
            render(<MiniAreaChart data={one} aria-label="Single point" />),
        ).not.toThrow();
    });
});

// ─── ProgressBar ─────────────────────────────────────────────────────

describe('ProgressBar', () => {
    it('renders with role=progressbar + ARIA values', () => {
        const { getByRole } = render(
            <ProgressBar value={75} aria-label="Coverage" />,
        );
        const bar = getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('75');
        expect(bar.getAttribute('aria-valuemin')).toBe('0');
        expect(bar.getAttribute('aria-valuemax')).toBe('100');
        expect(bar.getAttribute('aria-label')).toBe('Coverage');
    });

    it('brand variant renders the brand-emphasis fill class', () => {
        const { getByRole } = render(<ProgressBar value={50} />);
        const bar = getByRole('progressbar');
        const fill = bar.querySelector('.bg-brand-emphasis');
        expect(fill).not.toBeNull();
    });

    it.each([
        ['success', 'var(--content-success)'],
        ['warning', 'var(--content-warning)'],
        ['error', 'var(--content-error)'],
        ['info', 'var(--content-info)'],
    ] as const)('%s variant applies the matching token colour', (variant, cssVar) => {
        const { getByRole } = render(
            <ProgressBar value={50} variant={variant} />,
        );
        const bar = getByRole('progressbar');
        const html = bar.outerHTML;
        // The fill's arbitrary-value background class embeds the
        // status CSS var (cssVar) — assert it reached the DOM. NB:
        // do not write the literal class form here — Tailwind scans
        // this file and would emit it as a (broken) utility.
        expect(html).toContain(cssVar);
    });

    it('size variants map to the expected track heights', () => {
        const sm = render(<ProgressBar value={50} size="sm" />);
        expect(sm.getByRole('progressbar').className).toContain('h-1');
        sm.unmount();

        const md = render(<ProgressBar value={50} size="md" />);
        expect(md.getByRole('progressbar').className).toContain('h-2');
        md.unmount();

        const lg = render(<ProgressBar value={50} size="lg" />);
        expect(lg.getByRole('progressbar').className).toContain('h-3');
    });

    it('showValue renders the percent to the right', () => {
        const { getByText } = render(<ProgressBar value={37.5} showValue />);
        expect(getByText('38%')).not.toBeNull();
    });

    it('clamps negative values to 0%', () => {
        const { getByRole } = render(<ProgressBar value={-5} />);
        expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    });

    it('value > max caps at max and sets data-overflow', () => {
        const { getByRole } = render(<ProgressBar value={120} max={100} />);
        const bar = getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('100');
        expect(bar.getAttribute('data-overflow')).toBe('true');
    });

    it('max === 0 renders 0% without crashing', () => {
        const { getByRole } = render(<ProgressBar value={10} max={0} />);
        const bar = getByRole('progressbar');
        expect(bar.getAttribute('aria-valuemax')).toBe('0');
        expect(bar.getAttribute('aria-valuenow')).toBe('0');
    });

    it('falls back to "Progress" for aria-label when none is supplied', () => {
        const { getByRole } = render(<ProgressBar value={50} />);
        expect(getByRole('progressbar').getAttribute('aria-label')).toBe('Progress');
    });
});

// ─── ProgressCircle ──────────────────────────────────────────────────

describe('ProgressCircle', () => {
    it('renders role=progressbar with aria-valuenow from the fractional input', () => {
        const { getByRole } = render(
            <ProgressCircle progress={0.62} aria-label="Coverage" />,
        );
        const circle = getByRole('progressbar');
        expect(circle.getAttribute('aria-valuenow')).toBe('62');
        expect(circle.getAttribute('aria-valuemin')).toBe('0');
        expect(circle.getAttribute('aria-valuemax')).toBe('100');
    });

    it('variant class maps to the expected token text colour', () => {
        const { getByRole } = render(
            <ProgressCircle progress={0.5} variant="warning" />,
        );
        expect(getByRole('progressbar').getAttribute('class') ?? '').toContain(
            'text-content-warning',
        );
    });

    it('progress === 0 omits the arc circle but keeps the track', () => {
        const { container } = render(<ProgressCircle progress={0} />);
        // Track + optional arc. With progress 0, only track renders → 1 circle.
        expect(container.querySelectorAll('circle').length).toBe(1);
    });

    it('progress === 1 renders the full arc', () => {
        const { container } = render(<ProgressCircle progress={1} />);
        // Track + full arc = 2 circles.
        expect(container.querySelectorAll('circle').length).toBe(2);
    });

    it('clamps progress > 1 to 1 on the ARIA value', () => {
        const { getByRole } = render(<ProgressCircle progress={1.5} />);
        expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    });

    it('clamps negative progress to 0', () => {
        const { getByRole } = render(<ProgressCircle progress={-0.2} />);
        expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    });

    it('renders the optional center label', () => {
        const { getByText } = render(
            <ProgressCircle progress={0.75} label="75%" />,
        );
        expect(getByText('75%')).not.toBeNull();
    });

    it('size variants expose the expected outer wrapper class', () => {
        const { container: sm } = render(
            <ProgressCircle progress={0.5} size="sm" />,
        );
        expect(sm.firstElementChild?.className).toContain('size-8');

        const { container: lg } = render(
            <ProgressCircle progress={0.5} size="lg" />,
        );
        expect(lg.firstElementChild?.className).toContain('size-20');
    });
});

// ─── KPI-card integration sanity ─────────────────────────────────────

describe('KPI-card integration sanity', () => {
    it('the three primitives compose cleanly inside a shared card', () => {
        const { getByLabelText, getAllByRole, getByText } = render(
            <section aria-label="Practice Coverage KPI">
                <header>
                    <h3>Practice Coverage</h3>
                    <p>75%</p>
                </header>
                <MiniAreaChart
                    data={[
                        { date: new Date('2026-04-01'), value: 70 },
                        { date: new Date('2026-04-07'), value: 75 },
                    ]}
                    aria-label="Coverage trend — last 7 days"
                    variant="success"
                />
                <ProgressBar value={75} aria-label="Coverage bar" showValue size="sm" />
                <ProgressCircle progress={0.75} size="lg" label="75%" aria-label="Coverage circle" />
            </section>,
        );

        // Sparkline accessible by its label.
        expect(getByLabelText('Coverage trend — last 7 days')).not.toBeNull();
        // Both progress surfaces expose role="progressbar" with distinct aria-labels.
        const progressbars = getAllByRole('progressbar');
        expect(progressbars.length).toBe(2);
        const labels = progressbars.map((el) => el.getAttribute('aria-label'));
        expect(labels).toEqual(
            expect.arrayContaining(['Coverage bar', 'Coverage circle']),
        );
        const bar = getByLabelText('Coverage bar');
        const circle = getByLabelText('Coverage circle');
        expect(bar.getAttribute('aria-valuenow')).toBe('75');
        expect(circle.getAttribute('aria-valuenow')).toBe('75');
        expect(getByText('Practice Coverage')).not.toBeNull();
    });

    it('all three primitives tolerate zero / empty inputs without throwing', () => {
        expect(() =>
            render(
                <section>
                    <MiniAreaChart data={[]} aria-label="Empty trend" />
                    <ProgressBar value={0} aria-label="Empty" />
                    <ProgressCircle progress={0} aria-label="Empty" />
                </section>,
            ),
        ).not.toThrow();
    });
});
