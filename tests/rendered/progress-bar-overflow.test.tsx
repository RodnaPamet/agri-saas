/**
 * `<ProgressBar>` overflow honesty.
 *
 * The bar's track is clamped — it physically cannot render past 100% — but the
 * NUMBER must not be. An over-full grain bin is the one signal a farmer most
 * needs, and the component used to show "100%" while its caller's `aria-label`
 * announced the true "140%": sighted and screen-reader users were told
 * different things about the same bin.
 *
 * The contract locked here:
 *   - the visible label shows the TRUE percentage
 *   - `aria-valuetext` (what assistive tech announces) matches it
 *   - `aria-valuenow` stays within [min,max] as ARIA requires
 *   - overflow is visually marked, since a full track alone is
 *     indistinguishable from exactly-100%
 */
import { render, screen } from '@testing-library/react';
import { ProgressBar } from '@/components/ui/progress-bar';

describe('ProgressBar — over-full', () => {
    it('shows the TRUE percentage, not a clamped 100%', () => {
        render(<ProgressBar value={140} showValue aria-label="Bin fill" />);
        expect(screen.getByText('140%')).toBeInTheDocument();
        expect(screen.queryByText('100%')).not.toBeInTheDocument();
    });

    it('announces the same number it displays', () => {
        render(<ProgressBar value={140} showValue aria-label="Bin fill" />);
        const bar = screen.getByRole('progressbar');
        // What AT reads out.
        expect(bar).toHaveAttribute('aria-valuetext', '140%');
        // ARIA requires valuenow within [min,max], so it stays clamped — the
        // human-readable value is carried by valuetext.
        expect(bar).toHaveAttribute('aria-valuenow', '100');
        expect(bar).toHaveAttribute('aria-valuemax', '100');
    });

    it('marks overflow visually', () => {
        render(<ProgressBar value={140} aria-label="Bin fill" />);
        expect(screen.getByRole('progressbar')).toHaveAttribute('data-overflow', 'true');
    });

    it('leaves a normal value alone', () => {
        render(<ProgressBar value={45} showValue aria-label="Bin fill" />);
        const bar = screen.getByRole('progressbar');
        expect(screen.getByText('45%')).toBeInTheDocument();
        expect(bar).toHaveAttribute('aria-valuetext', '45%');
        expect(bar).toHaveAttribute('aria-valuenow', '45');
        expect(bar).not.toHaveAttribute('data-overflow');
    });

    it('reports exactly 100% without flagging overflow', () => {
        render(<ProgressBar value={100} showValue aria-label="Bin fill" />);
        expect(screen.getByText('100%')).toBeInTheDocument();
        expect(screen.getByRole('progressbar')).not.toHaveAttribute('data-overflow');
    });

    it('survives max = 0 without dividing by zero', () => {
        render(<ProgressBar value={5} max={0} showValue aria-label="Empty" />);
        expect(screen.getByText('0%')).toBeInTheDocument();
        // No capacity means no overflow claim either.
        expect(screen.getByRole('progressbar')).not.toHaveAttribute('data-overflow');
    });

    it('floors a negative value at zero', () => {
        render(<ProgressBar value={-20} showValue aria-label="Bin fill" />);
        expect(screen.getByText('0%')).toBeInTheDocument();
    });
});
