/**
 * UX foundation ratchets — Epic 64 (form system + EmptyState + ConfirmDialog
 * + Breadcrumbs).
 *
 * Each ratchet locks in a quantitative invariant the bundle established
 * so a future PR can't silently regress it without a code-review
 * conversation.
 *
 * Concretely:
 *   1. The shared <FormField> + react-hook-form + zodResolver pattern
 *      is wired in NewPracticeModal — the canonical reference form. A
 *      future "simplify" PR can't quietly drop RHF without bumping the
 *      reference count here in the same diff.
 *   2. window.confirm() across the tenant `/t/[tenantSlug]/(app)`
 *      surface has a hard ceiling. Each migration to <ConfirmDialog>
 *      drops the count; the ratchet resists the count creeping back up.
 *   3. <Breadcrumbs> is integrated into a known set of representative
 *      pages (list / detail / admin). Removing one of those without
 *      bumping the floor count fails CI.
 *   4. <EmptyState> adoption beyond the 3 pre-existing tenant pages
 *      is locked in (so the ad-hoc empty-state pattern doesn't return).
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../..');
const TENANT_APP = path.join(REPO, 'src/app/t/[tenantSlug]/(app)');

function read(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else if (
            entry.name.endsWith('.tsx') ||
            entry.name.endsWith('.ts')
        ) {
            results.push(full);
        }
    }
    return results;
}

// ─── 1. RHF + FormField reference form ────────────────────────────────

describe('Epic 64 — react-hook-form reference form', () => {
    // The reference form was `practices/NewPracticeModal.tsx` until GRC
    // teardown phase 2 deleted it. `ContractFormModal` inherits the role:
    // it is the richest surviving zodResolver + Controller form, and the
    // shape the next form should be modelled on.
    const REFERENCE_FORM = path.join(
        TENANT_APP,
        'grain/contracts/ContractFormModal.tsx',
    );

    it('uses zodResolver + useForm + Controller in ContractFormModal', () => {
        const src = read(REFERENCE_FORM);
        expect(src).toMatch(/from\s+['"]react-hook-form['"]/);
        expect(src).toMatch(/from\s+['"]@hookform\/resolvers\/zod['"]/);
        expect(src).toMatch(/\buseForm\s*</);
        expect(src).toMatch(/\bzodResolver\s*\(/);
        expect(src).toMatch(/\bController\b/);
    });

    it('keeps its stable field / action ids', () => {
        // Unlike the practices modal this replaces, no E2E spec targets
        // these ids YET — the assertion pins them so a rename has to be
        // deliberate, and so the ids are there when a spec wants them.
        const src = read(REFERENCE_FORM);
        const ids = [
            'contract-key-input',
            'contract-counterparty-input',
            'contract-commodity-input',
            'contract-season-input',
            'contract-price-input',
            'contract-currency-input',
            'contract-status-input',
            'save-contract-btn',
            'contract-cancel-btn',
            'contract-form-error',
        ];
        for (const id of ids) {
            expect(src).toMatch(new RegExp(`id=['"]${id}['"]`));
        }
    });
});

// ─── 2. window.confirm() ceiling ───────────────────────────────────

describe('Epic 64 — window.confirm() ceiling', () => {
    // Snapshot from this PR — 11 native-confirm sites left after the
    // first migration wave (api-keys, scim, sso, security/mfa). The
    // ceiling stops a future PR from silently re-introducing one
    // without migrating to <ConfirmDialog> in the same diff.
    //
    // Modal-form P3 (2026-05-24) bumped the ceiling 11 → 15 to absorb
    // four new unsaved-changes guards (`NewPolicyModal`, `NewTaskModal`,
    // `NewVendorModal`, `EditAssetModal`). Native `confirm()` is the
    // right primitive here because the close handler must
    // SYNCHRONOUSLY decide whether to surrender the modal — the
    // async `<ConfirmDialog>` shape would require deferring the
    // close until the user's choice resolves, a different practice-
    // flow contract. Migrating to ConfirmDialog is a separate epic.
    //
    // Modal-form follow-up (2026-05-24) bumped 15 → 17 — `NewAssetModal`
    // and `NewAuditModal` closed the create-flow gaps the original P2
    // missed (assets-create + audits-create were inline `showForm`
    // patterns; the original P2 scoped only assets-EDIT). Same
    // sync-close rationale as the four sites above.
    //
    // Tasks-tab Phase 2 (2026-06-03) bumped 17 → 18 for the row-level
    // task edit surface (opened from the Tasks list + every
    // practice/asset/risk Tasks tab). That surface is now
    // `<TaskDetailSheet>` (a right-side Sheet that replaced the earlier
    // EditTaskModal); it carries the SAME unsaved-changes discard guard
    // as `NewTaskModal` — a synchronous `window.confirm` on close so a
    // mis-click can't silently drop typed edits. The modal→sheet swap
    // leaves the count unchanged (one confirm out, one in).
    //
    // Field Journal (2026-06-14) bumped 18 → 19 for the
    // `JournalEntryModal` create/edit surface. It carries the SAME
    // unsaved-changes discard guard as `NewAssetModal` / `NewTaskModal`
    // — a synchronous `window.confirm` on close so a mis-click can't
    // silently drop a typed entry (title, TipTap notes, quantity rows).
    // Same sync-close rationale as the sites above.
    //
    // Knowledge Base (2026-06-14) bumped 19 → 20 for the
    // `NewArticleModal` create surface. It carries the SAME
    // unsaved-changes discard guard as `NewPolicyModal` (its twin) —
    // a synchronous `window.confirm` on close so a mis-click can't
    // silently drop a typed draft (title, category, summary, TipTap
    // content). Same sync-close rationale as the sites above.
    //
    // Certification Schemes (2026-06-15) bumped 20 → 21 for the
    // `NewSchemeModal` create surface. It carries the SAME
    // unsaved-changes discard guard as `NewPolicyModal` / `NewArticleModal`
    // — a synchronous `window.confirm` on close so a mis-click can't
    // silently drop a typed scheme (name, key, requirement rows). Same
    // sync-close rationale as the sites above.
    //
    // GRC teardown phase 2 lowered 21 → 13. The confirm sites on the
    // deleted GRC create/edit modals (NewPolicyModal, NewVendorModal,
    // NewAuditModal, TaskDetailSheet, NewSchemeModal's GRC siblings)
    // went with their pages. This is a deletion, not a migration — but
    // leaving the ceiling at 21 would bank 8 slots of unearned headroom,
    // which is exactly what a one-way-down ratchet exists to prevent.
    //
    // To LOWER this number further: migrate one or more remaining sites
    // and bump the constant down. Don't lower without a real migration.
    const CONFIRM_CALL_CEILING = 13;

    it(`has at most ${CONFIRM_CALL_CEILING} native-confirm call sites under the tenant app`, () => {
        const offenders: string[] = [];
        for (const file of walk(TENANT_APP)) {
            const src = read(file);
            // Strip comments first so doc-comment mentions don't count.
            const stripped = src
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');
            // Match BOTH bare `confirm(` (the global) and `window.confirm(`
            // — the second is what people write when their linter complains
            // about implicit globals.
            const bare =
                stripped.match(/(?<![\w.])confirm\s*\(/g) ?? [];
            const windowed =
                stripped.match(/\bwindow\.confirm\s*\(/g) ?? [];
            const total = bare.length + windowed.length;
            if (total > 0) {
                offenders.push(`${path.relative(REPO, file)}:${total}`);
            }
        }
        const total = offenders.reduce(
            (n, line) => n + Number(line.split(':').pop()),
            0,
        );
        if (total > CONFIRM_CALL_CEILING) {
            throw new Error(
                `Found ${total} native-confirm call sites — over the ceiling of ${CONFIRM_CALL_CEILING}. Migrate to <ConfirmDialog>:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nIf the rise is intentional and the ceiling needs to lift, document why in the PR description.',
            );
        }
    });
});

// ─── 3. Breadcrumbs adoption floor ───────────────────────────────

describe('Epic 64 — breadcrumbs adoption floor', () => {
    // Snapshot at landing — 3 pages integrate Breadcrumbs:
    //   - practices list (PracticesClient via EntityListPage.header.breadcrumbs)
    //   - practices detail (via EntityDetailLayout.breadcrumbs)
    //   - admin/api-keys (freestanding <Breadcrumbs>)
    const BREADCRUMB_FLOOR = 3;

    it('at least the floor of pages use Breadcrumbs', () => {
        const breadcrumbRe = /['"]@\/components\/ui\/breadcrumbs['"]/;
        const headerBreadcrumbsRe = /breadcrumbs:\s*\[/;
        const breadcrumbsPropRe = /\bbreadcrumbs=\{/;
        let count = 0;
        for (const file of walk(TENANT_APP)) {
            const src = read(file);
            // Either uses the primitive directly OR passes breadcrumbs
            // through a layout shell prop.
            if (
                breadcrumbRe.test(src) ||
                headerBreadcrumbsRe.test(src) ||
                breadcrumbsPropRe.test(src)
            ) {
                count++;
            }
        }
        expect(count).toBeGreaterThanOrEqual(BREADCRUMB_FLOOR);
    });

    it('layout shells expose a breadcrumbs prop', () => {
        const list = read(
            path.join(REPO, 'src/components/layout/EntityListPage.tsx'),
        );
        expect(list).toMatch(/breadcrumbs\?\:\s*ReadonlyArray<BreadcrumbItem>/);
        const detail = read(
            path.join(REPO, 'src/components/layout/EntityDetailLayout.tsx'),
        );
        expect(detail).toMatch(/breadcrumbs\?\:\s*ReadonlyArray<BreadcrumbItem>/);
    });
});

// ─── 4. EmptyState adoption floor ───────────────────────────────

describe('Epic 64 — EmptyState adoption floor', () => {
    // Snapshot at landing — at least these tenant pages import
    // <EmptyState>. Lock the count to resist future regression where
    // someone re-introduces an ad-hoc empty paragraph in a glass-card.
    const EMPTYSTATE_TENANT_FLOOR = 6;

    it('at least the floor of tenant pages import EmptyState', () => {
        const importRe = /['"]@\/components\/ui\/empty-state['"]/;
        let count = 0;
        for (const file of walk(TENANT_APP)) {
            const src = read(file);
            if (importRe.test(src)) count++;
        }
        expect(count).toBeGreaterThanOrEqual(EMPTYSTATE_TENANT_FLOOR);
    });

    it('the top-level EmptyState exposes the v2 surface (variants + actions)', () => {
        const src = read(
            path.join(REPO, 'src/components/ui/empty-state.tsx'),
        );
        expect(src).toMatch(/EmptyStateVariant\s*=/);
        expect(src).toMatch(/primaryAction\?:\s*EmptyStateAction/);
        expect(src).toMatch(/secondaryAction\?:\s*EmptyStateAction/);
        expect(src).toMatch(/no-records|no-results|missing-prereqs/);
    });

    it('table-empty-state composes the top-level EmptyState (no parallel implementation)', () => {
        const src = read(
            path.join(REPO, 'src/components/ui/table/table-empty-state.tsx'),
        );
        expect(src).toMatch(/from\s+['"]\.\.\/empty-state['"]/);
        expect(src).toMatch(/<EmptyState\b/);
    });
});

// ─── 5. ConfirmDialog top-level alias ────────────────────────────

describe('Epic 64 — ConfirmDialog top-level alias', () => {
    it('exports a discoverable ConfirmDialog from src/components/ui', () => {
        const src = read(
            path.join(REPO, 'src/components/ui/confirm-dialog.tsx'),
        );
        expect(src).toMatch(/export\s+const\s+ConfirmDialog\s*=\s*Modal\.Confirm/);
        expect(src).toMatch(/export\s+type\s*\{\s*ConfirmModalProps\s+as\s+ConfirmDialogProps/);
    });
});
