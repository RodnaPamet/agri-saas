/**
 * Audit Coherence S9 (2026-05-24) — structural ratchet locking the
 * cross-framework traceability gap closures.
 *
 *   Gap A — RequirementMapping carries `validFrom` / `validTo`
 *   columns; the repository read paths apply the
 *   `activeMappingWindow()` predicate so historical / superseded
 *   mappings never reach the resolver.
 *
 *   Gap B — `getTraceabilityGraph`'s DB-side pagination. The graph
 *   usecase went with the risk register; Gaps A and C below stand on
 *   modules that are still live.
 *
 *   Gap C — `enrichWithTenantImplementations` overlays the
 *   tenant's ControlRequirementLink rows onto the gap-analysis
 *   result so the frontend stops having to re-query the link table.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Audit S9 — Cross-Framework Traceability', () => {
    describe('Gap A — temporal validity window', () => {
        const schema = read('prisma/schema/compliance.prisma');
        const repo = read(
            'src/app-layer/repositories/RequirementMappingRepository.ts',
        );

        it('schema declares validFrom (default now) and nullable validTo', () => {
            // Pull the model block out.
            const block = schema.slice(
                schema.indexOf('model RequirementMapping'),
                schema.indexOf('model ControlRequirementLink'),
            );
            expect(block).toMatch(
                /validFrom\s+DateTime\s+@default\(now\(\)\)/,
            );
            expect(block).toMatch(/validTo\s+DateTime\?/);
            expect(block).toMatch(/@@index\(\[validTo\]\)/);
        });

        it('migration SQL backfills validFrom from createdAt', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524160000_audit_s9_mapping_validity',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = fs.readFileSync(
                path.join(migDir, 'migration.sql'),
                'utf8',
            );
            expect(sql).toMatch(
                /ADD COLUMN IF NOT EXISTS "validFrom"\s+TIMESTAMP/i,
            );
            expect(sql).toMatch(
                /ADD COLUMN IF NOT EXISTS "validTo"\s+TIMESTAMP/i,
            );
            expect(sql).toMatch(
                /SET "validFrom"\s*=\s*COALESCE\("validFrom",\s*"createdAt"\)/,
            );
            expect(sql).toMatch(
                /ALTER COLUMN "validFrom" SET NOT NULL/,
            );
        });

        it('repository exposes `activeMappingWindow` helper', () => {
            expect(repo).toMatch(
                /export function activeMappingWindow/,
            );
            expect(repo).toMatch(/validFrom:\s*\{\s*lte:\s*now\s*\}/);
            expect(repo).toMatch(
                /OR:\s*\[\s*\{\s*validTo:\s*null\s*\}\s*,\s*\{\s*validTo:\s*\{\s*gt:\s*now\s*\}/,
            );
        });

        it('all three findBy* read paths apply the active-window predicate', () => {
            // findBySourceRequirement / findByFrameworkPair /
            // findByTargetRequirement.
            const occurrences =
                repo.match(/\.\.\.activeMappingWindow\(\)/g) ?? [];
            expect(occurrences.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('Gap C — tenant control-implementation overlay', () => {
        const src = read(
            'src/app-layer/services/cross-framework-traceability.ts',
        );

        it('exports the overlay types + function', () => {
            expect(src).toMatch(
                /export interface TenantControlImplementation/,
            );
            expect(src).toMatch(
                /export interface GapAnalysisEntryWithImplementations/,
            );
            expect(src).toMatch(
                /export interface GapAnalysisResultWithImplementations/,
            );
            expect(src).toMatch(
                /export function enrichWithTenantImplementations/,
            );
        });

        it('overlay is a pure function — does not query Prisma inside its body', () => {
            // The caller owns the DB query; the service stays
            // dependency-free for unit testing.
            const fnStart = src.indexOf('export function enrichWithTenantImplementations');
            const fnBody = src.slice(fnStart, fnStart + 800);
            expect(fnBody).not.toMatch(/\bprisma\./);
            expect(fnBody).not.toMatch(/\bdb\.controlRequirementLink/);
            expect(fnBody).not.toMatch(/\.findMany\(/);
        });

        it('overlay builds a per-requirement lookup before mapping entries', () => {
            const block = src.slice(
                src.indexOf('export function enrichWithTenantImplementations'),
            );
            expect(block).toMatch(/new Map<string,\s*TenantControlImplementation/);
            expect(block).toMatch(/byReq\.get\(e\.targetRequirement\.requirementId\)/);
        });
    });
});
