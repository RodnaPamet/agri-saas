/**
 * Epic 59 — chart / progress bypass guardrail.
 *
 * When an app-layer page renders a sparkline, progress visual, or
 * multi-segment distribution, it must use the shared chart platform:
 *   `@/components/ui/charts`
 *   `@/components/ui/TrendCard`
 *   `@/components/ui/progress-bar`        (single-value progress)
 *   `@/components/ui/progress-circle`     (ring progress)
 *   `@/components/ui/status-breakdown`    (multi-segment distribution)
 *   `@/components/ui/mini-area-chart`
 *
 * This guard scans every tenant-scoped `(app)/**\/*.tsx` file — not
 * just `/dashboard/page.tsx`. Scope was broadened on 2026-04-22
 * after the `<StatusBreakdown>` rollout closed the remaining inline
 * bars on detail pages (frameworks, risks, audits, practices,
 * mapping, coverage) — dashboards were never the only hotspot.
 *
 * New contributors adding a raw SVG polyline, an inline
 * `style={{ width: `${pct}%` }}` progress bar, or an import of the
 * removed `TrendLine` will fail here with a pointer to
 * `docs/charts.md`.
 *
 * Add new banned patterns as the platform grows — don't loosen the
 * net.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)',
);

function walk(dir: string, acc: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
            acc.push(full);
        }
    }
    return acc;
}

function collectTenantAppPages(): string[] {
    return walk(APP_ROOT, []);
}

interface Violation {
    file: string;
    pattern: string;
    snippet: string;
}

/**
 * A match on a banned pattern is suppressed when a nearby line carries
 * the annotation `// chart-bypass-ok: <reason>` — letting contributors
 * grandfather intentional categorical widgets (e.g. horizontal status
 * distribution bars) while keeping the net tight for future additions.
 */
const SUPPRESSION_TAG = 'chart-bypass-ok:';
const SUPPRESSION_WINDOW = 4;

function isSuppressed(lines: string[], lineIndex: number): boolean {
    const lo = Math.max(0, lineIndex - SUPPRESSION_WINDOW);
    const hi = Math.min(lines.length - 1, lineIndex + SUPPRESSION_WINDOW);
    for (let i = lo; i <= hi; i++) {
        if (lines[i].includes(SUPPRESSION_TAG)) return true;
    }
    return false;
}

function scanFile(file: string): Violation[] {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const violations: Violation[] = [];

    // (1) Legacy TrendLine import — the file is deleted but a resurrected
    // copy or a reverted merge would bring it back.
    lines.forEach((line, i) => {
        if (
            line.includes("from '@/components/ui/TrendLine'") ||
            line.includes('from "@/components/ui/TrendLine"')
        ) {
            if (isSuppressed(lines, i)) return;
            violations.push({
                file,
                pattern: 'TrendLine import (legacy — use TrendCard or MiniAreaChart)',
                snippet: line.trim(),
            });
        }
    });

    // (2) Raw <polyline> SVG — sparklines should go through MiniAreaChart
    // or TrendCard. A legitimate <polyline> in a dashboard page is rare
    // enough that we treat any occurrence as a bypass.
    lines.forEach((line, i) => {
        if (/<polyline\b/.test(line)) {
            if (isSuppressed(lines, i)) return;
            violations.push({
                file,
                pattern: 'raw <polyline> (use MiniAreaChart or TrendCard)',
                snippet: line.trim(),
            });
        }
    });

    // (3) Hand-rolled inline percentage-width progress bars.
    //   style={{ width: `${pct}%` }}
    //   style={{ width: `${Math.min(100, value)}%` }}
    const inlineWidthPercent = /style=\{\{\s*width:\s*`\$\{[^`]+\}%`/;
    lines.forEach((line, i) => {
        if (inlineWidthPercent.test(line)) {
            if (isSuppressed(lines, i)) return;
            violations.push({
                file,
                pattern:
                    'inline style={{ width: `${…}%` }} (use ProgressBar for single-value, StatusBreakdown for multi-segment)',
                snippet: line.trim().slice(0, 120),
            });
        }
    });

    return violations;
}

describe('Epic 59 — chart / progress bypass guard', () => {
    const pages = collectTenantAppPages();

    it('discovers the tenant-scoped (app) tree', () => {
        // Sanity: the discovery must see a substantial chunk of the
        // migrated surface. Before 2026-04-22 this was ~5 dashboards;
        // post-broadening the scope covers every tenant-scoped .tsx
        // so the floor is much higher. If a future refactor moves
        // the tree, this trips early instead of silently passing
        // with zero files.
        expect(pages.length).toBeGreaterThanOrEqual(50);
        for (const p of pages) {
            expect(fs.existsSync(p)).toBe(true);
        }
    });

    it('no page bypasses the shared chart / progress platform', () => {
        const all: Violation[] = [];
        for (const p of pages) {
            all.push(...scanFile(p));
        }
        if (all.length > 0) {
            const lines = all.map(
                (v) =>
                    `  • ${path.relative(process.cwd(), v.file)}\n      pattern: ${v.pattern}\n      match:   ${v.snippet}`,
            );
            throw new Error(
                [
                    'Chart / progress bypass detected. See docs/charts.md for the decision tree:',
                    '  • single-value     → <ProgressBar>',
                    '  • multi-segment    → <StatusBreakdown>',
                    '  • sparkline        → <MiniAreaChart> / <TrendCard>',
                    '  • ring             → <ProgressCircle>',
                    '  • time series      → <TimeSeriesChart>',
                    '',
                    ...lines,
                ].join('\n'),
            );
        }
        expect(all).toEqual([]);
    });
});
