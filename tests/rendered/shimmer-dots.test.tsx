/**
 * Epic 64 — `<ShimmerDots>` primitive.
 *
 * Verifies the structural contract jsdom can observe — grid sizing,
 * accessibility surface, motion-reduce class wiring, token-aware
 * fill, and `data-testid` passthrough. Doesn't try to assert the
 * actual animation (jsdom doesn't run CSS animations).
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

import { ShimmerDots } from '@/components/ui/shimmer-dots';

describe('ShimmerDots — grid sizing', () => {
    it('renders rows × cols dots', () => {
        const { container } = render(<ShimmerDots rows={3} cols={5} />);
        expect(container.querySelectorAll('[data-shimmer-dot]').length).toBe(15);
    });

    it('defaults to 4 × 16 = 64 dots when no props passed', () => {
        const { container } = render(<ShimmerDots />);
        expect(container.querySelectorAll('[data-shimmer-dot]').length).toBe(64);
    });

    it('renders zero dots gracefully when rows or cols is 0', () => {
        const { container, rerender } = render(<ShimmerDots rows={0} cols={5} />);
        expect(container.querySelectorAll('[data-shimmer-dot]').length).toBe(0);
        rerender(<ShimmerDots rows={5} cols={0} />);
        expect(container.querySelectorAll('[data-shimmer-dot]').length).toBe(0);
    });

    it('clamps fractional row/col values via Math.floor', () => {
        const { container } = render(<ShimmerDots rows={3.7} cols={4.2} />);
        // 3 × 4 = 12 (Math.floor on both sides).
        expect(container.querySelectorAll('[data-shimmer-dot]').length).toBe(12);
    });

    it('emits a CSS grid with the right column count', () => {
        const { container } = render(<ShimmerDots rows={2} cols={8} />);
        const wrapper = container.querySelector('[data-shimmer-dots]') as HTMLElement;
        expect(wrapper.style.gridTemplateColumns).toBe(
            'repeat(8, minmax(0, 1fr))',
        );
    });
});

describe('ShimmerDots — accessibility', () => {
    it('mounts as a busy progressbar with a default label', () => {
        const { container } = render(<ShimmerDots />);
        const wrapper = container.querySelector('[data-shimmer-dots]') as HTMLElement;
        expect(wrapper.getAttribute('role')).toBe('progressbar');
        expect(wrapper.getAttribute('aria-busy')).toBe('true');
        expect(wrapper.getAttribute('aria-label')).toBe('Loading');
    });

    it('honours an aria-label override', () => {
        const { getByLabelText } = render(
            <ShimmerDots aria-label="Loading practice coverage" />,
        );
        expect(getByLabelText('Loading practice coverage')).toBeTruthy();
    });

    it('every dot is aria-hidden so SR announces only the wrapper', () => {
        const { container } = render(<ShimmerDots rows={2} cols={3} />);
        const dots = container.querySelectorAll('[data-shimmer-dot]');
        for (const d of Array.from(dots)) {
            expect(d.getAttribute('aria-hidden')).toBe('true');
        }
    });
});

describe('ShimmerDots — motion + token wiring', () => {
    it('every dot carries the shimmer animation + motion-reduce halt', () => {
        const { container } = render(<ShimmerDots rows={2} cols={2} />);
        const dots = container.querySelectorAll('[data-shimmer-dot]');
        for (const d of Array.from(dots)) {
            const cls = d.getAttribute('class') ?? '';
            expect(cls).toContain('animate-shimmer-pulse');
            expect(cls).toContain('motion-reduce:animate-none');
        }
    });

    it('uses the token-backed fill class (bg-content-muted/30)', () => {
        const { container } = render(<ShimmerDots rows={1} cols={1} />);
        const dot = container.querySelector('[data-shimmer-dot]');
        // Hex / raw colour leak would mean the dots ignore the
        // theme. The CSS class is the single source of truth.
        expect(dot?.getAttribute('class') ?? '').toContain(
            'bg-content-muted/30',
        );
    });

    it('staggers animation-delay across cells so the wave reads diagonally', () => {
        const { container } = render(<ShimmerDots rows={2} cols={3} />);
        const dots = container.querySelectorAll('[data-shimmer-dot]');
        const delays = Array.from(dots).map(
            (d) => (d as HTMLElement).style.animationDelay,
        );
        // First cell at delay 0 (row=0, col=0).
        expect(delays[0]).toBe('0ms');
        // Cell at (row=0, col=1) — 60 ms.
        expect(delays[1]).toBe('60ms');
        // Cell at (row=1, col=0) — 60 ms (same diagonal).
        expect(delays[3]).toBe('60ms');
        // Cell at (row=1, col=2) — 180 ms.
        expect(delays[5]).toBe('180ms');
    });

    it('honours custom dotSize tailwind class', () => {
        const { container } = render(
            <ShimmerDots rows={1} cols={1} dotSize="size-2" />,
        );
        const dot = container.querySelector('[data-shimmer-dot]');
        expect(dot?.getAttribute('class') ?? '').toContain('size-2');
    });
});

describe('ShimmerDots — passthrough', () => {
    it('forwards className to the wrapper', () => {
        const { container } = render(
            <ShimmerDots rows={1} cols={1} className="h-32 w-full" />,
        );
        const wrapper = container.querySelector('[data-shimmer-dots]') as HTMLElement;
        expect(wrapper.className).toContain('h-32');
        expect(wrapper.className).toContain('w-full');
    });

    it('forwards data-testid to the wrapper', () => {
        const { getByTestId } = render(
            <ShimmerDots rows={1} cols={1} data-testid="chart-loading" />,
        );
        expect(getByTestId('chart-loading')).toBeTruthy();
    });
});
