/**
 * Audit Coherence S10 (2026-05-24) — structural ratchet locking
 * the entity-specific restore validator infrastructure.
 *
 * The audit recommended:
 *   - Gap 1 — entity-specific restore validation: SHIP. Locked here.
 *   - Gap 2 — field-level RBAC: DEFER (no concrete pull yet).
 *   - Gap 3 — ABAC: DEFER (matches audit guidance).
 *
 * The deferral rationale lives in
 * `docs/implementation-notes/2026-05-24-audit-s10-tenant-isolation.md`.
 * This ratchet asserts only the SHIP scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Audit S10 — Tenant Isolation & Authorization', () => {
    describe('Gap 1 — entity-specific restore validators', () => {
        const validators = read('src/app-layer/domain/restore-validators.ts');
        const usecase = read('src/app-layer/usecases/soft-delete-operations.ts');

        it('declares the RestorableModel union with every soft-deletable model', () => {
            // Same set as `SOFT_DELETE_MODELS` — keep both in sync.
            // Drift would mean the registry doesn't cover a model that
            // restoreEntity allows.
            //
            // The union was twelve members until GRC teardown phase 3;
            // eight of them (Risk, Practice, Policy, Vendor, Finding,
            // Audit, AuditCycle, AuditPack) went with their models.
            const expected = ['Asset', 'Evidence', 'FileRecord', 'Task'];
            for (const m of expected) {
                expect(validators).toMatch(
                    new RegExp(`\\|\\s*['"]${m}['"]`),
                );
            }
        });

        it('declares the RestoreValidator signature with ctx + db + record', () => {
            expect(validators).toMatch(
                /export type RestoreValidator =\s*\(\s*ctx:\s*RequestContext,\s*db:\s*PrismaTx,\s*record:\s*unknown,?\s*\)\s*=>\s*Promise<void>/,
            );
        });

        it('RESTORE_VALIDATORS is a total Record<RestorableModel, …>', () => {
            // Total — Record, not Partial. A new model must explicitly
            // declare its validator (NOOP_VALIDATOR is the documented
            // choice for "no preconditions").
            expect(validators).toMatch(
                /export const RESTORE_VALIDATORS:\s*Record<RestorableModel,\s*RestoreValidator>/,
            );
        });

        it('Evidence still has a concrete (non-noop) validator', () => {
            // Task and AuditPack used to be named here too. AuditPack's
            // model is gone; Task's model SURVIVES but its validator
            // does not — it checked that the parent Practice was alive,
            // and with `Task.practiceId` dropped there is no parent to
            // check, so Task is now wired to NOOP_VALIDATOR. Evidence is
            // the only model left with a real precondition, which makes
            // this the assertion that keeps the mechanism honest: demote
            // it to NOOP and every restore becomes unconditional.
            expect(validators).toMatch(/Evidence:\s*EVIDENCE_VALIDATOR/);
            expect(validators).not.toMatch(/Evidence:\s*NOOP_VALIDATOR/);
        });

        it('Evidence validator checks active tenant membership', () => {
            const fnStart = validators.indexOf('const EVIDENCE_VALIDATOR');
            const fnBody = validators.slice(fnStart, fnStart + 800);
            expect(fnBody).toMatch(/db\.tenantMembership\.findFirst/);
            expect(fnBody).toMatch(/status:\s*['"]ACTIVE['"]/);
        });

        it('restoreEntity calls getRestoreValidator BEFORE the update', () => {
            const fnStart = usecase.indexOf('export async function restoreEntity');
            const fnBody = usecase.slice(fnStart, fnStart + 2000);
            // Order matters — the gate is between the existence check
            // and the row write. A refactor that moves the validator
            // call below `delegate.update` lets a precondition-violating
            // restore land and emits a bogus audit row before throwing.
            const gateIdx = fnBody.indexOf('await validator(');
            const updateIdx = fnBody.indexOf('delegate.update(');
            expect(gateIdx).toBeGreaterThan(0);
            expect(updateIdx).toBeGreaterThan(gateIdx);
        });
    });

    describe('Gap 2 & Gap 3 — decision docs land alongside the SHIP scope', () => {
        const note = read(
            'docs/implementation-notes/2026-05-24-audit-s10-tenant-isolation.md',
        );

        it('field-level RBAC defer rationale is documented', () => {
            expect(note).toMatch(/field-level RBAC stays deferred/);
            // Anchor to the four reasons so the defer can't quietly
            // shrink to a one-line "no" later.
            expect(note).toMatch(/allowlist per field per role/);
            expect(note).toMatch(/Repository-layer projection/);
        });

        it('ABAC defer rationale is documented + matches audit guidance', () => {
            expect(note).toMatch(/ABAC deferred/);
            expect(note).toMatch(/policy engine \(OPA \/ Cedar\)/);
        });
    });
});
