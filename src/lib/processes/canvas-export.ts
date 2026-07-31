"use client";

/**
 * Epic P3-PR-A — Process canvas export helpers (PNG / SVG).
 *
 * Auditors need process maps as evidence artefacts. Pre-P3 the
 * only path was a browser screenshot. This module wraps
 * `html-to-image` + xyflow's `getNodesBounds` / `getViewportForBounds`
 * helpers to produce a clean image of just the canvas plane (no
 * sidebars, no chrome strip, no controls overlay).
 *
 * Why html-to-image:
 *   - xyflow's official PNG/SVG recipe uses html-to-image. The
 *     library serialises the live DOM (including computed styles)
 *     into a foreignObject SVG which we then either rasterise to
 *     canvas (PNG) or save directly (SVG). Other approaches
 *     (renderToString → manual DOM clone) miss CSS variable
 *     resolution, which means our `--canvas-frame` / token-driven
 *     colours wouldn't survive the export.
 *
 * Why the helper computes its own viewport:
 *   - xyflow's `getViewportForBounds` returns the zoom/translate
 *     that fits all nodes in a target rect. Without this, the
 *     export would capture whatever scroll/zoom the user is
 *     currently looking at — meaningless if they were zoomed in on
 *     one node.
 *
 * What gets EXCLUDED from the image:
 *   - The `<Controls>` zoom strip (bottom-left) — has no place in
 *     an audit artefact.
 *   - The minimap — already removed (#731), so no special-case.
 *   - Hover affordances, selection rings — naturally absent
 *     because no node is selected at export time (callers should
 *     deselect first; the helper doesn't enforce it).
 */

import { toPng, toSvg } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "@xyflow/react";

const EXPORT_PADDING = 24;
const EXPORT_MIN_ZOOM = 0.25;
const EXPORT_MAX_ZOOM = 2.0;
// Mirrors of the `--canvas-frame` token in each theme (src/styles/tokens.css).
// html-to-image cannot resolve CSS custom properties, so the value is
// duplicated here — keep both in lockstep with the token.
const EXPORT_BG_LIGHT = "#FBFAF8";
const EXPORT_BG_DARK = "#082E22";

export interface CanvasExportOptions {
    /**
     * xyflow `<ReactFlow>` viewport element. The helper walks up
     * to find it from the canvas wrapper; the caller passes the
     * wrapper (e.g. the `[data-process-canvas="true"]` element).
     */
    canvasEl: HTMLElement;
    /** Live node list, used to compute the fit-to-content viewport. */
    nodes: Node[];
    /** Map name — used as the download filename stem. */
    mapName: string;
    /**
     * Pixel ratio for PNG raster. 2 for retina, 1 for smaller
     * downloads. Defaults to the device's natural ratio.
     */
    pixelRatio?: number;
}

/**
 * Find the xyflow viewport child of a `data-process-canvas`
 * wrapper. xyflow renders nodes inside `.react-flow__viewport`;
 * we capture that subtree so the Controls + Background siblings
 * stay out of the image.
 */
function resolveViewportEl(canvasEl: HTMLElement): HTMLElement | null {
    return canvasEl.querySelector<HTMLElement>(".react-flow__viewport");
}

/**
 * Compute the bounds of every node + the zoom+translate that fits
 * those bounds into the export rect. The rect itself is the union
 * of node bounding boxes, padded.
 */
function exportTransform(nodes: Node[]): {
    width: number;
    height: number;
    transform: [number, number, number];
} {
    if (nodes.length === 0) {
        return { width: 800, height: 600, transform: [0, 0, 1] };
    }
    const bounds = getNodesBounds(nodes);
    const width = Math.max(bounds.width + EXPORT_PADDING * 2, 320);
    const height = Math.max(bounds.height + EXPORT_PADDING * 2, 240);
    const viewport = getViewportForBounds(
        bounds,
        width,
        height,
        EXPORT_MIN_ZOOM,
        EXPORT_MAX_ZOOM,
        EXPORT_PADDING / Math.max(width, height),
    );
    return {
        width,
        height,
        transform: [viewport.x, viewport.y, viewport.zoom],
    };
}

