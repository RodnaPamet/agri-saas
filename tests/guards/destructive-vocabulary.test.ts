/**
 * Roadmap-4 PR-9 — destructive-action vocabulary.
 *
 * Destructive flows in the product (delete a tenant, revoke an API
 * key, remove MFA, archive evidence) currently use a thoughtful
 * mix of verbs:
 *
 *   • Revoke API key   — invalidate a credential
 *   • Revoke SCIM token— invalidate a credential
 *   • Delete SSO conf  — permanent erasure of a configuration
 *   • Remove MFA       — deactivate (user can re-enroll later)
 *
 * The verbs map cleanly to intent — exactly the pattern Roadmap-2
 * PR-5 established for *constructive* actions (Create / Add /
 * Link). This ratchet locks the same discipline for destructive
 * actions so future PRs can't drift toward "Drop", "Clear",
 * "Cancel", or other verbs that read as ambiguous.
 *
 * Canonical destructive verbs
 *
 *   - **Delete**     — permanent erasure of a top-level entity or
 *                      configuration. The data is gone.
 *   - **Remove**     — detach an item from a parent, OR turn off
 *                      an enrollment. Source row may live on.
 *   - **Revoke**     — invalidate an authority / credential
 *                      (token, key, session, role grant).
 *   - **Discard**    — abandon unsaved or draft state.
 *   - **Archive**    — soft delete with history preserved.
 *   - **Unlink**     — break an association (cross-entity
 *                      traceability link, custom-role binding).
 *   - **Detach**     — like Unlink, used where "link" is also a
 *                      verb in the same surface (file detach,
 *                      vendor document detach).
 *   - **Reject**     — refuse a request (approval, finding).
 *
 * What this ratchet locks
 *
 *   Every `<ConfirmDialog tone="danger">` callsite MUST have a
 *   `confirmLabel="<verb> …"` that begins with one of the
 *   canonical verbs above. The detector pairs the `tone="danger"`
 *   line with the nearest `confirmLabel=` on the same prop block
 *   so we don't false-positive on unrelated label strings
 *   elsewhere in the file.
 *
 * What this ratchet does NOT police
 *
 *   - Destructive `<Button>` labels outside a ConfirmDialog
 *     (inline Reject / Archive on rows). Those are already
 *     governed by the existing action-label vocabulary ratchet
 *     and the Epic 67 undo-toast convention; layering a third
 *     scan would duplicate without clarifying.
 *
 *   - Email / notification copy. Those use the verbs
 *     organically; out of scope.
 *
 *   - Title sentences (e.g. "Revoke API key?"). The verb is
 *     already in the confirmLabel — duplicating the assertion
 *     would catch nothing the confirmLabel check misses.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const CANONICAL_VERBS = [
    'Delete',
    'Remove',
    'Revoke',
    'Discard',
    'Archive',
    'Unlink',
    'Detach',
    'Reject',
];

// Match `confirmLabel="<verb> …"` (or `'<verb> …'`). Case-
// sensitive on the verb because the canonical form is title-
// case ("Delete" not "delete").
const VERB_OK = new RegExp(
    `^(${CANONICAL_VERBS.join('|')})\\b`,
);

interface Offence {
    file: string;
    line: number;
    label: string;
}

// Files whose ConfirmDialog confirmLabel is a DYNAMIC expression
// (`confirmLabel={verb}`) rather than a literal, BUT where the value is
// type-constrained to the canonical verbs at the source — so the static
// literal scan can't read it yet it cannot ship an ambiguous verb.
// Each entry needs a written reason.
const DYNAMIC_LABEL_EXEMPT: Record<string, string> = {
    // Grain bin detail — confirmLabel is an i18n key; the resolved values are
    // "Delete bin" (en) / "Изтриване на силоз" (bg), both canonical.
    'src/app/t/[tenantSlug]/(app)/grain/bins/[binId]/BinDetailClient.tsx':
        "confirmLabel={t('detail.deleteConfirm')} → \"Delete bin\"",
    // Shared bulk-delete action-row hook: `verb` prop is typed
    // `'Delete' | 'Remove' | 'Revoke' | 'Archive' | 'Discard'` (all
    // canonical), defaulting to "Delete". Every table reuses this, so the
    // verb safety is enforced by the union type, not a literal.
    'src/components/ui/table/use-bulk-delete.tsx': 'verb prop typed to canonical verbs',
    // T05 i18n migration — confirmLabel is now an i18n key
    // (`confirmLabel={t('...')}`), not a literal the static scan can read.
    // The resolved en+bg values both begin with a canonical verb:
    //   api-keys → t('revokeKey')          = "Revoke key"
    //   scim     → t('confirmRevokeLabel') = "Revoke token"
    //   sso      → t('confirmDeleteLabel') = "Delete configuration"
    'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx': 'confirmLabel i18n key t(revokeKey) → "Revoke key"',
    'src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx': 'confirmLabel i18n key t(confirmRevokeLabel) → "Revoke token"',
    // #12 support console — confirmLabel={t('deleteConfirm')}; resolved
    // en = "Delete promotion", bg = "Изтриване на промоция" (both the
    // canonical erasure verb for their locale).
    'src/app/t/[tenantSlug]/(app)/admin/promotions/PromotionsAdminClient.tsx':
        'confirmLabel i18n key t(deleteConfirm) → "Delete promotion"',
    'src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx': 'confirmLabel i18n key t(confirmDeleteLabel) → "Delete configuration"',
    // T13 i18n migration — confirmLabel is now `t('removeMfa')`, resolved
    // en+bg both begin with the canonical "Remove" verb → "Remove MFA".
    'src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx': 'confirmLabel i18n key t(removeMfa) → "Remove MFA"',
    // Manage-parcels → Delete: per-parcel delete confirm uses an i18n key
    // (`confirmLabel={t('deleteParcelConfirmLabel')}`); resolved en+bg both
    // begin with the canonical "Delete" verb → "Delete parcel".
    'src/app/t/[tenantSlug]/(app)/locations/[locationId]/page.tsx': 'confirmLabel i18n key t(deleteParcelConfirmLabel) → "Delete parcel"',
    // Crop-plan delete — confirmLabel is `t('confirmDeleteLabel')`; resolved
    // en+bg both begin with the canonical "Delete" verb → "Delete plan".
    'src/app/t/[tenantSlug]/(app)/planning/[cropPlanId]/page.tsx': 'confirmLabel i18n key t(confirmDeleteLabel) → "Delete plan"',
};

describe('Destructive-action vocabulary (Roadmap-4 PR-9)', () => {
    it('every ConfirmDialog tone="danger" carries a canonical confirmLabel verb', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                if (DYNAMIC_LABEL_EXEMPT[rel.split(path.sep).join('/')]) continue;
                const lines = fs.readFileSync(full, 'utf-8').split('\n');
                lines.forEach((line, i) => {
                    // Hunt the danger-tone marker. When we find
                    // one, scan a 12-line window after it for the
                    // sibling confirmLabel — typical ConfirmDialog
                    // prop blocks fit in a handful of lines.
                    if (!/tone\s*=\s*["']danger["']/.test(line)) return;
                    let labelLine: string | null = null;
                    let labelLineIdx = -1;
                    for (
                        let j = i;
                        j < Math.min(lines.length, i + 12);
                        j++
                    ) {
                        const m = lines[j].match(
                            /confirmLabel\s*=\s*["']([^"']+)["']/,
                        );
                        if (m) {
                            labelLine = m[1];
                            labelLineIdx = j;
                            break;
                        }
                    }
                    if (labelLine === null) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            label: '<missing confirmLabel>',
                        });
                        return;
                    }
                    if (!VERB_OK.test(labelLine)) {
                        offenders.push({
                            file: rel,
                            line: labelLineIdx + 1,
                            label: labelLine,
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line} — confirmLabel="${o.label}"`)
                .join('\n');
            throw new Error(
                `These ConfirmDialog destructive flows use a non-canonical verb. Use one of: ${CANONICAL_VERBS.join(', ')}.\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
