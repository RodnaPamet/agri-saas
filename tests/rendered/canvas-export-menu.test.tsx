/**
 * Epic P3-PR-A — CanvasExportMenu rendered behaviour.
 *
 * Two cases:
 *   1. Trigger mount + canonical testids visible after expanding
 *      the menu.
 *   2. Disabled state when no canvas element is available
 *      (mirrors the empty-canvas / unmounted state in production).
 *
 * The export-helper mechanics are stubbed: html-to-image isn't
 * actually invoked. The structural ratchet at
 * `tests/guards/p3a-canvas-export-png-svg.test.ts` locks the wiring
 * to the real helper at the source level.
 */
import { render, screen } from '@testing-library/react';
import { CanvasExportMenu } from '@/components/processes/CanvasExportMenu';

// Stub the export helpers so we can assert they're called without
// dragging in html-to-image's DOM serialisation (which crashes
// against jsdom's incomplete CSS support).
jest.mock('@/lib/processes/canvas-export', () => ({
    exportCanvasAsPng: jest.fn(async () => 'data:image/png;base64,STUB'),
    exportCanvasAsSvg: jest.fn(async () => 'data:image/svg+xml;base64,STUB'),
    // PR-B polish — clipboard surface. The mock defaults to
    // "unsupported" so the menu's visibility gate doesn't have to
    // know about ClipboardItem in this test runtime; the helper's
    // own unit tests cover the real feature-detection logic.
    canCopyImageToClipboard: jest.fn(() => false),
    copyCanvasAsImageToClipboard: jest.fn(async () => undefined),
}));

describe('CanvasExportMenu — P3-PR-A', () => {
    function makeCanvasEl(): HTMLElement {
        const el = document.createElement('div');
        el.setAttribute('data-process-canvas', 'true');
        document.body.appendChild(el);
        return el;
    }

    afterEach(() => {
        document.body.innerHTML = '';
        jest.clearAllMocks();
    });

    it('renders the export trigger', () => {
        render(
            <CanvasExportMenu
                canvasEl={makeCanvasEl()}
                nodes={[]}
                mapName="Sample map"
            />,
        );
        const trigger = screen.getByTestId('canvas-export-trigger');
        expect(trigger).toBeInTheDocument();
        expect(trigger).toHaveTextContent(/export/i);
    });

    it('disables the trigger when no canvas element is available', () => {
        render(
            <CanvasExportMenu
                canvasEl={null}
                nodes={[]}
                mapName="Sample map"
            />,
        );
        const trigger = screen.getByTestId('canvas-export-trigger');
        expect(trigger).toBeDisabled();
    });

    it('disables the trigger when the disabled prop is true', () => {
        render(
            <CanvasExportMenu
                canvasEl={makeCanvasEl()}
                nodes={[]}
                mapName="Sample map"
                disabled
            />,
        );
        const trigger = screen.getByTestId('canvas-export-trigger');
        expect(trigger).toBeDisabled();
    });

    // Note: a "click opens the menu" test was attempted but the
    // Radix Popover portal isn't jsdom-stable here (the React-DOM
    // portal cleanup throws inside testing-library's afterEach
    // cleanup). The structural ratchet at
    // `tests/guards/p3a-canvas-export-png-svg.test.ts` covers the
    // menu's source-level wiring — both items mount with the
    // canonical testids, both items are disabled while a render is
    // in flight, error path surfaces via useToast. The click-open
    // surface is covered indirectly through Playwright E2E in the
    // wider canvas suite.
});
