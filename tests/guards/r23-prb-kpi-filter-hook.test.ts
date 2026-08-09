/**
 * R23-PR-B — `useKpiFilter` hook structural ratchet.
 *
 * Locks the hook's API surface.
 * The behavioural contract (toggle semantics, activeKpiId resolution,
 * multi-match → null) is covered by the unit test at
 * `tests/unit/use-kpi-filter.test.ts`; this file is the structural
 * lock — a future PR that splits the hook, renames the exports, or
 * bypasses it fails CI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const HOOK_PATH = 'src/components/ui/kpi-filter/use-kpi-filter.ts';
const BARREL_PATH = 'src/components/ui/kpi-filter/index.ts';

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('R23-PR-B — useKpiFilter hook', () => {
    it('the hook + barrel exist at the canonical paths', () => {
        expect(fs.existsSync(path.join(ROOT, HOOK_PATH))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, BARREL_PATH))).toBe(true);
    });

    describe('API surface (hook file)', () => {
        const src = read(HOOK_PATH);

        it('exports the useKpiFilter hook', () => {
            expect(src).toMatch(/export function useKpiFilter\b/);
        });

        it('exports the KpiFilterDef interface', () => {
            expect(src).toMatch(/export interface KpiFilterDef\b/);
        });

        it('exports the UseKpiFilterReturn interface', () => {
            expect(src).toMatch(/export interface UseKpiFilterReturn\b/);
        });

        it('KpiFilterDef carries id + apply + isActive', () => {
            expect(src).toMatch(/id\s*:\s*TKpiId/);
            expect(src).toMatch(/apply\s*:\s*\(ctx\s*:\s*FilterContextValue\)\s*=>\s*void/);
            expect(src).toMatch(/isActive\s*:\s*\(state\s*:\s*FilterState\)\s*=>\s*boolean/);
        });

        it('hook return shape: activeKpiId / toggle / select / clear', () => {
            expect(src).toMatch(/activeKpiId\s*:\s*TKpiId\s*\|\s*null/);
            expect(src).toMatch(/toggle\s*:\s*\(id\s*:\s*TKpiId\)\s*=>\s*void/);
            expect(src).toMatch(/select\s*:\s*\(id\s*:\s*TKpiId\)\s*=>\s*void/);
            expect(src).toMatch(/clear\s*:\s*\(\)\s*=>\s*void/);
        });

        it('consumes the shared FilterContextValue via useFilters()', () => {
            expect(src).toMatch(/from\s+["']@\/components\/ui\/filter["']/);
            expect(src).toMatch(/useFilters\(\)/);
        });

        it('multi-match resolves to null (mutual-exclusion contract)', () => {
            // The hook returns null when two or more KPIs report
            // active simultaneously. Documented contract; the test
            // pins the regex shape so a future "pick the first" or
            // "pick the last" refactor fails CI.
            expect(src).toMatch(/matches\.length\s*!==\s*1/);
        });

        it('toggle: clicking the active KPI clears filters', () => {
            // Toggle semantics — second click on the active card
            // calls ctx.clearAll(). This is the Risks-page contract.
            expect(src).toMatch(/activeKpiId\s*===\s*id[\s\S]*?ctx\.clearAll\(\)/);
        });
    });

    describe('Barrel exports', () => {
        const src = read(BARREL_PATH);

        it('exports useKpiFilter, KpiFilterDef, UseKpiFilterReturn', () => {
            expect(src).toMatch(/useKpiFilter/);
            expect(src).toMatch(/KpiFilterDef/);
            expect(src).toMatch(/UseKpiFilterReturn/);
        });
    });
});
