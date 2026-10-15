'use client';

import { useMemo } from 'react';

import { qrMatrix } from '@/lib/qr/matrix';

/**
 * QrCode — renders a value (typically a deep-link URL) as a scannable QR code
 * (feat/delight-shareables). Pure client SVG built from the module matrix —
 * no canvas, no image format, no network. Always black-on-white regardless of
 * theme: a QR must stay high-contrast to scan, so the colours are intentional
 * literals, not design tokens.
 *
 * The matrix itself comes from `@/lib/qr/matrix`, which this component used to
 * compute inline. It moved out when P6.7 (#1816) needed the same code drawn
 * into a PDF: the encoding parameters have to be one decision, or the printed
 * A6 card and the on-screen code can end up at different QR versions for the
 * same URL — and only the on-screen one can be re-issued.
 */

interface QrCodeProps {
    /** The text/URL to encode. */
    value: string;
    /** Rendered pixel size of the square. */
    size?: number;
    className?: string;
    /** Accessible label (defaults to "QR code"). */
    title?: string;
}

export function QrCode({ value, size = 128, className, title = 'QR code' }: QrCodeProps) {
    const { count, runs } = useMemo(() => qrMatrix(value), [value]);

    return (
        <svg
            viewBox={`0 0 ${count} ${count}`}
            width={size}
            height={size}
            role="img"
            aria-label={title}
            shapeRendering="crispEdges"
            className={className}
        >
            <rect width={count} height={count} fill="#ffffff" />
            {runs.map((r, i) => (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill="#000000" />
            ))}
        </svg>
    );
}

export default QrCode;
