/**
 * Unit test — Bulgaria oblast catalogue + its alignment with the bundled
 * geojson polygons. Locks the 28-oblast count, the code lookup, and that
 * every region code matches a `shapeISO` in public/geo/bg-oblasti.geojson
 * (so a listing's regionCode always has a polygon).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    BULGARIA_REGIONS,
    BULGARIA_REGION_OPTIONS,
    BULGARIA_REGION_NAME_OPTIONS,
    canonicaliseRegionName,
    isBulgariaRegionName,
    regionByCode,
    isKnownRegionCode,
} from '@/lib/geo/bulgaria-regions';

describe('bulgaria-regions', () => {
    it('enumerates the 28 oblasti with unique codes', () => {
        expect(BULGARIA_REGIONS).toHaveLength(28);
        const codes = new Set(BULGARIA_REGIONS.map((r) => r.code));
        expect(codes.size).toBe(28);
    });

    it('regionByCode resolves a known code and rejects an unknown one', () => {
        expect(regionByCode('BG-16')?.nameEn).toBe('Plovdiv');
        expect(regionByCode('BG-16')?.nameBg).toBe('Пловдив');
        expect(regionByCode('BG-99')).toBeUndefined();
        expect(isKnownRegionCode('BG-16')).toBe(true);
        expect(isKnownRegionCode('BG-99')).toBe(false);
    });

    it('every region has valid Bulgaria-range coordinates', () => {
        for (const r of BULGARIA_REGIONS) {
            expect(r.lat).toBeGreaterThan(41);
            expect(r.lat).toBeLessThan(44.5);
            expect(r.lon).toBeGreaterThan(22);
            expect(r.lon).toBeLessThan(29);
        }
    });

    it('options are bilingual, one per region, sorted by Bulgarian name', () => {
        expect(BULGARIA_REGION_OPTIONS).toHaveLength(28);
        expect(BULGARIA_REGION_OPTIONS[0].label).toContain('/'); // "bg / en"
        const labels = BULGARIA_REGION_OPTIONS.map((o) => o.label);
        const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'bg'));
        expect(labels).toEqual(sorted);
    });

    it('every region code has a matching polygon in the bundled geojson', () => {
        const geojsonPath = path.resolve(__dirname, '../../public/geo/bg-oblasti.geojson');
        const geo = JSON.parse(fs.readFileSync(geojsonPath, 'utf8')) as {
            features: { properties: { shapeISO: string } }[];
        };
        const shapeCodes = new Set(geo.features.map((f) => f.properties.shapeISO));
        for (const r of BULGARIA_REGIONS) {
            expect(shapeCodes.has(r.code)).toBe(true);
        }
    });

    describe('the two option lists are valued differently on purpose (#2068)', () => {
        it('one is valued by ISO code, the other by Bulgarian name', () => {
            // The whole point. Their LABELS are identical, so a call site that
            // picks the wrong list looks right and stores a value no reader of
            // that column will match: a code into a name column makes the
            // browse filter offer «Добрич» and never find it.
            expect(BULGARIA_REGION_OPTIONS.every((o) => /^BG-\d{2}$/.test(o.value))).toBe(true);
            expect(BULGARIA_REGION_NAME_OPTIONS.every((o) => isBulgariaRegionName(o.value))).toBe(
                true,
            );
            expect(BULGARIA_REGION_NAME_OPTIONS).toHaveLength(28);
            // Same labels, same order — only `value` differs.
            expect(BULGARIA_REGION_NAME_OPTIONS.map((o) => o.label)).toEqual(
                BULGARIA_REGION_OPTIONS.map((o) => o.label),
            );
        });

        it('no name is also a code, so a mix-up cannot pass unnoticed', () => {
            const codes = new Set(BULGARIA_REGION_OPTIONS.map((o) => o.value));
            for (const o of BULGARIA_REGION_NAME_OPTIONS) {
                expect(codes.has(o.value)).toBe(false);
            }
        });
    });

    describe('canonicaliseRegionName (#2068)', () => {
        it('maps a case variant onto the canonical Bulgarian name', () => {
            // The measured divergence: #1909 made the browse filter
            // case-insensitive because the two clients produce these.
            expect(canonicaliseRegionName('добрич')).toBe('Добрич');
            expect(canonicaliseRegionName('ДОБРИЧ')).toBe('Добрич');
            expect(canonicaliseRegionName('стара загора')).toBe('Стара Загора');
        });

        it('maps the English name onto the Bulgarian one', () => {
            // The bilingual labels make submitting the Latin half a plausible
            // accident; canonicalising stops a second spelling family.
            expect(canonicaliseRegionName('Dobrich')).toBe('Добрич');
            expect(canonicaliseRegionName('veliko tarnovo')).toBe('Велико Търново');
        });

        it('leaves an already-canonical value untouched', () => {
            for (const r of BULGARIA_REGIONS) {
                expect(canonicaliseRegionName(r.nameBg)).toBe(r.nameBg);
            }
        });

        it('passes an UNRECOGNISED value through unchanged — it never rejects', () => {
            // Owner ruling: normalise, do not reject. A `z.enum` here would
            // make a shipped iOS build's write fail, which is #1087's cost.
            // Free text stays reachable from a non-UI client, knowingly.
            expect(canonicaliseRegionName('Добрич обл.')).toBe('Добрич обл.');
            expect(canonicaliseRegionName('Добричка област')).toBe('Добричка област');
            expect(canonicaliseRegionName('не е област')).toBe('не е област');
            expect(canonicaliseRegionName('')).toBe('');
        });

        it('keeps null as null', () => {
            // The column is nullable and an absent oblast must not become a
            // farm placed in one it never chose.
            expect(canonicaliseRegionName(null)).toBeNull();
        });

        it('CONTROL: it is not fuzzy — a near miss is NOT canonicalised', () => {
            // Without this, a matcher widened to `includes` would satisfy every
            // assertion above while silently equating different oblasti.
            expect(canonicaliseRegionName('Добри')).toBe('Добри');
            expect(canonicaliseRegionName('Стара')).toBe('Стара');
        });
    });
});
