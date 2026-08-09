/**
 * Roadmap-6 P4 — ResponsiveToaster position.
 *
 * On a phone the global sonner Toaster host must anchor at the BOTTOM so the
 * Undo / Close practices land in the thumb zone (clear of the sticky top
 * chrome); on md+ it stays top-right. The rendered `matchMedia` mock reports
 * `matches: false` for `(min-width: 768px)`, i.e. a phone viewport, so the
 * post-mount effect flips `isMdUp` → false → `position="bottom-center"`.
 *
 * This replaces a flaky e2e that assumed sonner renders its host with no active
 * toast — it doesn't, so we fire a real toast here and assert the mounted host.
 */
import { render, screen, act } from '@testing-library/react';
import { toast } from 'sonner';
import { ResponsiveToaster } from '@/app/providers';

describe('ResponsiveToaster', () => {
    it('anchors the sonner host at the bottom on a phone viewport', async () => {
        render(<ResponsiveToaster />);

        // Sonner only mounts its `[data-sonner-toaster]` host once a toast
        // exists — fire one, then let the post-mount matchMedia effect + the
        // sonner store update flush.
        await act(async () => {
            toast('Marked done');
            await new Promise((r) => setTimeout(r, 0));
        });

        const host = document.querySelector('[data-sonner-toaster]');
        expect(host).not.toBeNull();
        // Phone → bottom-centre (thumb zone), not the desktop top-right.
        expect(host).toHaveAttribute('data-y-position', 'bottom');

        // Sanity: the toast content actually rendered through this host.
        expect(screen.getByText('Marked done')).toBeInTheDocument();
    });
});
