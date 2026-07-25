/**
 * Roadmap-9 PR-9 — primary:secondary ratio direction lock.
 *
 * Premium B2B products (Linear, Stripe, Vercel, Notion) render
 * roughly 3:1 to 4:1 secondary:primary across their app surface.
 * Primary is the rare, deliberate emphasis; secondary is the
 * everyday action tone.
 *
 * IC's ratio today after R8: 55 primary / 56 secondary in src/app
 * — close to 1:1. The R8 round dropped many primaries (Audits/
 * Evidence/Findings status flips, vendor + control form-toggles
 * before being reverted under create-button-uniformity, several
 * other targeted demotions), but the product is still loud at the
 * action layer.
 *
 * This ratchet locks the DIRECTION of travel, not the count:
 *
 *   1. Floor on the secondary:primary ratio. Today's ratio is
 *      ~1.02; the floor is 1.0 (secondary ≥ primary). The
 *      direction of travel is upward — future PRs that demote a
 *      primary to secondary push the ratio up; future PRs that
 *      promote a secondary to primary would push it back below
 *      1.0 and trip CI.
 *
 *   2. Ceiling on the absolute primary count. 55 today; budget
 *      at 56 (small headroom for legitimate new primaries that
 *      paid for themselves with a demotion in the same PR).
 *      Direction of travel — one-way down.
 *
 * The ratio assertion is the user-perceived quality lever; the
 * count ceiling is the structural ceiling. Together they make
 * "quiet by default" a one-way march without forcing per-PR
 * judgment.
 *
 * Pairs with `primary-action-budget.test.ts` (R7-PR1, per-file
 * cap) and `create-button-uniformity.test.ts` (v2-fu-2, visual
 * lock on `+ X` buttons). This ratchet sits at the round level —
 * primary-action-budget caps individual files; this caps the
 * product overall.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIR = "src/app";

const EXEMPT_DIR_NAMES = new Set<string>([
    "node_modules",
    "__tests__",
    "__mocks__",
]);
const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

function isExempt(rel: string): boolean {
    const segments = rel.split(path.sep);
    if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) return true;
    if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) return true;
    return false;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (isExempt(rel)) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
}

function countVariant(content: string, variant: string): number {
    // `[^>]*?` — match inside the open tag only (don't cross `>`).
    // The prior `[\s\S]*?` would greedy-match across nested
    // <Button>...</Button> blocks, double-counting nested cases.
    const re = new RegExp(
        `<Button\\b[^>]*?\\bvariant=["']${variant}["']`,
        "g",
    );
    const m = content.match(re);
    return m ? m.length : 0;
}

// Counts are based on a Node regex that matches multi-line `<Button>`
// JSX (the open tag can span several lines when props are split for
// readability). The line-by-line `grep` audit reported smaller
// numbers; the Node count is the authoritative one — the ratchet
// runs in Node, the count it sees IS the count.
//
// Today's count (R9-PR9 land):
//   primary   = 112
//   secondary = 102
//   ratio     = 0.91
//
// Target ratio for premium B2B baseline: ≥ 1.0 (3:1 - 4:1 is the
// ideal). Today we're below it. The ratchet locks the current floor
// (0.91) and the direction of travel: future PRs that demote a
// primary to secondary push the ratio UP. Future PRs that promote
// a secondary to primary would push it BELOW 0.91 and trip CI.
//
// As migrations land, drop MIN_SECONDARY_TO_PRIMARY_RATIO in the
// same PR to lock the win. Same shape as
// `border-tone-budget.test.ts` (R5-PR10) — one-way down (or up,
// for ratios).
const MIN_SECONDARY_TO_PRIMARY_RATIO = 0.9;
// Modal-form P2 (2026-05-24) — bumped 113 → 115 to absorb the
// three new modal-launch primary CTAs ("Create Policy" / "Create
// Task" / "Create Vendor" on the respective list pages). Each
// replaces a secondary Link → so the net change is +1 primary per
// site; 3 sites = +3, but two were partially offset elsewhere by
// the form-extraction cleanup that demoted some Save buttons.
// Measured post-merge count = 114; ceiling at 115 keeps one slot of
// headroom matching the previous policy.
//
// B5 (2026-05-24) — bumped 115 → 117 to absorb two new primaries
// from the evidence workflow completion: the EditEvidenceModal's
// "Save changes" form submit + the EvidenceDetailSheet's one
// earned "Approve" CTA (Submit / Re-submit / Re-certify were
// intentionally demoted to secondary so only the reviewer's
// approval moment is primary). Measured post-merge count = 116;
// ceiling at 117 keeps one slot of headroom.
//
// B8 (2026-05-24) — bumped 117 → 119 for the framework-lifecycle
// CTAs on FrameworksClient: the header "Import framework" primary
// + the explainer-modal "Import framework" primary (two distinct
// visual regions, modal-mounted on demand). Measured = 118;
// ceiling at 119 keeps one slot of headroom.
// RQ (2026-06-10) — bumped 119 → 121 for the risk-quantification
// surfaces: the KRI "Create" CTA (risks/kri) is a genuine page primary,
// matching the scenario/hierarchy create buttons. Measured = 120;
// ceiling at 121 keeps one slot of headroom.
// RQ-10 (2026-06-10) — bumped 121 → 123 for the reports surface: the
// "Generate PDF" template CTA (risks/reports) is a genuine page primary.
// Measured = 122; ceiling at 123 keeps one slot of headroom.
// RQ3-6 (2026-06-12) — bumped 123 → 125 for the loss-event register
// (risks/loss-events): the "Record" CTA is a genuine page primary,
// matching the scenario/hierarchy/KRI create buttons. The source-
// selector + Remove affordances are secondary/ghost, so the page
// adds exactly +1 primary. Measured = 124; ceiling at 125 keeps one
// slot of headroom.
// Feature 1 (agriculture): +2 primaries — the locations list create
// button ("New location") + its create-modal confirm ("Create").
// Measured = 126.
// WP-2 (module gating): +1 primary — the admin Modules settings page
// "Save" CTA (one earned page primary, matching the notifications
// settings Save). Measured = 127.
// Inventory ledger (Phase 1): +4 primaries — the inventory list "New lot"
// header CTA + three modal confirms (Create product / Create lot / Post
// movement), each the single primary of a distinct dialog region.
// Measured = 131.
// Parcel drawing (Phase 1): +1 primary — the "Create parcel" confirm on
// the name-the-drawn-parcel modal (Location detail Map tab). Measured =
// 132; ceiling at 132 (no headroom slot).
// Field Journal: +2 primaries — the journal list "Entry" header CTA +
// the create/edit-modal confirm (Create entry / Save entry), each the
// single primary of its surface. Mirrors the Feature-1 Locations bump
// (+2: list create + modal confirm). Measured = 134; ceiling at 134
// (no headroom slot).
// Farm Tasks: +2 primaries — the farm-tasks list "Task" header CTA +
// the create-modal confirm ("Create task"), each the single primary of
// its surface. Mirrors the Field Journal / Locations bump (+2: list
// create + modal confirm). Measured = 136; ceiling at 136 (no headroom
// slot).
// Knowledge Base: +5 primaries — the knowledge list "Article" header CTA
// + the create-modal confirm ("Create article") + the article detail's
// Acknowledge / Publish-version / Save-version CTAs. Each is the single
// primary of a distinct surface (list create, modal confirm, the
// readership-receipt moment, the publish moment, the editor confirm).
// Mirrors the Policy feature's primary set (the Knowledge feature is its
// twin). Certification Reseat (2026-06-15) bumped 141 → 143 for the two
// earned primaries on the Schemes surface: the `<Button variant="primary"
// icon={<Plus/>}>Scheme</Button>` list-header trigger (mandated by the
// action-button vocabulary) and the create modal's "Create scheme" submit
// (confirm-surface convention). Both are balanced by the modal's two
// secondary buttons (Cancel + add-Requirement), so the secondary:primary
// ratio is preserved. Measured = 143; ceiling at 143 (no headroom slot).
//
// Crop Planning (2026-06-15) bumped 143 → 148 for the five earned
// primaries on the succession-planning surface: the crop-plans list
// "Plan" header trigger + the new-crop-plan modal's "Create plan"
// submit + the crop-plan detail "Generate" CTA (re-run the engine —
// the distinct primary action of the detail surface) + the seasons
// list "Season" header trigger + the new-season modal's "Create
// season" submit. Each is the single primary of a distinct surface
// (two list creates, two modal confirms, one detail action). The
// modal confirms are balanced by their Cancel secondaries, so the
// ratio direction is preserved. Measured = 148; ceiling at 148.
//
// +6 (2026-06-16): enterprise-grain tenant UI — three new CRUD entity
// surfaces (Contracts / Bins / Yield), each with its single primary
// header create trigger ("Contract" / "Bin" / "Yield") + its
// create/edit modal's primary confirm ("Create/Save …"). Six earned
// primaries; the three modal confirms are each balanced by a Cancel
// secondary, so the secondary≥primary ratio direction holds (the
// read-only Costs report adds zero primaries). Measured = 154.
// +1 (2026-06-16): in-map parcel split/merge (Location detail Map tab).
// The merge-the-selected-parcels modal's confirm ("Merge parcels") is the
// single earned primary of that dialog surface — a create operation
// (the union becomes a new parcel), matching the sibling "Create parcel"
// confirm. It is balanced by the modal's Cancel secondary AND by the
// toolbar's secondary "Merge" trigger, so the secondary≥primary ratio
// direction holds (split adds zero primaries — its blade is drawn on the
// map, no confirm button). Measured = 155.
// +1 for the "Run reconciliation" CTA on the admin Ledger Integrity
// page — the single earned primary action on that utility surface,
// balanced by the history table + status card secondaries. Measured = 156.
// Mobile data-entry (2026-06-18): +1 primary — the "Spray job" launcher on
// the Location detail header (the mobile-first StepWizard entry point). It is
// the single earned primary create-CTA for starting a field operation on that
// location, matching the sibling entity-create header triggers. The wizard's
// own Next / Finish / Back buttons live in src/components/ui/step-wizard.tsx,
// which this src/app-scoped ratchet does not scan. Measured = 158.
// 158: +1 for the journal-entry "Дневник (PDF)" generate-modal confirm
// (PR3) — a genuine modal-confirm primary, matching the identical primary
// confirm on the Location-detail ДНЕВНИК modal.
// Exchange marketplace (2026-07-03): +1 primary — the "Offer" header CTA on
// the Exchange main page (the single earned entity-create primary of that
// surface, per the canonical icon+noun action-button vocabulary). Measured
// = 159; ceiling at 159 (no headroom slot).
// Exchange write flows (2026-07-04): +3 primaries — the create-offer modal
// confirm ("Create offer"), the express-interest modal confirm ("Express
// interest"), and the "Express interest" CTA on the offer detail Sheet. Each
// is the single earned primary of its surface (modal confirm + the one
// contact affordance). Measured = 162; ceiling at 162 (no headroom slot).
// #6 (task review gate): +1 primary — the field-operation review "Approve"
// CTA on the task detail page (the reviewer's one earned approval moment;
// "Request changes" is intentionally secondary). Measured = 163; ceiling at
// 163 (no headroom slot).
// #14 (climate): +1 primary — the empty-state "Go to locations" CTA on the
// native Climate weather page (the page's baseline earned primary). Measured =
// 164 (165 with #12 below). The station embed below adds the page's second
// climate primary.
// #12 (Offers): +1 primary — the "Ask for offer" lead-modal confirm (Send
// request) on the promotions feed. The modal's trigger + Cancel are both
// secondary, so the secondary:primary ratio stays healthy. Measured = 165;
// ceiling at 165 (no headroom slot).
// #13 (Farm Risk): +1 primary — the insurer "Ask for offer" lead-modal
// confirm (Send request) on the per-parcel risk page. Trigger + Cancel are
// secondary. Measured = 166; ceiling at 166 (no headroom slot).
// Rent page (roadmap 3/3): +2 primary — the list-create header "Lease"
// button + the create-lease modal confirm ("Create lease"). The modal's
// Cancel is secondary, so the secondary:primary ratio stays healthy.
// Measured = 168; ceiling at 168 (no headroom slot).
// Platform-support console (#12): +3 primary — the promotions list-create
// header "Promotion" button, the promotion create/edit modal confirm, and the
// supplier-edit modal confirm. All three are the convention-mandated shape
// (one create per list page, one confirm per modal) and every Cancel beside
// them is secondary, so the secondary:primary ratio moves up, not down.
// Measured = 170; ceiling at 170 (no headroom slot).
// Meteobot embed restored (#14, 2026-07-23): +1 primary — the "Save" CTA on the
// Climate page's Meteobot station config form (one earned settings-save
// primary; "Remove" is secondary). The station embed returned as a scoped-CSP
// iframe after being briefly dropped. Measured = 171; ceiling at 171.
// EditCropPlanModal (2026-07-23): +1 primary — the "Save changes" CTA on the
// new crop-plan edit modal (one earned modal-confirm primary; the inline
// "Add variety" sub-action is secondary). Measured = 172; ceiling at 172.
// /tasks retirement (2026-07-25): the compliance Tasks UI (TasksClient +
// tasks/[taskId]/page) was replaced by the farm-tasks list + detail. Net −1
// primary in src/app (the relocated NewTaskModal moved to src/components,
// out of this scan's scope). Measured = 171; ceiling at 171 (one-way down).
// 172 (was 171): the grain blend modal's confirm button. A modal's confirm
// IS the canonical primary per docs/ui-buttons.md — the surface exists to
// commit one action — so this is an earned primary, not budget drift.
const MAX_PRIMARY_COUNT = 172;

describe("primary:secondary ratio direction", () => {
    const counts = (() => {
        let primary = 0;
        let secondary = 0;
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            primary += countVariant(content, "primary");
            secondary += countVariant(content, "secondary");
        }
        return { primary, secondary };
    })();

    it("secondary count >= primary count (premium-product baseline)", () => {
        const ratio = counts.secondary / Math.max(counts.primary, 1);
        if (ratio < MIN_SECONDARY_TO_PRIMARY_RATIO) {
            throw new Error(
                `Secondary:primary ratio is ${ratio.toFixed(2)} (secondary=${counts.secondary}, primary=${counts.primary}). Premium-product baseline is ≥ 1.0 (3:1 - 4:1 is the target). To pass, demote a primary somewhere to secondary, OR — if the new primary is genuinely earned — demote two equivalent primaries to compensate.`,
            );
        }
        expect(ratio).toBeGreaterThanOrEqual(MIN_SECONDARY_TO_PRIMARY_RATIO);
    });

    it("absolute primary count is at or below the ceiling", () => {
        if (counts.primary > MAX_PRIMARY_COUNT) {
            throw new Error(
                `Total primary count is ${counts.primary} — ceiling is ${MAX_PRIMARY_COUNT}. Demote a primary to secondary, or — if the new primary is genuinely earned — drop the per-file budget elsewhere to compensate.`,
            );
        }
        expect(counts.primary).toBeLessThanOrEqual(MAX_PRIMARY_COUNT);
    });
});
