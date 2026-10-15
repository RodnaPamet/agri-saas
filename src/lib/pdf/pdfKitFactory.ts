/**
 * PDFKit Document Factory
 *
 * Creates pre-configured PDFKit documents with consistent margins,
 * metadata, and brand colors.
 */
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import type { ReportMeta } from './types';

// ─── Unicode (Cyrillic) fonts ───
//
// PDFKit's built-in Standard-14 'Helvetica' is AFM/latin-only and renders
// tofu for Cyrillic. DejaVu Sans (bundled under ./fonts, Bitstream Vera
// license) has full Cyrillic coverage. Loaded once + cached as Buffers.
//
// IMPORTANT: DejaVu is registered under its OWN names (below), NOT over the
// 'Helvetica' names. In pdfkit 0.19.x, `registerFont('Helvetica', ttf)` is
// unreliable — a standard font name resolves to the built-in AFM face
// depending on call order (so Cyrillic silently tofus). A distinct name
// always embeds. Unicode generators MUST use these font names.
export const UNICODE_FONT = 'DejaVuSans';
export const UNICODE_FONT_BOLD = 'DejaVuSans-Bold';

const FONT_DIR = path.join(process.cwd(), 'src', 'lib', 'pdf', 'fonts');
let _unicodeFonts: { regular: Buffer; bold: Buffer } | null = null;

function loadUnicodeFonts(): { regular: Buffer; bold: Buffer } {
    if (!_unicodeFonts) {
        _unicodeFonts = {
            regular: fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf')),
            bold: fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')),
        };
    }
    return _unicodeFonts;
}

// ─── Brand Tokens ───

export const BRAND = {
    navy:       '#0f172a',
    purple:     '#7c3aed',
    slate:      '#64748b',
    slateLight: '#94a3b8',
    white:      '#ffffff',
    lightGray:  '#f1f5f9',
    medGray:    '#e2e8f0',
    red:        '#ef4444',
    amber:      '#f59e0b',
    green:      '#22c55e',
} as const;

// ─── Margins ───

export const MARGINS = {
    top: 60,
    bottom: 50,
    left: 50,
    right: 50,
} as const;

export const PAGE_WIDTH = 595.28;    // A4 portrait width (pt)
export const PAGE_HEIGHT = 841.89;   // A4 portrait height (pt)
export const CONTENT_WIDTH = PAGE_WIDTH - MARGINS.left - MARGINS.right;

/**
 * Page geometry, for the documents that are not A4 reports.
 *
 * Added by P6.7 (#1816) for the A6 share card. Every field is optional and
 * the defaults are the values this factory has always hard-coded, so the five
 * existing generators are byte-identical without passing anything.
 *
 * `size` takes pdfkit's own ISO names rather than a points pair: `'A6'`
 * resolves to 297.64 x 419.53 pt from pdfkit's table, so the paper size is
 * never a local constant that can drift from the ISO definition. A `[w, h]`
 * pair stays available for a genuinely custom sheet.
 */
export interface PdfPageOptions {
    /** pdfkit size name (`'A4'`, `'A6'`, ...) or an explicit `[w, h]` in points. */
    size?: string | [number, number];
    margins?: { top: number; bottom: number; left: number; right: number };
    layout?: 'portrait' | 'landscape';
}

/**
 * Create a new PDFKit document with branding defaults.
 */
export function createPdfDocument(
    meta: ReportMeta,
    page: PdfPageOptions = {},
): PDFKit.PDFDocument {
    const doc = new PDFDocument({
        size: page.size ?? 'A4',
        margins: page.margins ? { ...page.margins } : { ...MARGINS },
        layout: page.layout ?? 'portrait',
        bufferPages: true,  // enables page counting for footers
        info: {
            Title: meta.reportTitle,
            Author: meta.tenantName,
            Subject: meta.reportSubtitle || meta.reportTitle,
            Creator: 'Agrent',
            Producer: 'PDFKit',
            CreationDate: new Date(meta.generatedAt),
        },
    });

    // Unicode documents (e.g. the Bulgarian БАБХ ДНЕВНИК) register DejaVu
    // Sans under its own names (UNICODE_FONT / UNICODE_FONT_BOLD) and make it
    // the default face. The generator MUST call `.font(UNICODE_FONT[_BOLD])`.
    // 'latin' reports register nothing and keep the built-in AFM Helvetica.
    if (meta.fontFamily === 'unicode') {
        const fonts = loadUnicodeFonts();
        doc.registerFont(UNICODE_FONT, fonts.regular);
        doc.registerFont(UNICODE_FONT_BOLD, fonts.bold);
        doc.font(UNICODE_FONT);
    }

    return doc;
}
