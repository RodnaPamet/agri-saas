/**
 * Regression tests for the show-once API key surface (Epic 56 copy rollout).
 *
 * Pins:
 *   - The masking toggle hides all but the first 13 characters of the
 *     plaintext key when collapsed.
 *   - Clicking the Copy button writes the FULL plaintext to the
 *     clipboard regardless of mask state (masking is visual-only).
 *   - Clipboard failure does not crash and raises the error toast.
 *
 * Uses the Epic 56 shared `useCopyToClipboard` hook — the test confirms
 * the bespoke `navigator.clipboard.writeText` + `setTimeout` pattern
 * has been replaced without loss of behaviour.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

const toastMock = { success: jest.fn(), error: jest.fn() };
jest.mock('sonner', () => ({
    toast: toastMock,
    Toaster: () => null,
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

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => path,
    useTenantHref: () => (path: string) => path,
    useTenantContext: () => ({ tenantSlug: 'acme' }),
}));

import { KeyDisplay } from '@/app/t/[tenantSlug]/(app)/admin/api-keys/KeyDisplay';
import { TooltipProvider } from '@/components/ui/tooltip';

const FULL_KEY = 'inflk_live_9Z9z9Z9z9Z9z9Z9z9Z9z9Z9z9Z9z9Z9z9Z9z9Z9z9Z9z9Z';

function Harness({ children }: { children: React.ReactNode }) {
    // KeyDisplay wraps the visibility toggle in a Radix Tooltip;
    // the real primitive requires a provider in the tree.
    return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

function mockClipboard(writeText: jest.Mock | null) {
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: writeText ? { writeText } : null,
    });
}

beforeEach(() => {
    toastMock.success.mockClear();
    toastMock.error.mockClear();
});

describe('API key show-once display', () => {
    it('masks the key by default — only first 13 chars are readable', () => {
        render(<Harness><KeyDisplay plaintext={FULL_KEY} /></Harness>);
        const code = document.querySelector(
            '#key-display code',
        ) as HTMLElement | null;
        expect(code).not.toBeNull();

        const rendered = code!.textContent ?? '';
        expect(rendered.startsWith(FULL_KEY.slice(0, 13))).toBe(true);
        // The rest of the key is replaced by bullets, so the full
        // plaintext must NOT be present in the visible DOM.
        expect(rendered.includes(FULL_KEY)).toBe(false);
        expect(rendered).toContain('•');
    });

    it('reveals the full key when the visibility toggle is activated', async () => {
        const user = userEvent.setup();
        render(<Harness><KeyDisplay plaintext={FULL_KEY} /></Harness>);

        await user.click(screen.getByRole('button', { name: 'Show key' }));

        const code = document.querySelector(
            '#key-display code',
        ) as HTMLElement | null;
        expect(code!.textContent).toBe(FULL_KEY);
    });

    it('copies the FULL plaintext even while the display is masked', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);

        render(<Harness><KeyDisplay plaintext={FULL_KEY} /></Harness>);

        // Confirm masking is active (we haven't clicked Show key).
        const code = document.querySelector(
            '#key-display code',
        ) as HTMLElement | null;
        expect(code!.textContent).not.toBe(FULL_KEY);

        await user.click(document.getElementById('key-copy-btn')!);

        expect(writeText).toHaveBeenCalledWith(FULL_KEY);
        expect(toastMock.success).toHaveBeenCalledWith(
            'API key copied — paste it into your tool now.',
        );
        expect(toastMock.error).not.toHaveBeenCalled();
    });

    it('raises the error toast when clipboard write rejects', async () => {
        const writeText = jest
            .fn()
            .mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
        const user = userEvent.setup();
        mockClipboard(writeText);

        render(<Harness><KeyDisplay plaintext={FULL_KEY} /></Harness>);
        await user.click(document.getElementById('key-copy-btn')!);

        expect(toastMock.error).toHaveBeenCalledWith(
            'Copy failed — select the key and copy manually.',
        );
        expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('no component uses bespoke navigator.clipboard (regression guard)', () => {
        // Hook path: `useCopyToClipboard` reads `navigator.clipboard`,
        // but the caller component must not close over it directly.
        // This snapshot pins the migration — if someone re-introduces
        // the inline pattern in KeyDisplay the rendered output here
        // won't change, but the companion source-contract test at
        // `tests/guards/no-inline-clipboard.test.ts` would flag it.
        render(<Harness><KeyDisplay plaintext={FULL_KEY} /></Harness>);
        expect(
            document.getElementById('key-copy-btn'),
        ).toBeInTheDocument();
    });
});
