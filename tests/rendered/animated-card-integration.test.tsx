/**
 * Epic 61 — AnimatedNumber rollout into shared metric cards.
 *
 * Pins the wiring contract for the three cards in scope:
 *
 *   - KpiCard renders the headline value through AnimatedNumber
 *     (animated path on a present value, "—" on null/undefined).
 *   - KpiCard's trend indicator renders the magnitude through
 *     AnimatedNumber while preserving the legacy textContent
 *     ("▲ +2.4pp", "▼ −3.1pp", "▶ 0.0%") that other suites assert.
 *   - TrendCard's headline value goes through AnimatedNumber.
 *   - ProgressCard's percent goes through AnimatedNumber and the
 *     suffix is the percent sign.
 *
 * Stable selectors only — `data-animated-number` (from the primitive)
 * and `data-testid="number-flow"` (from the global jsdom mock in
 * `tests/rendered/number-flow-mock.tsx`). No assertions on visual
 * digit DOM that NumberFlow's runtime would normally generate.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

// jsdom reports 0×0 for unsized elements, which ParentSize treats as
// "skip render". Stub it so TrendCard's chart has room to draw.
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
                data-testid="parent-size"
                className={className}
                style={{ width: 160, height: 32 }}>
                {children({ width: 160, height: 32 })}
            </div>
        ),
    };
});

import KpiCard from '@/components/ui/KpiCard';
import { TrendCard } from '@/components/ui/TrendCard';
import ProgressCard from '@/components/ui/ProgressCard';

function makePoints(values: number[]) {
    const start = new Date('2026-04-01T00:00:00Z').getTime();
    return values.map((value, i) => ({
        date: new Date(start + i * 24 * 60 * 60 * 1000),
        value,
    }));
}

// ─── KpiCard ─────────────────────────────────────────────────────────

describe('KpiCard — AnimatedNumber wiring', () => {
    it('renders the headline value through AnimatedNumber', () => {
        const { container, getByText } = render(
            <KpiCard label="Coverage" value={75.3} format="percent" />,
        );
        // The wrapper from AnimatedNumber sits inside the headline <p>.
        const headline = container.querySelector('p [data-animated-number]');
        expect(headline).not.toBeNull();
        // Mock NumberFlow renders the formatted text deterministically.
        expect(getByText('75.3%')).toBeInTheDocument();
    });

    it('falls back to "—" when value is null', () => {
        const { container, getByText } = render(
            <KpiCard label="Coverage" value={null} format="percent" />,
        );
        // No AnimatedNumber should mount when the value is empty.
        expect(container.querySelector('p [data-animated-number]')).toBeNull();
        expect(getByText('—')).toBeInTheDocument();
    });

    it('updates the rendered headline when value changes', () => {
        const { container, rerender } = render(
            <KpiCard label="Coverage" value={50} format="percent" />,
        );
        const before = container.textContent;
        rerender(<KpiCard label="Coverage" value={75.3} format="percent" />);
        expect(container.textContent).not.toBe(before);
        expect(container.textContent).toContain('75.3%');
    });

    it('uses Intl compact notation for the headline when format=compact', () => {
        const { getByText } = render(
            <KpiCard label="Findings" value={1500} format="compact" />,
        );
        // 1.5K with min/max fractionDigits=1 (matches existing "1.5K"
        // shape but via Intl rather than the legacy ad-hoc divider).
        expect(getByText('1.5K')).toBeInTheDocument();
    });

    it('animates the trend magnitude — "+" sign + decimal + "pp" unit', () => {
        const { container } = render(
            <KpiCard
                label="Coverage"
                value={75.3}
                format="percent"
                delta={2.4}
                trendPolarity="up-good"
            />,
        );
        const indicator = container.querySelector('[data-kpi-trend-direction]');
        expect(indicator).not.toBeNull();
        // The decomposed render must still produce the same coalesced
        // text the legacy assertions look for: "▲ +2.4pp".
        expect(indicator?.textContent).toContain('▲');
        expect(indicator?.textContent).toContain('+2.4pp');
        // And the magnitude must go through AnimatedNumber.
        expect(
            indicator?.querySelector('[data-animated-number]'),
        ).not.toBeNull();
    });

    it('renders the negative-delta sign as the Unicode minus', () => {
        const { container } = render(
            <KpiCard
                label="Coverage"
                value={75.3}
                format="percent"
                delta={-3.1}
                trendPolarity="up-good"
            />,
        );
        const indicator = container.querySelector('[data-kpi-trend-direction]');
        // Hyphen-minus would silently break: assert the actual minus
        // glyph the existing tests grep for is present.
        expect(indicator?.textContent).toContain('−3.1pp');
    });

    it('flat (zero) auto-computed trend keeps the "0.0%" textContent', () => {
        const { container } = render(
            <KpiCard
                label="Coverage"
                value={50}
                format="percent"
                previousValue={50}
                trendPolarity="up-good"
            />,
        );
        const indicator = container.querySelector('[data-kpi-trend-direction]');
        expect(indicator?.getAttribute('data-kpi-trend-direction')).toBe('flat');
        expect(indicator?.textContent).toContain('0.0%');
    });
});

// ─── TrendCard ───────────────────────────────────────────────────────

describe('TrendCard — AnimatedNumber wiring', () => {
    it('renders the headline value through AnimatedNumber with the suffix', () => {
        const { container, getByText } = render(
            <TrendCard
                label="Coverage"
                value={75.3}
                format="%"
                points={makePoints([70, 72, 74, 75.3])}
                colorClassName="text-emerald-500"
            />,
        );
        expect(
            container.querySelector('[data-trend-card] [data-animated-number]'),
        ).not.toBeNull();
        expect(getByText('75.3%')).toBeInTheDocument();
    });

    it('omits the suffix when format is unset', () => {
        const { container, queryByText, getByText } = render(
            <TrendCard
                label="Findings"
                value={12}
                points={makePoints([8, 10, 12])}
                colorClassName="text-amber-500"
            />,
        );
        expect(
            container.querySelector('[data-trend-card] [data-animated-number]'),
        ).not.toBeNull();
        expect(getByText('12')).toBeInTheDocument();
        expect(queryByText(/12%/)).toBeNull();
    });

    it('updates the displayed value when the prop changes', () => {
        const { container, rerender } = render(
            <TrendCard
                label="Coverage"
                value={70}
                format="%"
                points={makePoints([70])}
                colorClassName="text-emerald-500"
            />,
        );
        const before = container.textContent;
        rerender(
            <TrendCard
                label="Coverage"
                value={80}
                format="%"
                points={makePoints([70, 80])}
                colorClassName="text-emerald-500"
            />,
        );
        expect(container.textContent).not.toBe(before);
        expect(container.textContent).toContain('80%');
    });
});

// ─── ProgressCard ────────────────────────────────────────────────────

describe('ProgressCard — AnimatedNumber wiring', () => {
    it('renders the percent through AnimatedNumber', () => {
        const { container, getByText } = render(
            <ProgressCard label="Practice Coverage" value={75.3} max={100} />,
        );
        // The percent span sits next to the bar; the AnimatedNumber
        // wrapper carries data-animated-number so we assert on it.
        expect(container.querySelector('[data-animated-number]')).not.toBeNull();
        expect(getByText('75.3%')).toBeInTheDocument();
    });

    it('clamps to 100% when value exceeds max', () => {
        const { getByText } = render(
            <ProgressCard label="Coverage" value={150} max={100} />,
        );
        expect(getByText('100.0%')).toBeInTheDocument();
    });

    it('renders 0.0% when max is zero (avoids divide-by-zero)', () => {
        const { getByText } = render(
            <ProgressCard label="Coverage" value={5} max={0} />,
        );
        expect(getByText('0.0%')).toBeInTheDocument();
    });

    it('updates the rendered percent when value changes', () => {
        const { container, rerender } = render(
            <ProgressCard label="Coverage" value={20} max={100} />,
        );
        const before = container.textContent;
        rerender(<ProgressCard label="Coverage" value={80} max={100} />);
        expect(container.textContent).not.toBe(before);
        expect(container.textContent).toContain('80.0%');
    });
});

// ─── Consistency: all three cards mount the same primitive ──────────

describe('Card system — consistent AnimatedNumber adoption', () => {
    it('all three cards mount [data-animated-number] for their main metric', () => {
        const cards = [
            <KpiCard key="kpi" label="A" value={10} />,
            <TrendCard
                key="trend"
                label="B"
                value={10}
                points={makePoints([10])}
                colorClassName="text-emerald-500"
            />,
            <ProgressCard key="progress" label="C" value={10} max={100} />,
        ];
        for (const card of cards) {
            const { container, unmount } = render(card);
            expect(
                container.querySelectorAll('[data-animated-number]').length,
            ).toBeGreaterThan(0);
            unmount();
        }
    });
});
