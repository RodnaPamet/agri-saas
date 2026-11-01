/**
 * Unit tests — soil-aware crop suitability (#37).
 *
 * The engine is advisory-only and catalog-driven: it must return `unknown`
 * (never a fabricated verdict) when the variety has no curated preferences or
 * the parcel has no soil, and every non-good reason must carry the advisory
 * "verify with a soil test / agronomist" tail.
 */
import {
    computeSuitability,
    parseVarietySoilDefaults,
    type VarietySoilDefaults,
} from '@/lib/soil/suitability';
import type { SoilProfile } from '@/lib/soil/types';
import type { SoilReasonCode } from '@/lib/soil/suitability';
import type { UsdaTextureClass } from '@/lib/soil/texture';
import { renderSoilReason } from '@/lib/agro/reason-label';
import { LOCALES } from '@/lib/i18n/locales';

function soil(partial: Partial<SoilProfile>): Pick<SoilProfile, 'textureClass' | 'phH2o'> {
    return { textureClass: partial.textureClass ?? 'Loam', phH2o: partial.phH2o ?? 6.5 };
}

describe('parseVarietySoilDefaults', () => {
    it('returns null when nothing usable is present', () => {
        expect(parseVarietySoilDefaults(null)).toBeNull();
        expect(parseVarietySoilDefaults({})).toBeNull();
        expect(parseVarietySoilDefaults({ phMin: 'x', foo: 1 })).toBeNull();
    });

    it('parses a well-formed defaults object', () => {
        const d = parseVarietySoilDefaults({
            phMin: 6.0,
            phMax: 7.5,
            texturePreference: ['Loam', 'Silt loam'],
            drainagePreference: 'moderate',
        });
        expect(d).toEqual({
            phMin: 6.0,
            phMax: 7.5,
            texturePreference: ['Loam', 'Silt loam'],
            drainagePreference: 'moderate',
        });
    });
});

describe('computeSuitability — unknowns', () => {
    it('is unknown when the variety has no defaults', () => {
        expect(computeSuitability(soil({}), null).flag).toBe('unknown');
    });
    it('is unknown when the parcel has no soil', () => {
        const d: VarietySoilDefaults = { phMin: 6, phMax: 7 };
        expect(computeSuitability(null, d).flag).toBe('unknown');
    });
});

describe('computeSuitability — pH band', () => {
    const d: VarietySoilDefaults = { phMin: 6.0, phMax: 7.0 };

    it('is good inside the band', () => {
        expect(computeSuitability(soil({ phH2o: 6.5 }), d).flag).toBe('good');
    });
    it('is caution just outside the band (< 1.0)', () => {
        const r = computeSuitability(soil({ phH2o: 5.4 }), d);
        expect(r.flag).toBe('caution');
        expect(r.reason).toMatch(/soil test|agronomist/i);
    });
    it('is poor well outside the band (>= 1.0)', () => {
        const r = computeSuitability(soil({ phH2o: 4.5 }), d);
        expect(r.flag).toBe('poor');
        expect(r.reasons.length).toBeGreaterThan(0);
    });
    it('names the acidic vs alkaline direction', () => {
        expect(computeSuitability(soil({ phH2o: 8.5 }), d).reason).toMatch(/alkaline/i);
        expect(computeSuitability(soil({ phH2o: 4.5 }), d).reason).toMatch(/acidic/i);
    });
});

describe('computeSuitability — texture & drainage', () => {
    it('cautions when texture is outside the preferred set', () => {
        const d: VarietySoilDefaults = { texturePreference: ['Loam', 'Silt loam'] };
        expect(computeSuitability(soil({ textureClass: 'Sand' }), d).flag).toBe('caution');
    });
    it('is good when texture is within the preferred set', () => {
        const d: VarietySoilDefaults = { texturePreference: ['Loam', 'Silt loam'] };
        expect(computeSuitability(soil({ textureClass: 'Loam' }), d).flag).toBe('good');
    });
    it('escalates to poor on a two-step drainage gap (well vs poor)', () => {
        const d: VarietySoilDefaults = { drainagePreference: 'poor' };
        // Sand implies well-draining → two ranks from poor → poor.
        expect(computeSuitability(soil({ textureClass: 'Sand' }), d).flag).toBe('poor');
    });
    it('cautions on a one-step drainage gap (moderate vs poor)', () => {
        const d: VarietySoilDefaults = { drainagePreference: 'poor' };
        // Loam implies moderate → one rank from poor → caution.
        expect(computeSuitability(soil({ textureClass: 'Loam' }), d).flag).toBe('caution');
    });
    it('takes the worst of several checks', () => {
        const d: VarietySoilDefaults = {
            phMin: 6.0,
            phMax: 7.0,
            texturePreference: ['Loam'],
        };
        // pH way off (poor) + texture mismatch (caution) → poor.
        const r = computeSuitability(soil({ phH2o: 4.0, textureClass: 'Sand' }), d);
        expect(r.flag).toBe('poor');
        expect(r.reasons.length).toBe(2);
    });
});

/**
 * The structured parallel added by #2509.
 *
 * `reasons[]` stays English for the copilot prompt and the audit row — that is
 * #2490's split and it is correct. What was missing was anything a PERSON's
 * language could be applied to, on a field that is already on the wire from
 * `GET /planning/plantings/{id}/soil`.
 *
 * These use the REAL catalogue, not a mocked `translateFor`. A mock cannot
 * report that a key is absent, and `translateFor` returns the KEY on a miss —
 * so a typo would ship, render as
 * «locations.smart.soilReason.phTooAcidicHard», and pass a mocked test.
 */