function downloadDataUrl(dataUrl: string, filename: string): void {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function safeFilename(mapName: string, ext: string): string {
    const stem = mapName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "process-map";
    return `${stem}.${ext}`;
}

function resolveBackground(): string {
    // Read the current theme's canvas-frame token so the export
    // matches what the user sees. Falls back to the light token in
    // SSR / test contexts where `document` isn't available.
    if (typeof document === "undefined") return EXPORT_BG_LIGHT;
    const root = document.documentElement;
    const theme = root.getAttribute("data-theme");
    if (theme === "light") return EXPORT_BG_LIGHT;
    return EXPORT_BG_DARK;
}

/**
 * Export the canvas as a PNG. The download fires immediately as
 * a side-effect (browser download prompt). Returns the data URL
 * so callers can also surface it (e.g. P3-PR-B's Evidence
 * attachment flow).
 */
export async function exportCanvasAsPng(
    opts: CanvasExportOptions,
): Promise<string> {
    const viewportEl = resolveViewportEl(opts.canvasEl);
    if (!viewportEl) {
        throw new Error("Canvas viewport not found");
    }
    const { width, height, transform } = exportTransform(opts.nodes);
    const dataUrl = await toPng(viewportEl, {
        backgroundColor: resolveBackground(),
        width,
        height,
        pixelRatio: opts.pixelRatio,
        style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${transform[2]})`,
        },
    });
    downloadDataUrl(dataUrl, safeFilename(opts.mapName, "png"));
    return dataUrl;
}

/**
 * Export the canvas as an SVG. Returns the SVG data URL.
 */
export async function exportCanvasAsSvg(
    opts: CanvasExportOptions,
): Promise<string> {
    const viewportEl = resolveViewportEl(opts.canvasEl);
    if (!viewportEl) {
        throw new Error("Canvas viewport not found");
    }
    const { width, height, transform } = exportTransform(opts.nodes);
    const dataUrl = await toSvg(viewportEl, {
        backgroundColor: resolveBackground(),
        width,
        height,
        style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${transform[2]})`,
        },
    });
    downloadDataUrl(dataUrl, safeFilename(opts.mapName, "svg"));
    return dataUrl;
}

/**
 * PR-B polish — Copy the canvas as a PNG into the OS clipboard.
 *
 * Why a separate function (not a flag on `exportCanvasAsPng`):
 *   - The PNG export downloads a file; copying writes to the
 *     clipboard. They look the same upstream but the side-effect
 *     is what the caller actually cares about. Splitting keeps
 *     each entrypoint's contract crisp.
 *
 * Browser support:
 *   - Chrome / Edge / Safari 13.4+ / Firefox 127+ implement
 *     `navigator.clipboard.write([new ClipboardItem({...})])` with
 *     image MIME types. We feature-detect at the top and throw a
 *     human-readable error if either piece is missing so the
 *     caller can toast it cleanly.
 *
 * Permissions:
 *   - Modern browsers grant clipboard-write silently when the
 *     write happens inside a user-gesture event handler (a click).
 *     The CanvasExportMenu fires from a click → no `permissions`
 *     prompt needed.
 */
