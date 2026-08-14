/**
 * DivergingBar — a signed magnitude either side of a visible zero.
 *
 * ── Why this primitive exists ───────────────────────────────────────
 *
 * `ProgressBar` cannot show a loss. `progress-bar.tsx` floors the value
 * with `Math.max(0, value)` BEFORE computing its percentage, so a −40 and
 * a 0 come out identical in the fill, in the visible label, in
 * `aria-valuenow` and in `aria-valuetext`. Overflow is preserved and
 * surfaced three ways; underflow is destroyed silently. That asymmetry is
 * right for progress — you cannot be less than 0% done — and wrong for
 * any signed quantity, where "lost money" and "broke even" are the two
 * answers a reader most needs to tell apart.
 *
 * The chart platform has no alternative: `Bars` requires a band scale over
 * DATES, and its own docblock says so. So this is a new primitive rather
 * than a call-site workaround, and it lives beside `ProgressBar` — NOT in
 * `components/ui/charts/`, whose file layout and barrel are pinned by
 * `tests/guardrails/chart-platform-foundation.test.ts`.
 *
 * ── role="meter", not "progressbar" ─────────────────────────────────
 *
 * ARIA defines `progressbar` as the completion of a task, which a margin
 * is not, and its value range starts at zero. `meter` is "a scalar
 * measurement within a known range" — exactly this — and it takes a
 * NEGATIVE `aria-valuemin`, so the sign survives into assistive tech
 * instead of being clamped away.
 */
import { render, screen } from '@testing-library/react';
import { DivergingBar } from '@/components/ui/diverging-bar';

describe('DivergingBar', () => {
    it('announces a negative value as negative, rather than flooring it to zero', () => {
        // THE DEFECT THAT MOTIVATED THE PRIMITIVE. ProgressBar renders this
        // as 0 in every channel; a loss must not read as break-even.
        render(<DivergingBar value={-40} max={100} aria-label="Barley margin" />);

        const bar = screen.getByRole('meter', { name: 'Barley margin' });
        expect(bar).toHaveAttribute('aria-valuenow', '-40');
        expect(bar).toHaveAttribute('aria-valuemin', '-100');
        expect(bar).toHaveAttribute('aria-valuemax', '100');
    });

    it('keeps a loss distinguishable from an exact zero', () => {
        const { rerender } = render(<DivergingBar value={-40} max={100} aria-label="m" />);
        const negative = screen.getByRole('meter').getAttribute('aria-valuenow');

        rerender(<DivergingBar value={0} max={100} aria-label="m" />);
        const zero = screen.getByRole('meter').getAttribute('aria-valuenow');

        expect(negative).not.toBe(zero);
    });

    it('marks which side of zero the value falls, for a reader who cannot see colour', () => {
        // Colour alone would be the only signal otherwise, and a
        // red/green split is precisely what a colour-blind reader loses.
        render(<DivergingBar value={-40} max={100} aria-label="m" />);
        expect(screen.getByRole('meter')).toHaveAttribute('data-sign', 'negative');

        render(<DivergingBar value={40} max={100} aria-label="p" />);
        expect(screen.getByRole('meter', { name: 'p' })).toHaveAttribute('data-sign', 'positive');
    });

    it('carries a caller-supplied value text, so the units are never guessed', () => {
        // The bar plots a magnitude; only the caller knows it is EUR per
        // decare. Without this the announced value is a bare number.
        render(<DivergingBar value={80} max={500} aria-label="Wheat" valueText="+80 EUR/dca" />);
        expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '+80 EUR/dca');
    });

    it('renders a zero baseline, because bar lengths mean nothing without it', () => {
        render(<DivergingBar value={80} max={500} aria-label="Wheat" />);
        expect(screen.getByTestId('diverging-bar-baseline')).toBeInTheDocument();
    });

    describe('the scale cannot be gamed', () => {
        it('shares one max across bars, so two crops are comparable', () => {
            // Each bar sizing itself to its OWN value would make every crop
            // look identical — the failure mode a per-row bar invites.
            render(
                <>
                    <DivergingBar value={50} max={500} aria-label="a" />
                    <DivergingBar value={500} max={500} aria-label="b" />
                </>,
            );
            const [a, b] = screen.getAllByRole('meter');
            expect(a).toHaveAttribute('aria-valuemax', '500');
            expect(b).toHaveAttribute('aria-valuemax', '500');
            expect(a.getAttribute('aria-valuenow')).not.toBe(b.getAttribute('aria-valuenow'));
        });

        it('clamps the FILL past the scale but keeps the true value announced', () => {
            // Same contract ProgressBar settled on for overflow: the track
            // cannot be exceeded, so the honest figure moves to the text.
            render(<DivergingBar value={900} max={500} aria-label="over" />);
            const bar = screen.getByRole('meter');
            expect(bar).toHaveAttribute('data-overflow', 'true');
            expect(bar).toHaveAttribute('aria-valuenow', '900');
        });

        it('refuses a non-positive max instead of dividing by it', () => {
            render(<DivergingBar value={40} max={0} aria-label="degenerate" />);
            const bar = screen.getByRole('meter');
            // No NaN, no Infinity, and nothing announced that implies a
            // measured position on a scale that does not exist.
            expect(bar.getAttribute('aria-valuenow')).toBe('40');
            expect(bar).toHaveAttribute('data-scale', 'none');
        });
    });
});
