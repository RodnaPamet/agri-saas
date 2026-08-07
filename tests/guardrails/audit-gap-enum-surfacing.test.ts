/**
 * Audit Coherence follow-up (2026-05-24) — surface the new enum
 * values added by S1 (RiskStatus.MITIGATED) and S2
 * (TestPlanStatus.ARCHIVED) in the UI. The schema changes shipped
 * with the audit roadmap, but the corresponding filter / detail
 * page / status-badge surfaces stayed pinned to the legacy value
 * sets — a write to the new state was technically possible via
 * API but invisible in every list / detail view.
 *
 * This ratchet locks the surfacing in every place a regression
 * would silently re-hide the value.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Audit-gap enum surfacing', () => {
    describe('RiskStatus.MITIGATED (Audit Coherence S1)', () => {
        const enums = read('prisma/schema/enums.prisma');
        const filterDefs = read(
            'src/app/t/[tenantSlug]/(app)/risks/filter-defs.ts',
        );
        const detail = read(
            'src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx',
        );
        const mapping = read(
            'src/app-layer/domain/entity-status-mapping.ts',
        );

        it('schema enum still carries the value (defence against rollback)', () => {
            // Pull the enum block out of the prisma file so unrelated
            // matches in other models can't false-positive.
            const block = enums.slice(
                enums.indexOf('enum RiskStatus'),
                enums.indexOf('enum RiskStatus') + 400,
            );
            expect(block).toMatch(/\bMITIGATED\b/);
        });

        it('filter-defs RISK_STATUS_LABELS exposes MITIGATED', () => {
            // Block-scope the lookup so a removal anywhere else in
            // the file doesn't accidentally satisfy the match. Use
            // the `export const` anchor so we land on the actual
            // table, not the doc-header mention.
            const start = filterDefs.indexOf('export const RISK_STATUS_LABELS');
            const block = filterDefs.slice(start, start + 800);
            expect(block).toMatch(/MITIGATED:\s*['"]Mitigated['"]/);
        });

        it('risk detail STATUS_VALUES includes MITIGATED', () => {
            const block = detail.slice(
                detail.indexOf('STATUS_VALUES'),
                detail.indexOf('STATUS_VALUES') + 400,
            );
            expect(block).toMatch(/['"]MITIGATED['"]/);
        });

        it('RISK_STATUS_VARIANT carries a badge tone for MITIGATED', () => {
            const block = mapping.slice(
                mapping.indexOf('RISK_STATUS_VARIANT'),
                mapping.indexOf('RISK_STATUS_VARIANT') + 400,
            );
            expect(block).toMatch(/MITIGATED:\s*['"][a-z]+['"]/);
        });
    });

});
