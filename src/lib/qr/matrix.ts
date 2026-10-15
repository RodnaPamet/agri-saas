/**
 * The QR module matrix, computed in one place and shared by every surface
 * that draws one.
 *
 * ## Why this is not inside the React component any more
 *
 * `QrCode` (`src/components/ui/qr-code.tsx`) held the only copy, and P6.7
 * (#1816) needs the same code **on paper**: the A6 share card is a
 * server-rendered PDF, so the matrix has to be computed in node and drawn as
 * pdfkit rectangles rather than SVG `<rect>`s.
 *
 * Two copies of "type 0, error-correction M, coalesce each row" is how the
 * printed card and the on-screen code come to encode the same URL at
 * different versions — and the printed one is the copy nobody can re-issue.
 * #1816 raises exactly this class of hazard for handles, which is the reason
 * the parameters live here once and both renderers consume them.
 * `tests/unit/qr-matrix-is-shared.test.ts` asserts both call THIS function
 * rather than agreeing by coincidence.
 *
 * ## Deliberately pure
 *
 * No logger, no `env`, no `getAppBaseUrl`. This module is imported by a
 * `'use client'` component, and anything here that reached a server-only
 * dependency would fail the BUILD with `UnhandledSchemeError:
 * node:async_hooks` — which `tsc`, lint and the whole rendered-test suite are
 * blind to, as #1874 established the hard way.
 *
 * `qrcode-generator` itself is isomorphic (zero dependencies, no DOM, no node
 * built-ins), which is what makes the sharing possible at all.
 */
import QRCode from 'qrcode-generator';

/**
 * Error-correction level.
 *
 * `'M'` (~15% recoverable) rather than `'L'` (~7%): the payload is a short
 * URL so the denser level costs nothing in version, and a card that lives in
 * a coat pocket or pinned to a market stall acquires a fold and a thumbprint.
 * `'H'` would be larger for no gain at this payload size.
 */
export const QR_ERROR_CORRECTION = 'M';

/** Type 0 = auto: the smallest QR version that fits the payload. */
export const QR_TYPE_NUMBER = 0;

/** A horizontal run of dark modules: `w` modules starting at (`x`, `y`). */
export interface QrRun {
    readonly x: number;
    readonly y: number;
    readonly w: number;
}

export interface QrMatrix {
    /** Modules per side (the QR version's size, e.g. 29 for version 3). */
    readonly count: number;
    /** Dark modules, coalesced per row. */
    readonly runs: readonly QrRun[];
}

/**
 * Encode `value` and return its dark modules as per-row runs.
 *
 * Runs rather than individual modules because both consumers benefit: the SVG
 * keeps its node count low, and the PDF keeps its content stream small. The
 * coalescing is also what makes the two renderings byte-comparable in a test.
 */
export function qrMatrix(value: string): QrMatrix {
    const qr = QRCode(QR_TYPE_NUMBER, QR_ERROR_CORRECTION);
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();

    const runs: QrRun[] = [];
    for (let row = 0; row < count; row++) {
        let start = -1;
        for (let col = 0; col < count; col++) {
            const dark = qr.isDark(row, col);
            if (dark && start === -1) start = col;
            if ((!dark || col === count - 1) && start !== -1) {
                // A run that reaches the last column ends ON it; one that
                // stops because the module went light ended the column
                // before.
                const end = dark ? col : col - 1;
                runs.push({ x: start, y: row, w: end - start + 1 });
                start = -1;
            }
        }
    }

    return { count, runs };
}
