/**
 * Roadmap-10 PR-12 — round completion + obsession checklist.
 *
 * Closing PR of the Tables-and-Gear refinement round. Two artefacts:
 *
 *   1. R10 deliverables registry — ROADMAP_10_RATCHETS lists every
 *      ratchet shipped this round so a future "cleanup" PR can't
 *      silently delete one and reopen the regression surface. Same
 *      shape as `roadmap-9-completion.test.ts`.
 *
 *   2. Obsession-checklist — small but cumulative refinement items
 *      this round audited. Each item is paired with the ratchet
 *      (or visible-uplift code) that enforces it. The list is the
 *      "did we audit this" memory of the round.
 *
 * Why a meta-ratchet: refinement rounds aggregate many small
 * decisions. Without a central index, the next round risks
 * re-litigating settled points or missing an undone one.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** R10 deliverable ratchets. Locked at round close. */
const ROADMAP_10_RATCHETS = [
    'tests/guards/no-raw-tables-in-app-pages.test.ts',
    'tests/guards/table-unification.test.ts',
    'tests/guards/columns-dropdown-coverage.test.ts',
    'tests/guards/detail-page-back-prop-ban.test.ts',
    'tests/guards/status-badge-no-brand.test.ts',
];

/** R10 primitive deliverables — the unified column-visibility hook. */
const ROADMAP_10_PRIMITIVES = [
    'src/components/ui/table/use-columns-dropdown.tsx',
];

interface ObsessionItem {
    /** OBSESSION: <human-readable name> — grep-friendly. */
    name: string;
    /** Ratchet file or production code that enforces / proves the rule. */
    ratchet: string;
}

const OBSESSION_CHECKLIST: ObsessionItem[] = [
    // ─── Tables anchor (the round's headline) ──────────────────────
    {
        // OBSESSION: raw <table> ban in app pages (3 list migrations + 7 legit exemptions)
        name: 'raw <table> in app pages must migrate to DataTable or be in EXEMPTIONS',
        ratchet: 'tests/guards/no-raw-tables-in-app-pages.test.ts',
    },
    {
        // OBSESSION: admin/rbac members migrated to DataTable
        name: 'admin/rbac members table uses DataTable (was raw <table>)',
        ratchet: 'src/app/t/[tenantSlug]/(app)/admin/rbac/MembersTable.tsx',
    },
    {
        // OBSESSION: access-reviews detail-page roster migrated to DataTable
        name: 'access-reviews detail-page roster uses DataTable (was raw <table>)',
        ratchet: 'src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx',
    },
    {
        // OBSESSION: first column = canonical identifier (entity-specific, not literally 'code')
        name: 'every entity list page opens with its canonical scannable identifier',
        ratchet: 'tests/guards/table-unification.test.ts',
    },

    // ─── Gear button universalisation ──────────────────────────────
    {
        // OBSESSION: useColumnsDropdown is the single contract for the gear
        name: 'gear mounting boilerplate replaced by a single hook',
        ratchet: 'src/components/ui/table/use-columns-dropdown.tsx',
    },
    {
        // OBSESSION: every entity list page mounts the gear or is in EXEMPTIONS
        name: 'gear coverage — every entity list page has column visibility practice',
        ratchet: 'tests/guards/columns-dropdown-coverage.test.ts',
    },
    {
        // OBSESSION: gear mounted on 5 previously-bare pages (Tasks, Assets, Vendors, Frameworks, Findings)
        name: 'gear added to 5 pages that lacked it (Tasks/Assets/Vendors/Frameworks/Findings)',
        ratchet: 'tests/guards/columns-dropdown-coverage.test.ts',
    },

    // ─── Detail-page nav discipline ────────────────────────────────
    {
        // OBSESSION: detail-page top-left is breadcrumbs only — no parallel back button
        name: 'detail-page nav = breadcrumbs only (back={…} prop banned in call sites)',
        ratchet: 'tests/guards/detail-page-back-prop-ban.test.ts',
    },

    // ─── StatusBadge tone discipline ───────────────────────────────
    {
        // OBSESSION: status is not brand — StatusBadge can never use brand orange
        name: 'StatusBadge variant union excludes brand; no call site asks for it',
        ratchet: 'tests/guards/status-badge-no-brand.test.ts',
    },
];

describe('Roadmap-10 round completion (PR-12)', () => {
    test('every R10 ratchet file exists', () => {
        const missing: string[] = [];
        for (const rel of ROADMAP_10_RATCHETS) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `R10 ratchet file(s) missing on disk — was one deleted?\n  ` +
                    missing.join('\n  '),
            );
        }
    });

    test('every R10 primitive file exists', () => {
        const missing: string[] = [];
        for (const rel of ROADMAP_10_PRIMITIVES) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) missing.push(rel);
        }
        if (missing.length > 0) {
            throw new Error(
                `R10 primitive file(s) missing — was one deleted or renamed?\n  ` +
                    missing.join('\n  '),
            );
        }
    });

    test('every obsession-checklist item points at a real file', () => {
        const missing: string[] = [];
        for (const item of OBSESSION_CHECKLIST) {
            const abs = path.join(ROOT, item.ratchet);
            if (!fs.existsSync(abs)) {
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

    test('obsession-checklist has at least 8 audited items', () => {
        expect(OBSESSION_CHECKLIST.length).toBeGreaterThanOrEqual(8);
    });
});
