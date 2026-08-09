/**
 * Structural ratchet — Practices list UX polish.
 *
 * Locks the visible-change deltas applied after Epic 91's
 * structural-only refactor:
 *
 *   1. Owner column renders an avatar + name + email chip (data
 *      already comes back from the repo's `owner` include).
 *   2. Status pill is a read-only `<StatusBadge id="status-pill-{id}">`.
 *      The inline-edit `<select>` dropdown was retired 2026-05-19 at
 *      the user's request; status changes route through the detail
 *      page or the bulk-set toolbar actions.
 *   3. Applicability pill is a read-only `<StatusBadge
 *      id="applicability-pill-{id}">`. Same retirement as Status;
 *      the justification modal lives on the detail page now.
 *   4. Evidence column carries a `<Paperclip>` icon next to the count.
 *   5. The bulk-status operations (Mark Implemented / Needs Review /
 *      Not Applicable) render in the selection-summary rail
 *      (`<SelectionSummaryPanel>`) — right-rail Phase 2 retired the
 *      floating `batchActions` toolbar in favour of the docked rail.
 *
 * This is a string-scan ratchet — same shape as
 * `practices-client-shell-adoption.test.ts`. It runs in the node
 * project so it doesn't need a jsdom mount.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONTROLS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx',
);
const source = readFileSync(CONTROLS_CLIENT, 'utf8');

describe('Practices list — UX polish', () => {
    describe('Owner column', () => {
        it('renders a name-only chip with initial avatar (no email)', () => {
            // Avatar circle uses the first character of the display
            // string; locking this so a future "tidy-up" can't drop
            // the avatar back to a plain text cell.
            expect(source).toContain("data-testid={`practice-owner-${c.id}`}");
            expect(source).toMatch(/charAt\(0\)\.toUpperCase\(\)/);
            // UI-14: name-only via ownerDisplayName (name → email local-part as
            // username); the full email address is no longer rendered.
            expect(source).toMatch(/ownerDisplayName\(c\.owner\?\.name,\s*c\.owner\?\.email\)/);
            expect(source).not.toMatch(/\{c\.owner\.email\}/);
            expect(source).toContain('text-content-subtle');
        });
    });

    describe('Status read-only badge (dropdown retired 2026-05-19)', () => {
        it('renders as a <StatusBadge id="status-pill-{id}">', () => {
            // The inline-edit `<select>` was retired 2026-05-19 at
            // the user's request. The cell is now a read-only badge
            // for every viewer; status changes route through the
            // per-practice detail page or the bulk-set toolbar
            // actions. E2E selector `#status-pill-{id}` preserved
            // on the badge for parity with existing tests.
            expect(source).toMatch(
                /<StatusBadge\s+id=\{`status-pill-\$\{c\.id\}`\}/,
            );
            // The cell must NOT carry an inline-edit `<select>` or
            // any of the legacy `setJustification` / handler hooks.
            expect(source).not.toMatch(
                /<select\s+id=\{`status-pill-\$\{c\.id\}`\}/,
            );
            // ALL_STATUSES + the dropdown <option> map are gone too.
            expect(source).not.toContain('ALL_STATUSES');
        });

        it('no permission branch — read-only for every viewer', () => {
            // Pre-2026-05-19 the cell had two branches (editable
            // `<select>` for editors, read-only badge for readers).
            // The new shape is single-branch; the permission gate
            // is gone for this cell. A future PR that re-adds an
            // `if (!appPermissions.practices.edit)` inside the
            // Status accessor would regress the simplification.
            const statusCell = source.match(
                /accessorKey: 'status',[\s\S]+?\}\,\s+\{/,
            );
            expect(statusCell).not.toBeNull();
            expect(statusCell![0]).not.toMatch(
                /appPermissions\.practices\.edit/,
            );
        });
    });

    describe('Applicability read-only badge (dropdown retired 2026-05-19)', () => {
        it('renders as a <StatusBadge id="applicability-pill-{id}">', () => {
            expect(source).toMatch(
                /<StatusBadge\s+id=\{`applicability-pill-\$\{c\.id\}`\}/,
            );
            expect(source).not.toMatch(
                /<select\s+id=\{`applicability-pill-\$\{c\.id\}`\}/,
            );
        });

        it('justification modal infrastructure removed from the list page', () => {
            // The Not-Applicable justification flow now lives on the
            // per-practice detail page only. The list page no longer
            // mounts the modal, the applicability mutation, or any
            // of the supporting state.
            expect(source).not.toContain('setJustificationModal');
            expect(source).not.toContain('applicabilityMutation');
            expect(source).not.toMatch(/<Modal\b/);
        });
    });

    describe('Evidence count column', () => {
        it('renders a Paperclip icon next to the count', () => {
            expect(source).toMatch(
                /import\s*\{[^}]*\bPaperclip\b[^}]*\}\s*from\s*['"]lucide-react['"]/,
            );
            expect(source).toMatch(/<Paperclip\s/);
            expect(source).toContain("data-testid={`practice-evidence-${row.original.id}`}");
        });
    });

    describe('Bulk actions — header-row selection bar (B1)', () => {
        it('wires the three bulk-status verbs into the DataTable batchActions', () => {
            // B1 (2026-06-07): the bulk-status verbs render in the
            // DataTable's header-row selection toolbar via `batchActions`
            // (the row-select bar that pops over the column-names row),
            // NOT the retired SelectionSummaryPanel right-rail.
            expect(source).toMatch(/batchActions:\s*practiceBatchActions/);
            // i18n batch T07 — the bulk-status verb labels route through
            // next-intl; assert the keys are wired AND the en.json values
            // preserve the copy.
            expect(source).toContain("label: t('list.markImplemented')");
            expect(source).toContain("label: t('list.markNeedsReview')");
            expect(source).toContain("label: t('list.markNotApplicable')");
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const en = require('../../messages/en.json').practices.list;
            expect(en.markImplemented).toBe('Mark Implemented');
            expect(en.markNeedsReview).toBe('Mark Needs Review');
            expect(en.markNotApplicable).toBe('Mark Not Applicable');
            expect(source).not.toContain('<SelectionSummaryPanel');
        });

        it('the destructive Mark-Not-Applicable verb carries tone=danger', () => {
            // Locks the destructive treatment through to the batch-action
            // button's tone contract.
            expect(source).toMatch(
                /label: t\('list\.markNotApplicable'\)[\s\S]{0,400}tone: 'danger'/,
            );
        });

        it('the bulk actions are permission-gated (edit for status, admin for delete)', () => {
            // READER sees neither checkboxes nor the action bar. The status
            // verbs require edit; the bulk delete requires admin; the bar
            // collapses to `undefined` (no selection) when the viewer can do
            // neither — so a READER still gets no batch actions.
            expect(source).toMatch(
                /canEditPractices[\s\S]{0,200}label: t\('list\.markImplemented'\)/,
            );
            expect(source).toMatch(
                /permissions\.canAdmin\s*\?\s*\[practiceBulkDelete\]/,
            );
            expect(source).toMatch(
                /practiceBatchActionsArr\.length\s*>\s*0\s*\?\s*practiceBatchActionsArr\s*:\s*undefined/,
            );
        });
    });
});
