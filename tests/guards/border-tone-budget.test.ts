/**
 * Roadmap-5 PR-10 — border-tone budget.
 *
 * The product had no clear default border tone:
 *   • `border-border-default` × 133
 *   • `border-border-subtle`  × 113
 *
 * 50/50 split with no documented rule. Most structural lines
 * read better at the quieter tone — `border-border-default` is
 * a stronger signal than the average border deserves.
 *
 * Policy (locked here, also documented in CLAUDE.md)
 *
 *   subtle    — DEFAULT border tone for structural separators
 *               (form-field outlines, table-cell separators,
 *               quiet panel boundaries, sidebar item dividers).
 *               If you have to ask "default or subtle?", the
 *               answer is subtle.
 *
 *   default   — Reserved for surfaces that need explicit
 *               containment: card outer border, table outer
 *               border, modal/sheet boundary, popover/tooltip
 *               outline. The "this is a discrete surface"
 *               statement.
 *
 *   emphasis  — Reserved for state: selected card, active panel,
 *               focused field, hovered click target, error /
 *               warning state's border.
 *
 * What this ratchet locks
 *
 *   The total `border-border-default` count under
 *   `src/app` + `src/components` may NOT exceed today's count.
 *   New uses force net-down migrations elsewhere — the budget
 *   only ratchets DOWN.
 *
 *   This is the "freeze the regression boundary" strategy.
 *   The full migration to subtle-by-default happens in
 *   incremental follow-up PRs that bring the count down rung
 *   by rung. Each follow-up PR drops the budget number here.
 *
 * What this ratchet does NOT police
 *
 *   - Per-site choice between subtle / default / emphasis.
 *     That's a judgement call by the contributor; the policy
 *     above guides it but isn't structurally enforced.
 *
 *   - The 113 existing `border-border-subtle` sites — those
 *     read correctly today and don't need touching.
 *
 *   - Other border tokens (`border-border-emphasis`,
 *     `border-border-error`, `border-border-warning`, …) —
 *     those carry semantic state and aren't subject to this
 *     budget.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Locked at the count when this ratchet landed
 * (Roadmap-5 PR-10, 2026-05-10). Future PRs that migrate
 * `border-border-default` → `border-border-subtle` MUST
 * decrement this number to lock in the win.
 *
 * Roadmap-7 PR-2 (2026-05-10) lowered the budget from 133 → 120 by
 * migrating form-field outlines (input / textarea), filter-primitive
 * resting borders, internal popover dividers, and kbd-shortcut hints
 * from `default` to `subtle` — the documented default tone for
 * structural separators.
 *
 * R13-PR6 (2026-05-11) lowered the budget from 120 → 119 by
 * dropping `cardVariants(...)` wrappers around three admin/reports
 * DataTables (integrations, notifications, reports skeleton). The
 * outer cards carried `border-border-default/50` strip-dividers
 * inside their card-header — those went away with the wrappers.
 *
 * R13-PR10 (2026-05-11) lowered the budget from 119 → 118 by
 * deleting `admin/AdminClient.tsx` (audit log moved to its own
 * page) — its policy-templates branch carried a
 * `border border-border-default` divider on the template tiles.
 *
 * R20-PR-B (2026-05-15) lowered the budget from 118 → 117 by
 * migrating the date-picker trigger's rest border from
 * `border-border-default` to the new R20 control-parity token
 * `--ctrl-edge-rest`. The trigger now shares its border vocabulary
 * with the migrated <Input> (and, transitively, the combobox
 * trigger which composes a <Button>), so three form controls read
 * with one focus + rest vocabulary.
 *
 * R10-PR3 follow-up (2026-05-24) lowered the budget from 117 → 115
 * by migrating four raw `<table>` sub-tables to `<DataTable>`. The
 * removed `<thead><tr className="border-b border-border-default">`
 * markup is replaced by DataTable's tokenised chrome which uses
 * `border-border-subtle` as the default separator tone.
 *
 * Future PRs continue to ratchet down toward the rough 4:1
 * subtle-to-default target ratio.
 */
// B3 (2026-06-07): −1 — the undo-toast's `border-border-default` was
// replaced by the `.surface-popup-texture` class (token-based border).
// B4 (2026-06-20): +1 — two delight features landed discrete-surface cards
// that legitimately use the `border-border-default` "discrete surface" tone:
// the shareables ShareableStatCard and the onboarding CoachMark popover.
// B5 (2026-07-07, restored 2026-07-23): +1 — the Climate page's Meteobot
// station embed wraps the dashboard iframe in a discrete external-content
// surface (same register as a card / table outer border), so it legitimately
// uses `border-border-default`. (Briefly reclaimed 2026-07-22 while the embed
// was dropped, then restored with the scoped-CSP embed.)
// mobile-native-feel (2026-07-12): +2 — two mobile floating affordances that
// are discrete surfaces floating over arbitrary list content (same register
// as a popover/tooltip outline, which the policy assigns to `default`): the
// pull-to-refresh spinner pill (use-pull-to-refresh.tsx) and the
// scroll-to-top button (scroll-to-top.tsx).
const BORDER_DEFAULT_BUDGET = 95;

function countMatches(re: RegExp): number {
    let total = 0;
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.next') continue;
                walk(full);
                continue;
            }
            if (!/\.tsx$/.test(e.name)) continue;
            const src = fs.readFileSync(full, 'utf-8');
            const stripped = src
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            const matches = stripped.match(re);
            if (matches) total += matches.length;
        }
    };
    walk(path.join(ROOT, 'src/app'));
    walk(path.join(ROOT, 'src/components'));
    return total;
}

describe('Border-tone budget (Roadmap-5 PR-10)', () => {
    it('border-border-default count does not exceed the documented budget', () => {
        const count = countMatches(/\bborder-border-default\b/g);
        expect(count).toBeLessThanOrEqual(BORDER_DEFAULT_BUDGET);
    });

    it('budget is realistic (not vacuous)', () => {
        // Sanity check: the budget shouldn't be astronomically
        // higher than the actual count. If a future PR migrates
        // 50 sites but forgets to drop the budget, this test
        // makes the win visible.
        const count = countMatches(/\bborder-border-default\b/g);
        // Allow 10-instance slack so a small follow-up cleanup
        // doesn't have to drop the budget on every PR.
        expect(BORDER_DEFAULT_BUDGET).toBeLessThanOrEqual(count + 10);
    });
});
