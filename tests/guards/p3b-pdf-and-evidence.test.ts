/**
 * Epic P3-PR-B — PDF export + Evidence attachment ratchet.
 *
 * Closes the brief's #2 🟠 "Export / Print" gap for the PDF +
 * Evidence path. P3-PR-A wired client-side PNG + SVG; this PR
 * adds:
 *
 *   1. A server-side PDF endpoint that wraps the PNG bytes in a
 *      branded pdfkit document (mirrors audit-pack / risk-register
 *      output).
 *   2. An Evidence attachment flow that uploads the PNG through
 *      the canonical Evidence multipart endpoint.
 *
 * Each link in the chain has a partner; the ratchet locks them
 * together so a future refactor that silently drops one fails CI.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe("Epic P3-PR-B — PDF export + Evidence attachment", () => {
    describe("Server-side PDF generator", () => {
        const src = read("src/app-layer/reports/pdf/processMap.ts");

        it("exports generateProcessMapPdf + the canonical input shape", () => {
            // The tenant-name lookup lives INSIDE the generator
            // (same pattern as riskRegister.ts) so the route stays
            // free of direct prisma calls; the input shape carries
            // only what the caller can't infer.
            expect(src).toMatch(
                /export interface ProcessMapPdfInput \{[\s\S]{0,400}mapName:\s*string;[\s\S]{0,200}version:\s*number;[\s\S]{0,200}pngBytes:\s*Buffer;/,
            );
            expect(src).toMatch(
                /export async function generateProcessMapPdf\([\s\S]{0,400}\):\s*Promise<PDFKit\.PDFDocument>/,
            );
        });

        it("the generator looks up the tenant name via prisma (route stays prisma-free)", () => {
            expect(src).toMatch(
                /prisma\.tenant\.findUnique\([\s\S]{0,200}id:\s*ctx\.tenantId/,
            );
        });

        it("reuses the audit-pack PDF factory (createPdfDocument + cover + footer)", () => {
            // Anchor the imports — the visual cohesion across
            // exports depends on every generator hitting the
            // same three helpers.
            expect(src).toMatch(/createPdfDocument/);
            expect(src).toMatch(/addCoverPage/);
            expect(src).toMatch(/applyHeadersAndFooters/);
        });

        it("embeds the PNG bytes via doc.image with fit-to-content", () => {
            expect(src).toMatch(
                /doc\.image\(input\.pngBytes,[\s\S]{0,200}fit:\s*\[availableWidth,\s*availableHeight\]/,
            );
        });
    });

    describe("Server route /api/t/<slug>/processes/<id>/export-pdf", () => {
        const routePath =
            "src/app/api/t/[tenantSlug]/processes/[id]/export-pdf/route.ts";

        it("exists at the canonical Next.js path", () => {
            expect(exists(routePath)).toBe(true);
        });

        const src = read(routePath);

        it("forces nodejs runtime (pdfkit needs stream / zlib / Buffer)", () => {
            expect(src).toMatch(/export const runtime = ['"]nodejs['"]/);
        });

        it("zod-validates the body shape (pngDataUrl with the canonical prefix)", () => {
            expect(src).toMatch(/data:image\/png;base64,/);
            expect(src).toMatch(/\.startsWith\(['"]data:image\/png;base64,['"]\)/);
        });

        it("looks the map up via the canonical usecase + denies cross-tenant access", () => {
            // `getProcessMap` calls assertCanRead + tenant-scopes
            // the lookup; the route's only auth is its tenantSlug
            // gate via getTenantCtx + this read.
            expect(src).toMatch(
                /getProcessMap\(ctx,\s*params\.id\)/,
            );
        });

        it("returns application/pdf with an attachment disposition", () => {
            expect(src).toMatch(/['"]Content-Type['"]:\s*['"]application\/pdf['"]/);
            // #1343 — this used to pin the LITERAL header shape,
            // `attachment;\s*filename=`, and that is the defect #1343's own
            // text names in this guard's sibling: pinning the mechanism rather
            // than the property means the guard cannot notice when the
            // mechanism is wrong, and DOES fail when it is improved. It broke
            // the moment the header moved behind `contentDisposition`, which
            // was a strict improvement — the literal form it required is the
            // ASCII-only one that destroyed Cyrillic filenames.
            //
            // So it now pins the property: the route sets a disposition, via
            // the one helper allowed to build one. The header's SHAPE is
            // tested behaviourally in `tests/unit/content-disposition.test.ts`,
            // through a real Response, which is where a shape assertion
            // belongs.
            expect(src).toMatch(
                /['"]Content-Disposition['"]:\s*contentDisposition\(/,
            );
        });
    });

    describe("Client helpers — exportCanvasAsPdf + attachCanvasPngToEvidence", () => {
        const src = read("src/lib/processes/canvas-export.ts");

        it("exports both helpers with the canonical extended options", () => {
            expect(src).toMatch(
                /export async function exportCanvasAsPdf\(\s*opts:\s*CanvasExportServerRouteOptions,?\s*\):\s*Promise<void>/,
            );
            expect(src).toMatch(
                /export async function attachCanvasPngToEvidence\(\s*opts:\s*CanvasExportServerRouteOptions,?\s*\):\s*Promise<\{\s*evidenceId:\s*string\s*\}>/,
            );
            expect(src).toMatch(
                /interface CanvasExportServerRouteOptions extends CanvasExportOptions \{[\s\S]{0,200}tenantSlug:\s*string;[\s\S]{0,200}mapId:\s*string;/,
            );
        });

        it("PDF helper POSTs the base64 dataUrl to the canonical route", () => {
            expect(src).toMatch(
                /\/api\/t\/\$\{opts\.tenantSlug\}\/processes\/\$\{opts\.mapId\}\/export-pdf/,
            );
            expect(src).toMatch(/JSON\.stringify\(\{\s*pngDataUrl\s*\}\)/);
        });

        it("Evidence helper hits the canonical multipart endpoint + sets title + category", () => {
            expect(src).toMatch(
                /\/api\/t\/\$\{opts\.tenantSlug\}\/evidence\/uploads/,
            );
            expect(src).toMatch(/form\.append\(['"]title['"]/);
            expect(src).toMatch(
                /form\.append\(['"]category['"],\s*['"]PROCESS_MAP['"]/,
            );
        });

        it("PDF helper revokes the blob URL to avoid leaks", () => {
            expect(src).toMatch(/URL\.revokeObjectURL/);
        });
    });

    describe("CanvasExportMenu — surfaces the two new items", () => {
        const src = read("src/components/processes/CanvasExportMenu.tsx");

        it("imports both new helpers", () => {
            expect(src).toMatch(/exportCanvasAsPdf/);
            expect(src).toMatch(/attachCanvasPngToEvidence/);
        });

        it("accepts the optional tenantSlug + mapId props", () => {
            expect(src).toMatch(/tenantSlug\?:\s*string;/);
            expect(src).toMatch(/mapId\?:\s*string;/);
        });

        it("renders the two new menu items only when tenantSlug + mapId are set", () => {
            // The PDF + Evidence items are gated on
            // `showServerItems` (which derives from tenantSlug +
            // mapId). Anchor the gate + the testids.
            expect(src).toMatch(/showServerItems\s*=\s*Boolean\(tenantSlug\s*&&\s*mapId\)/);
            for (const id of [
                "canvas-export-pdf",
                "canvas-export-evidence",
            ]) {
                expect(src).toMatch(new RegExp(`data-testid="${id}"`));
            }
            // Items live INSIDE the showServerItems conditional —
            // anchor it.
            expect(src).toMatch(
                /\{showServerItems &&[\s\S]{0,400}canvas-export-pdf/,
            );
        });

        it("the run handler dispatches 4 kinds (png/svg/pdf/evidence)", () => {
            expect(src).toMatch(
                /kind:\s*["']png["']\s*\|\s*["']svg["']\s*\|\s*["']pdf["']\s*\|\s*["']evidence["']/,
            );
        });

        it("Evidence success surfaces toast.success", () => {
            expect(src).toMatch(
                /toast\.success\(t\("canvasExport\.attachedToEvidence"\)/,
            );
        });
    });

    describe("PersistedProcessCanvas — passes tenantSlug + mapId to the menu", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("threads tenantSlug + activeId to CanvasExportMenu", () => {
            expect(src).toMatch(
                /<CanvasExportMenu[\s\S]{0,500}tenantSlug=\{tenantSlug\}[\s\S]{0,200}mapId=\{activeId\}/,
            );
        });
    });
});
