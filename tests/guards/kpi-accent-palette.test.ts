/**
 * KPI accent palette — shared-vocabulary ratchet.
 *
 * The KPI filter cards' colour scheme (gradient headline value + paired
 * sparkline) is defined ONCE in `src/components/ui/kpi-accent.ts` so every
 * list page — Asset today, Practice / Risk / Task / Vendor / Test / Policy
 * next — draws from the same palette. This locks the palette's shape so a
 * future page can't quietly fork it or add an off-scheme colour.
 */
import {
    KPI_ACCENTS,
    kpiAccentValueClass,
    type KpiAccent,
} from '@/components/ui/kpi-accent';

const EXPECTED_ACCENTS = [
    'emerald',
    'amber',
    'violet',
    'indigo',
    'sky',
    'rose',
    'slate',
] as const;

// Mirrors MiniAreaChartVariant — the valid sparkline colour variants.
const VALID_SPARKLINE = ['brand', 'success', 'warning', 'error', 'info', 'neutral'];

describe('KPI accent palette', () => {
    it('exposes exactly the expected accent names (no silent forks)', () => {
        expect(Object.keys(KPI_ACCENTS).sort()).toEqual([...EXPECTED_ACCENTS].sort());
    });

    it('every accent is a `from-X to-Y` gradient + a valid sparkline variant', () => {
        for (const def of Object.values(KPI_ACCENTS)) {
            expect(def.gradient).toMatch(/^from-\S+ to-\S+$/);
            expect(VALID_SPARKLINE).toContain(def.sparkline);
        }
    });

    it('kpiAccentValueClass yields a clipped gradient-text class for each accent', () => {
        for (const name of EXPECTED_ACCENTS) {
            const cls = kpiAccentValueClass(name as KpiAccent);
            expect(cls).toMatch(/\bbg-gradient-to-r\b/);
            expect(cls).toMatch(/\bbg-clip-text\b/);
            expect(cls).toMatch(/\btext-transparent\b/);
            expect(cls).toContain(KPI_ACCENTS[name as KpiAccent].gradient);
        }
    });
});
