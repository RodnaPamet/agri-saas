/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<AsidePanel>`.
 *
 * Pins the primitive's behaviour across the right-rail roadmap:
 * docked ↔ spine collapse + localStorage persistence (Phase 1), the
 * `defaultCollapsed` first-visit state (Phase 3), and the resizable
 * width + `?aside` deep-link refinements (Phase 4).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { AsidePanel } from '@/components/ui/aside-panel';

// `<AsidePanel>` reads `?aside` via `useSearchParams` (Phase 4
// deep-link). A practicelable mock — tests set `mockSearchParams`
// before render; the `mock` prefix lets the hoisted factory close
// over it.
let mockSearchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useSearchParams: () => mockSearchParams,
}));

beforeEach(() => {
    window.localStorage.clear();
    mockSearchParams = new URLSearchParams();
});

describe('<AsidePanel>', () => {
    it('renders the docked panel expanded by default, with its content', () => {
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="test-surface">
                <p>rail body</p>
            </AsidePanel>,
        );
        const docked = screen.getByTestId('aside-panel-docked');
        expect(docked).toBeInTheDocument();
        expect(screen.queryByTestId('aside-panel-spine')).toBeNull();
        // Title + content both render inside the docked panel.
        expect(within(docked).getByText('rail body')).toBeInTheDocument();
        expect(within(docked).getByText('Linked Tasks')).toBeInTheDocument();
    });

    it('collapses to a spine on the collapse toggle, and re-expands', async () => {
        const user = userEvent.setup();
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="test-surface">
                <p>rail body</p>
            </AsidePanel>,
        );

        await user.click(
            screen.getByRole('button', { name: /collapse linked tasks/i }),
        );
        expect(screen.getByTestId('aside-panel-spine')).toBeInTheDocument();
        expect(screen.queryByTestId('aside-panel-docked')).toBeNull();

        await user.click(
            screen.getByRole('button', { name: /expand linked tasks/i }),
        );
        expect(screen.getByTestId('aside-panel-docked')).toBeInTheDocument();
        expect(screen.queryByTestId('aside-panel-spine')).toBeNull();
    });

    it('persists the collapsed state to localStorage under the surfaceKey', async () => {
        const user = userEvent.setup();
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="risk-detail">
                <p>rail body</p>
            </AsidePanel>,
        );
        await user.click(
            screen.getByRole('button', { name: /collapse linked tasks/i }),
        );
        // The collapse state is keyed by surfaceKey so each rail
        // surface remembers independently.
        expect(
            window.localStorage.getItem('aside:collapsed:risk-detail'),
        ).toBe('true');
    });

    it('starts collapsed when localStorage already has a collapsed state', async () => {
        window.localStorage.setItem('aside:collapsed:risk-detail', 'true');
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="risk-detail">
                <p>rail body</p>
            </AsidePanel>,
        );
        // useLocalStorage hydrates from storage in an effect.
        expect(
            await screen.findByTestId('aside-panel-spine'),
        ).toBeInTheDocument();
    });

    it('always renders the <xl Sheet trigger (responsive fallback)', () => {
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="test-surface">
                <p>rail body</p>
            </AsidePanel>,
        );
        // The Sheet trigger is the < xl path — present in the DOM
        // regardless of collapse state; CSS (`xl:hidden`) governs
        // which surface is visible at runtime.
        expect(
            screen.getByTestId('aside-panel-sheet-trigger'),
        ).toBeInTheDocument();
    });

    // ── defaultCollapsed (right-rail Phase 3) ──

    it('starts collapsed-to-spine when defaultCollapsed and storage is empty', async () => {
        render(
            <AsidePanel
                title="AI Assist"
                surfaceKey="risks-list"
                defaultCollapsed
            >
                <p>rail body</p>
            </AsidePanel>,
        );
        // First visit, no stored preference → the panel honours
        // `defaultCollapsed` and lands as the 44px spine.
        expect(
            await screen.findByTestId('aside-panel-spine'),
        ).toBeInTheDocument();
    });

    it('a stored preference wins over defaultCollapsed', async () => {
        // The user previously expanded this surface — that choice
        // persists and overrides the default.
        window.localStorage.setItem('aside:collapsed:risks-list', 'false');
        render(
            <AsidePanel
                title="AI Assist"
                surfaceKey="risks-list"
                defaultCollapsed
            >
                <p>rail body</p>
            </AsidePanel>,
        );
        expect(
            await screen.findByTestId('aside-panel-docked'),
        ).toBeInTheDocument();
    });

    // ── Resizable width (right-rail Phase 4) ──

    it('renders a resize handle with separator semantics + width bounds', () => {
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="test-surface">
                <p>rail body</p>
            </AsidePanel>,
        );
        const handle = screen.getByTestId('aside-panel-resize-handle');
        expect(handle).toHaveAttribute('role', 'separator');
        expect(handle).toHaveAttribute('aria-orientation', 'vertical');
        // Default width 320, bounds 280–480.
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        expect(handle).toHaveAttribute('aria-valuemin', '280');
        expect(handle).toHaveAttribute('aria-valuemax', '480');
    });

    it('drag-resizes the docked panel and clamps to the max width', () => {
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="test-surface">
                <p>rail body</p>
            </AsidePanel>,
        );
        const handle = screen.getByTestId('aside-panel-resize-handle');
        // Rail is on the right — dragging the handle LEFT widens it.
        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(document, { clientX: 460 });
        fireEvent.mouseUp(document);
        // 320 + (500 - 460) = 360.
        expect(handle).toHaveAttribute('aria-valuenow', '360');

        // A drag far past the cap clamps at 480.
        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(document, { clientX: 0 });
        fireEvent.mouseUp(document);
        expect(handle).toHaveAttribute('aria-valuenow', '480');
    });

    it('keyboard-resizes the panel and persists width per surfaceKey', () => {
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="risk-detail">
                <p>rail body</p>
            </AsidePanel>,
        );
        const handle = screen.getByTestId('aside-panel-resize-handle');
        handle.focus();
        // ArrowLeft widens by the 16px step.
        fireEvent.keyDown(handle, { key: 'ArrowLeft' });
        expect(handle).toHaveAttribute('aria-valuenow', '336');
        // ArrowRight narrows.
        fireEvent.keyDown(handle, { key: 'ArrowRight' });
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        // Width persists under the surfaceKey-scoped key.
        expect(
            window.localStorage.getItem('aside:width:risk-detail'),
        ).toBe('320');
    });

    // ── Deep link (right-rail Phase 4) ──

    it('?aside=<surfaceKey> force-expands the panel over a stored collapsed state', async () => {
        // The user's stored preference is collapsed…
        window.localStorage.setItem('aside:collapsed:risk-detail', 'true');
        // …but a shared link deep-links straight to this rail.
        mockSearchParams = new URLSearchParams('aside=risk-detail');
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="risk-detail">
                <p>rail body</p>
            </AsidePanel>,
        );
        expect(
            await screen.findByTestId('aside-panel-docked'),
        ).toBeInTheDocument();
    });

    it('a non-matching ?aside value leaves the stored collapsed state intact', async () => {
        window.localStorage.setItem('aside:collapsed:risk-detail', 'true');
        // The deep-link targets a different surface.
        mockSearchParams = new URLSearchParams('aside=some-other-rail');
        render(
            <AsidePanel title="Linked Tasks" surfaceKey="risk-detail">
                <p>rail body</p>
            </AsidePanel>,
        );
        expect(
            await screen.findByTestId('aside-panel-spine'),
        ).toBeInTheDocument();
    });
});