describe('computeSuitability — structured reason codes (#2509)', () => {
    const d = { phMin: 6, phMax: 7, texturePreference: ['Loam'] as UsdaTextureClass[], drainagePreference: 'well' as const };

    it('emits one code per English sentence', () => {
        const r = computeSuitability(soil({ phH2o: 4.5, textureClass: 'Clay' }), d);
        // The counts must track, or a consumer rendering codes shows fewer
        // findings than the prose does.
        expect(r.reasonCodes).toHaveLength(r.reasons.length);
        expect(r.reasons.length).toBeGreaterThan(1);
    });

    it('puts the pH direction and severity in the CODE, not a param', () => {
        const hardLow = computeSuitability(soil({ phH2o: 4.5 }), d);
        const softLow = computeSuitability(soil({ phH2o: 5.4 }), d);
        const hardHigh = computeSuitability(soil({ phH2o: 8.5 }), d);
        const softHigh = computeSuitability(soil({ phH2o: 7.6 }), d);
        expect(hardLow.reasonCodes[0]?.code).toBe('phTooAcidicHard');
        expect(softLow.reasonCodes[0]?.code).toBe('phTooAcidicSoft');
        expect(hardHigh.reasonCodes[0]?.code).toBe('phTooAlkalineHard');
        expect(softHigh.reasonCodes[0]?.code).toBe('phTooAlkalineSoft');
        // No `direction` param — that was the half-measure this avoids.
        expect(Object.keys(hardLow.reasonCodes[0]?.params ?? {}).sort()).toEqual(['band', 'ph']);
    });

    it('codes the unknown and the all-good cases too', () => {
        expect(computeSuitability(null, d).reasonCodes[0]?.code).toBe('noPreferences');
        /**
         * `Sandy loam`, not `Loam`, and the difference is the point: `Loam`
         * implies MODERATE drainage, so against a `well` preference it is a
         * `drainageMismatch` and not an all-good field at all. My first
         * fixture here asserted `matchesPreferences` on a result that
         * correctly carried a mismatch — the test was wrong, not the code.
         */
        const allGood = {
            phMin: 6,
            phMax: 7,
            texturePreference: ['Sandy loam'] as UsdaTextureClass[],
            drainagePreference: 'well' as const,
        };
        const r = computeSuitability(soil({ phH2o: 6.5, textureClass: 'Sandy loam' }), allGood);
        expect(r.flag).toBe('good');
        expect(r.reasonCodes[0]?.code).toBe('matchesPreferences');
    });

    it('carries the raw drainage enum, for the renderer to resolve', () => {
        const r = computeSuitability(soil({ textureClass: 'Clay', phH2o: 6.5 }), d);
        const drain = r.reasonCodes.find((c) => c.code === 'drainageMismatch');
        expect(drain).toBeDefined();
        expect(['well', 'moderate', 'poor']).toContain(String(drain?.params.preferred));
    });
});

describe('renderSoilReason — against the REAL catalogue', () => {
    const d = { phMin: 6, phMax: 7, texturePreference: ['Loam'] as UsdaTextureClass[], drainagePreference: 'well' as const };

    it('renders every code in BOTH locales', async () => {
        // The population is the union itself, so a code added without copy
        // fails here rather than rendering its own key at a farmer.
        const codes: SoilReasonCode[] = [
            'noPreferences',
            'phTooAcidicHard',
            'phTooAcidicSoft',
            'phTooAlkalineHard',
            'phTooAlkalineSoft',
            'textureNotPreferred',
            'drainageMismatch',
            'matchesPreferences',
        ];
        for (const locale of LOCALES) {
            for (const code of codes) {
                const out = await renderSoilReason(locale, {
                    code,
                    params: { ph: 5, band: 'pH 6–7', texture: 'Clay', preferred: 'well', actual: 'poor' },
                });
                expect(out).not.toBeNull();
                // `translateFor` returns the key on a miss — the one failure
                // this test exists for.
                expect(out).not.toContain('soilReason');
            }
        }
        console.log(`[soil-reason-codes] ${codes.length} code(s) × ${LOCALES.length} locale(s) rendered`);
    });

    it('resolves the drainage words rather than interpolating the enum', async () => {
        const bg = await renderSoilReason('bg', {
            code: 'drainageMismatch',
            params: { actual: 'poor', preferred: 'well' },
        });
        expect(bg).not.toBeNull();
        // The raw enum must NOT survive into Bulgarian copy.
        expect(bg).not.toContain('poor');
        expect(bg).not.toContain('well');
        expect(bg).toContain('слабо');
        expect(bg).toContain('добро');
    });

    it('gives Bulgarian and English readers different sentences — the control', async () => {
        const r = { code: 'phTooAcidicHard' as const, params: { ph: 4.5, band: 'pH 6–7' } };
        const bg = await renderSoilReason('bg', r);
        const en = await renderSoilReason('en', r);
        // Without this, a catalogue where bg copied en would satisfy every
        // assertion above.
        expect(bg).not.toBe(en);
        expect(bg).toContain('кисела');
        expect(en).toContain('acidic');
    });

    it('returns null for a code with no catalogue entry', async () => {
        const out = await renderSoilReason('bg', {
            code: 'notARealCode' as SoilReasonCode,
            params: {},
        });
        // Null, never the key: «…— locations.smart.soilReason.notARealCode» is
        // worse than the sentence with no detail.
        expect(out).toBeNull();
    });

    it('renders a real computed result end to end', async () => {
        const r = computeSuitability(soil({ phH2o: 4.5, textureClass: 'Clay' }), d);
        const rendered = await Promise.all(r.reasonCodes.map((c) => renderSoilReason('bg', c)));
        expect(rendered.every((x) => x !== null)).toBe(true);
        expect(rendered.join(' ')).toContain('pH');
    });
});