export async function copyCanvasAsImageToClipboard(
    opts: CanvasExportOptions,
): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.write) {
        throw new Error(
            "Your browser doesn't support copying images to the clipboard.",
        );
    }
    if (typeof ClipboardItem === "undefined") {
        throw new Error(
            "Your browser doesn't support copying images to the clipboard.",
        );
    }
    const viewportEl = resolveViewportEl(opts.canvasEl);
    if (!viewportEl) {
        throw new Error("Canvas viewport not found");
    }
    const { width, height, transform } = exportTransform(opts.nodes);
    const dataUrl = await toPng(viewportEl, {
        backgroundColor: resolveBackground(),
        width,
        height,
        pixelRatio: opts.pixelRatio,
        style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${transform[2]})`,
        },
    });
    // Convert the dataURL → Blob. The slice strips the
    // `data:image/png;base64,` prefix; the rest is base64 PNG.
    const base64 = dataUrl.slice("data:image/png;base64,".length);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
    ]);
}

/**
 * Cheap runtime check the menu uses to decide whether to show the
 * "Copy as image" item at all. Same feature-detection shape as the
 * top of `copyCanvasAsImageToClipboard` so the menu's visibility
 * matches the function's actual behaviour.
 */
export function canCopyImageToClipboard(): boolean {
    if (typeof navigator === "undefined") return false;
    if (!navigator.clipboard?.write) return false;
    if (typeof ClipboardItem === "undefined") return false;
    return true;
}

// ─── Epic P3-PR-B — PDF + Evidence attachment ──────────────────────

export interface CanvasExportServerRouteOptions extends CanvasExportOptions {
    /** Tenant slug + map id for the server-side endpoints. */
    tenantSlug: string;
    mapId: string;
}

/**
 * Render the canvas as a PNG (in-memory, no download), then POST
 * the base64 bytes to the server's PDF endpoint. The endpoint
 * wraps the image in a branded PDF using pdfkit (mirrors audit-
 * pack format). The PDF download fires immediately.
 */
export async function exportCanvasAsPdf(
    opts: CanvasExportServerRouteOptions,
): Promise<void> {
    const viewportEl = resolveViewportEl(opts.canvasEl);
    if (!viewportEl) {
        throw new Error("Canvas viewport not found");
    }
    const { width, height, transform } = exportTransform(opts.nodes);
    const pngDataUrl = await toPng(viewportEl, {
        backgroundColor: resolveBackground(),
        width,
        height,
        pixelRatio: opts.pixelRatio,
        style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${transform[2]})`,
        },
    });
    const res = await fetch(
        `/api/t/${opts.tenantSlug}/processes/${opts.mapId}/export-pdf`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pngDataUrl }),
        },
    );
    if (!res.ok) {
        throw new Error(`PDF export failed (${res.status})`);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    try {
        downloadDataUrl(blobUrl, safeFilename(opts.mapName, "pdf"));
    } finally {
        // The browser holds the blob until the download starts;
        // revoke shortly after so we don't leak the blob URL.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }
}

/**
 * Render the canvas as a PNG, then upload it through the canonical
 * Evidence file-upload endpoint. Surfaces consistently in the
 * Evidence list + audit-pack picker.
 */
export async function attachCanvasPngToEvidence(
    opts: CanvasExportServerRouteOptions,
): Promise<{ evidenceId: string }> {
    const viewportEl = resolveViewportEl(opts.canvasEl);
    if (!viewportEl) {
        throw new Error("Canvas viewport not found");
    }
    const { width, height, transform } = exportTransform(opts.nodes);
    const pngDataUrl = await toPng(viewportEl, {
        backgroundColor: resolveBackground(),
        width,
        height,
        pixelRatio: opts.pixelRatio,
        style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${transform[0]}px, ${transform[1]}px) scale(${transform[2]})`,
        },
    });
    // Convert dataURL → Blob → File (the multipart endpoint wants
    // a File). dataURL is `data:image/png;base64,...`.
    const base64 = pngDataUrl.slice("data:image/png;base64,".length);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    const filename = safeFilename(opts.mapName, "png");
    const file = new File([blob], filename, { type: "image/png" });

    const form = new FormData();
    form.append("file", file);
    form.append("title", `${opts.mapName} — Process Map`);
    form.append("category", "PROCESS_MAP");

    const res = await fetch(
        `/api/t/${opts.tenantSlug}/evidence/uploads`,
        { method: "POST", body: form },
    );
    if (!res.ok) {
        throw new Error(`Evidence upload failed (${res.status})`);
    }
    const body = (await res.json()) as { id?: string; evidenceId?: string };
    const evidenceId = body.id ?? body.evidenceId ?? "";
    return { evidenceId };
}

// Test-only exports — keep the seams visible so the rendered test
// can stub the helpers without poking at module internals.
export const __INTERNAL = {
    safeFilename,
    exportTransform,
    resolveViewportEl,
};
