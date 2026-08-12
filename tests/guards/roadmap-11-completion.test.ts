/**
 * Roadmap-11 PR-12 — round completion + obsession checklist.
 *
 * Closing PR of the Delight round. Locks the artefacts shipped
 * this round so a future "cleanup" PR can't silently delete one
 * and reopen the regression surface.
 *
 *   - PR-1   EmptyState personality on every list page
 *   - PR-2   Skeleton shimmer-sweep + loading.tsx adoption
 *   - PR-3   ErrorState on both route-level error.tsx boundaries
 *   - PR-4   Button press-feedback microinteraction
 *   - PR-5   Animation language lock (durations + easings)
 *   - PR-6   Practices detail tasks sub-table → DataTable
 *   - PR-7   Vendors detail documents sub-table → DataTable
 *   - PR-8   Tasks detail links sub-table → DataTable
 *   - PR-9   Viewport metadata + mobile-readiness ratchet
 *   - PR-10  ChecklistCard primitive
 *   - PR-11  Chart ease-out polish
 *
 * The round shipped 7 new ratchet files, 2 new primitives
 * (`<ChecklistCard>`, `<Skeleton>` shimmer-sweep variant), and 6
 * detail-page sub-table migrations across 3 entity types.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** R11 ratchet files (excluding this one). */
const ROADMAP_11_RATCHETS = [
    'tests/guards/empty-state-personality.test.ts',
    'tests/guards/skeleton-shimmer-adoption.test.ts',
    'tests/guards/error-state-adoption.test.ts',
    'tests/guards/button-press-feedback.test.ts',
    'tests/guards/animation-language-lock.test.ts',
    'tests/guards/mobile-readiness.test.ts',
    'tests/guards/chart-animation-lock.test.ts',
];

/** R11 primitive deliverables. */
const ROADMAP_11_PRIMITIVES = [
    'src/components/ui/checklist-card.tsx',
];

interface ObsessionItem {
    /** Human-readable invariant (grep target). */
    name: string;
    /** File that enforces / demonstrates it. */
    ratchet: string;
}

const OBSESSION_CHECKLIST: ObsessionItem[] = [
    // ─── Empty / loading / error trinity ──────────────────────────
    {
        name: 'empty pages on every list page route through EmptyState with the canonical { size: sm, variant } shape',
        ratchet: 'tests/guards/empty-state-personality.test.ts',
    },
    {
        name: 'skeleton primitive renders a gradient-sweep shimmer (not the legacy opacity flicker)',
        ratchet: 'tests/guards/skeleton-shimmer-adoption.test.ts',
    },
    {
        name: 'every loading.tsx routes through the shared Skeleton primitive',
        ratchet: 'tests/guards/skeleton-shimmer-adoption.test.ts',
    },
    {
        name: 'both route-level error.tsx boundaries render through <ErrorState>',
        ratchet: 'tests/guards/error-state-adoption.test.ts',
    },

    // ─── Microinteraction + motion ────────────────────────────────
    {
        name: 'every <Button> variant inherits press-down scale on :active (3% shrink)',
        ratchet: 'tests/guards/button-press-feedback.test.ts',
    },
    {
        name: 'duration values are bounded to a locked set (no `duration-[Xms]` brackets)',
        ratchet: 'tests/guards/animation-language-lock.test.ts',
    },
    {
        name: 'easing keywords are bounded to a locked set (no `ease-[cubic-bezier(...)]` brackets)',
        ratchet: 'tests/guards/animation-language-lock.test.ts',
    },
    {
        name: 'chart segment transitions use ease-out (settles-into-place tone)',
        ratchet: 'tests/guards/chart-animation-lock.test.ts',
    },

    // ─── Detail-page chrome refresh ───────────────────────────────
    {
        name: 'farm task detail page has zero raw <table> elements',
        ratchet: 'src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx',
    },

    // ─── Scope ────────────────────────────────────────────────────
    {
        name: 'root layout exports an accessible viewport (pinch-zoom preserved)',
        ratchet: 'tests/guards/mobile-readiness.test.ts',
    },
    {
        name: 'ChecklistCard primitive available for onboarding / multi-step flows',
        ratchet: 'src/components/ui/checklist-card.tsx',
    },
];

describe('Roadmap-11 round completion (PR-12)', () => {
    test('every R11 ratchet file exists', () => {
        const missing: string[] = [];
        for (const rel of ROADMAP_11_RATCHETS) {
            if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `R11 ratchet file(s) missing — was one deleted?\n  ` +
                    missing.join('\n  '),
            );
        }
    });

    test('every R11 primitive file exists', () => {
        const missing: string[] = [];
        for (const rel of ROADMAP_11_PRIMITIVES) {
            if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `R11 primitive file(s) missing:\n  ` + missing.join('\n  '),
            );
        }
    });

    test('every obsession-checklist entry points at a real file', () => {
        const missing: string[] = [];
        for (const item of OBSESSION_CHECKLIST) {
            if (!fs.existsSync(path.join(ROOT, item.ratchet))) {
                missing.push(`${item.name} -> ${item.ratchet}`);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Obsession-checklist entries point at missing files:\n  ` +
                    missing.join('\n  '),
            );
        }
    });

    test('obsession-checklist captures at least 12 audited items', () => {
        expect(OBSESSION_CHECKLIST.length).toBeGreaterThanOrEqual(12);
    });
});
