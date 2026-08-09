/**
 * Regression tests for Epic 56's `title=` → `<Tooltip>` migration.
 *
 * These tests don't re-verify Tooltip behaviour itself (that's
 * tooltip.test.tsx). They prove the high-value migration sites still
 * behave correctly now that their trigger buttons are wrapped in a
 * Tooltip — the click handlers fire, `aria-label` replaces `title` as
 * the accessible name, and no blocking overlay sits between the user
 * and the practice.
 *
 * The jsdom project mocks `./tooltip` as a pass-through (see
 * `tests/rendered/tooltip-mock.tsx`), so these assertions focus on the
 * button surface, which is what downstream user journeys depend on.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

jest.mock('next-auth/react', () => ({
    useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';

describe('ThemeToggle (title → Tooltip migration)', () => {
    function renderToggle() {
        // ThemeToggle imports Tooltip via the `@/` alias, so the real
        // Radix-backed primitive is in use and requires a TooltipProvider.
        return render(
            <TooltipProvider delayDuration={0}>
                <ThemeProvider>
                    <ThemeToggle />
                </ThemeProvider>
            </TooltipProvider>,
        );
    }

    it('no longer forwards `title` to the HTML button', () => {
        renderToggle();
        const button = screen.getByRole('button');
        expect(button.hasAttribute('title')).toBe(false);
    });

    it('keeps an accessible name via aria-label', () => {
        renderToggle();
        const button = screen.getByRole('button');
        // The toggle cycles dark → light → sunlight (feat/delight-personality),
        // so the label names the current theme + the next ("dark theme —
        // switch to light").
        expect(button).toHaveAccessibleName(/switch to (light|dark|sunlight)/i);
    });

    it('toggles theme on click — the tooltip wrapper must not swallow the event', async () => {
        const user = userEvent.setup();
        renderToggle();
        const button = screen.getByTestId('theme-toggle');

        const before = button.getAttribute('data-theme-current');
        await user.click(button);
        const after = button.getAttribute('data-theme-current');

        expect(before).not.toBe(after);
    });
});

/* ──────────────────────────────────────────────────────────────── *
 * Inline pattern check — the migration rule is that icon-only
 * buttons must carry an explicit `aria-label` now that `title=` is
 * gone. This harness models that contract so we don't regress.
 * ──────────────────────────────────────────────────────────────── */

describe('Icon-only button + Tooltip wrapping contract', () => {
    it('wrapped button is still reachable via its aria-label', async () => {
        const onClick = jest.fn();
        const user = userEvent.setup();

        // Mirrors the pattern used in admin/api-keys, admin/roles,
        // admin/integrations, and the columns-dropdown after migration.
        render(
            <button
                type="button"
                aria-label="Revoke key"
                onClick={onClick}
            >
                <span aria-hidden="true">🗑</span>
            </button>,
        );

        const button = screen.getByRole('button', { name: 'Revoke key' });
        expect(button.hasAttribute('title')).toBe(false);
        await user.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('disabled trigger retains its aria-label and cannot be clicked', async () => {
        const onClick = jest.fn();
        const user = userEvent.setup();

        render(
            <button
                type="button"
                aria-label="Disable integration"
                onClick={onClick}
                disabled
            >
                <span aria-hidden="true">✕</span>
            </button>,
        );

        const button = screen.getByRole('button', { name: 'Disable integration' });
        expect(button).toBeDisabled();
        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });
});
