/**
 * Field-campaign progress from МЗХ's «Оперативен анализ» (#3173): read from
 * the real bulletins' `pdftotext -layout` text, one per season, and refused —
 * never guessed — when a row's figures do not agree with themselves.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertCanonicalSlug } from '@/lib/agro/reference-slugs';
import { PROGRESS_COMMODITY_BY_LABEL, parseCampaignProgress, readings } from '@/lib/market/mzh-progress';

const fixture = (name: string) => readFileSync(join(__dirname, '../../fixtures/mzh', `progress-${name}.txt`), 'utf8');

describe('the autumn bulletin (Бюлетин № 31/2026, към 05.11)', () => {
    const p = parseCampaignProgress(fixture('2026-11-11'));

    it('reads the harvest as a share of the area to harvest', () => {
        expect(p.harvest).toHaveLength(1);
        expect(p.harvest[0]).toMatchObject({ asOf: '2026-11-05', lastYear: 2025 });
        expect(p.harvest[0].rows).toEqual([
            expect.objectContaining({ label: 'слънчоглед', commodity: 'sunflower', areaHa: 948911, harvestedHa: 943729, harvestedPct: 99 }),
            // The label wraps around its figures: «царевица за» / figures / «зърно».
            expect.objectContaining({ label: 'царевица за зърно', commodity: 'maize', areaHa: 320521, harvestedHa: 296143, harvestedPct: 92 }),
        ]);
    });

    it('splits «1 484 916 2 436 796» by the table\'s own arithmetic', () => {
        // Two columns one space apart, and a space as the thousands separator:
        // only the reading the yields and changes agree with survives.
        expect(p.harvest[0].rows[0]).toMatchObject({ productionT: 2436796, yieldKgPerDa: 258 });
        expect(readings('1 484 916 2 436 796', 2).length).toBeGreaterThan(0);
    });

    it('reads the sowing as hectares and the printed change, with no share', () => {
        expect(p.sowing).toHaveLength(1);
        expect(p.sowing[0].rows[0]).toEqual({
            label: 'пшеница', commodity: 'wheat', sownHa: 767199, lastYearHa: 658208, changePct: '16.6',
        });
        expect(p.sowing[0].rows.map((r) => r.commodity)).toEqual(['wheat', 'barley', 'rapeseed', 'rye', 'triticale']);
        expect(p.sowing[0].rows.find((r) => r.label === 'ръж')?.changePct).toBe('-28.4');
    });

    it('refuses nothing and leaves nothing unmapped (control)', () => {
        expect(p.refused).toEqual([]);
        expect(p.unmappedLabels).toEqual([]);
    });
});

describe('the summer bulletin (към 09.07): the winter-crop harvest', () => {
    const p = parseCampaignProgress(fixture('2026-07-15'));

    it('reads every row, joining labels wrapped over two lines', () => {
        const rows = p.harvest[0].rows;
        expect(rows.map((r) => r.label)).toEqual([
            'пшеница', 'ечемик (вкл. пролетен)', 'маслодайна рапица', 'ръж', 'тритикале',
        ]);
        expect(rows[0]).toMatchObject({ commodity: 'wheat', harvestedHa: 308732, areaHa: 1145055, harvestedPct: 27 });
        expect(p.refused).toEqual([]);
    });
});

describe('the spring bulletin (към 07.05): spring sowing', () => {
    const p = parseCampaignProgress(fixture('2026-05-13'));

    it('reads the sowing table and skips tobacco by decision, not as a failure', () => {
        expect(p.sowing).toHaveLength(1);
        expect(p.sowing[0].rows.map((r) => r.label)).toEqual(['слънчоглед', 'царевица за зърно', 'пролетен ечемик']);
        expect(p.refused).toEqual([]);
    });

    it('does not read the chart caption that repeats the table\'s title as a table', () => {
        // «Засети площи с маслодаен слънчоглед … към 07.05.2026 г.» captions
        // the chart below the table; it has no row of dates, so it is no table.
        expect(p.sowing.map((t) => t.title)).toEqual(['Засети площи с основни пролетници']);
        expect(p.harvest).toEqual([]);
    });
});

describe('what is refused', () => {
    const text = fixture('2026-11-11');

    it('a harvested area above the area to harvest', () => {
        const p = parseCampaignProgress(text.replace('945 428   943 729', '945 428   953 729'));
        expect(p.harvest[0]?.rows.map((r) => r.label) ?? []).not.toContain('слънчоглед');
        expect(p.refused).toEqual([expect.objectContaining({ label: 'слънчоглед', reason: 'no-reading' })]);
    });

    it('a printed change the figures do not make', () => {
        const p = parseCampaignProgress(text.replace('658 208                       767 199                 16,6%', '658 208                       767 199                 26,6%'));
        expect(p.sowing[0].rows.map((r) => r.label)).not.toContain('пшеница');
        expect(p.refused).toEqual([expect.objectContaining({ label: 'пшеница' })]);
    });

    it('a renamed crop is still read, and reported as unmapped', () => {
        const p = parseCampaignProgress(text.replace('тритикале ', 'лимец     '));
        expect(p.sowing[0].rows.find((r) => r.label === 'лимец')).toMatchObject({ commodity: null, sownHa: 7222 });
        expect(p.unmappedLabels).toEqual(['лимец']);
    });
});

describe('the commodity mapping', () => {
    it('uses canonical slugs only', () => {
        for (const [label, slug] of Object.entries(PROGRESS_COMMODITY_BY_LABEL)) {
            expect(() => assertCanonicalSlug('mzh-progress', label, slug)).not.toThrow();
        }
    });
});
