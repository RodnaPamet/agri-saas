/**
 * Soil-aware crop SUITABILITY — PURE, advisory-only, no I/O.
 *
 * Given a parcel's modelled soil and a crop variety's curated agronomic
 * preferences, produce a coarse flag (`good` / `caution` / `poor` /
 * `unknown`) plus a plain-language reason. This is a SUGGESTION surface,
 * never automation, and every reason string ends by pointing the grower to
 * a real soil test / agronomist.
 *
 * Hard rule (mirrors the prompt): thresholds come ONLY from the variety's
 * curated `soilDefaultsJson` (catalog/import data). If a variety carries no
 * preferences, or the parcel has no soil yet, the result is `unknown` — we
 * NEVER invent a pH range or texture preference to force a verdict.
 *
 * @module lib/soil/suitability
 */
import type { SoilProfile } from './types';
import { drainageForTexture, type UsdaTextureClass, type DrainageTendency } from './texture';

export type SuitabilityFlag = 'good' | 'caution' | 'poor' | 'unknown';

/**
 * Curated soil preferences for a variety, parsed from `CropVariety.
 * soilDefaultsJson`. Every field optional — a sparsely-populated variety
 * simply produces a narrower judgement (or `unknown`).
 */
export interface VarietySoilDefaults {
    /** Preferred minimum soil pH (inclusive). */
    phMin?: number | null;
    /** Preferred maximum soil pH (inclusive). */
    phMax?: number | null;
    /** Preferred USDA texture classes; parcel outside this set → caution. */
    texturePreference?: UsdaTextureClass[] | null;
    /** Preferred drainage tendency; a mismatch → caution. */
    drainagePreference?: DrainageTendency | null;
}

/**
 * Structured reasons, beside the English prose (#2509).
 *
 * The shape mirrors `SprayReasonCode` / `DiseaseReason` in `@/lib/agro/rules`
 * exactly, so there is ONE pattern and not two — #2490 established the split
 * (English for the copilot prompt and the audit row, codes for anything a
 * person reads) and deliberately carved this file out of it.
 *
 * **The pH direction and severity are in the CODE, not in a param.** A
 * `{direction}` param would carry the literal word "acidic" into a Bulgarian
 * sentence — an untranslated English word inside translated copy, which is a
 * half-measure rather than a fix. Four codes cost nothing and translate
 * cleanly.
 */
export type SoilReasonCode =
    | 'noPreferences'
    | 'phTooAcidicHard'
    | 'phTooAcidicSoft'
    | 'phTooAlkalineHard'
    | 'phTooAlkalineSoft'
    | 'textureNotPreferred'
    | 'drainageMismatch'
    | 'matchesPreferences';

export interface SoilReason {
    code: SoilReasonCode;
    /**
     * Interpolation values. `string | number`, unlike spray's number-only
     * params: a pH BAND is rendered «pH 6–7» / «pH ≥ 6», which is symbolic and
     * reads the same in both languages, and a texture class is a USDA name.
     *
     * `drainage` values are the raw enum (`well` | `moderate` | `poor`) and
     * are resolved to words by `renderSoilReason` before interpolation — the
     * repo's rule that a translated string is resolved to a local const BEFORE
     * being interpolated into another.
     */
    params: Record<string, string | number>;
}

export interface SuitabilityResult {
    flag: SuitabilityFlag;
    /** Plain-language explanation, advisory in tone. */
    reason: string;
    /** Structured drivers for the agronomy copilot (the "why"). */
    reasons: string[];
    /** Structured codes+params — for i18n at the render layer (#2509). */
    reasonCodes: SoilReason[];
}

/** pH more than this far outside the preferred band is a hard mismatch. */
const PH_HARD_MARGIN = 1.0;

const ADVISORY = 'Verify with a soil test or your agronomist before planting.';

/**
 * Parse a raw `soilDefaultsJson` value into typed defaults, tolerating the
 * loose JSON shape. Returns null when nothing usable is present (→ the
 * caller yields `unknown`, not a fabricated verdict).
 */
export function parseVarietySoilDefaults(raw: unknown): VarietySoilDefaults | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
    const texture = Array.isArray(o.texturePreference)
        ? (o.texturePreference.filter((t) => typeof t === 'string') as UsdaTextureClass[])
        : null;
    const drainage =
        o.drainagePreference === 'well' || o.drainagePreference === 'moderate' || o.drainagePreference === 'poor'
            ? (o.drainagePreference as DrainageTendency)
            : null;
    const defaults: VarietySoilDefaults = {
        phMin: num(o.phMin),
        phMax: num(o.phMax),
        texturePreference: texture && texture.length > 0 ? texture : null,
        drainagePreference: drainage,
    };
    const hasAny =
        defaults.phMin != null ||
        defaults.phMax != null ||
        defaults.texturePreference != null ||
        defaults.drainagePreference != null;
    return hasAny ? defaults : null;
}

/**
 * Compute an advisory suitability flag for a soil profile × variety
 * defaults. `unknown` whenever we lack the data to judge honestly.
 */
export function computeSuitability(
    soil: Pick<SoilProfile, 'textureClass' | 'phH2o'> | null | undefined,
    defaults: VarietySoilDefaults | null | undefined,
): SuitabilityResult {
    if (!soil || !defaults) {
        return {
            flag: 'unknown',
            reason: 'No soil preferences on file for this crop, or soil is still pending for this field.',
            reasons: [],
            reasonCodes: [{ code: 'noPreferences', params: {} }],
        };
    }

    const reasons: string[] = [];
    const reasonCodes: SoilReason[] = [];
    let worst: Exclude<SuitabilityFlag, 'unknown'> = 'good';
    const escalate = (to: 'caution' | 'poor') => {
        if (to === 'poor') worst = 'poor';
        else if (worst === 'good') worst = 'caution';
    };

    // ── pH band ──
    const { phMin, phMax } = defaults;
    if (soil.phH2o != null && (phMin != null || phMax != null)) {
        const belowBy = phMin != null ? phMin - soil.phH2o : -Infinity;
        const aboveBy = phMax != null ? soil.phH2o - phMax : -Infinity;
        const deviation = Math.max(belowBy, aboveBy);
        if (deviation > 0) {
            const bandText =
                phMin != null && phMax != null
                    ? `pH ${phMin}–${phMax}`
                    : phMin != null
                        ? `pH ≥ ${phMin}`
                        : `pH ≤ ${phMax}`;
            const dir = belowBy > aboveBy ? 'acidic' : 'alkaline';
            if (deviation >= PH_HARD_MARGIN) {
                escalate('poor');
                reasons.push(`Soil pH ${soil.phH2o} is well outside the preferred ${bandText} (too ${dir}).`);
                reasonCodes.push({
                    code: dir === 'acidic' ? 'phTooAcidicHard' : 'phTooAlkalineHard',
                    params: { ph: soil.phH2o, band: bandText },
                });
            } else {
                escalate('caution');
                reasons.push(`Soil pH ${soil.phH2o} is slightly outside the preferred ${bandText} (a little too ${dir}).`);
                reasonCodes.push({
                    code: dir === 'acidic' ? 'phTooAcidicSoft' : 'phTooAlkalineSoft',
                    params: { ph: soil.phH2o, band: bandText },
                });
            }
        }
    }

    // ── texture preference ──
    if (defaults.texturePreference && soil.textureClass) {
        if (!defaults.texturePreference.includes(soil.textureClass)) {
            escalate('caution');
            reasons.push(
                `Soil texture (${soil.textureClass}) is not among this crop's preferred textures (${defaults.texturePreference.join(', ')}).`,
            );
            reasonCodes.push({
                code: 'textureNotPreferred',
                params: {
                    texture: soil.textureClass,
                    preferred: defaults.texturePreference.join(', '),
                },
            });
        }
    }

    // ── drainage tendency implied by texture ──
    if (defaults.drainagePreference && soil.textureClass) {
        const tendency = drainageForTexture(soil.textureClass);
        if (tendency && tendency !== defaults.drainagePreference) {
            // Well vs poor is a two-step gap → escalate harder than one step.
            const gap = Math.abs(rank(tendency) - rank(defaults.drainagePreference));
            escalate(gap >= 2 ? 'poor' : 'caution');
            reasons.push(
                `Texture implies ${tendency}-draining soil, but this crop prefers ${defaults.drainagePreference}-draining ground.`,
            );
            // The raw enum, resolved to words by `renderSoilReason`.
            reasonCodes.push({
                code: 'drainageMismatch',
                params: { actual: tendency, preferred: defaults.drainagePreference },
            });
        }
    }

    if (reasons.length === 0) {
        return {
            flag: 'good',
            reason: `This field's soil matches the crop's preferences. ${ADVISORY}`,
            reasons,
            reasonCodes: [{ code: 'matchesPreferences', params: {} }],
        };
    }

    return {
        flag: worst,
        reason: `${reasons.join(' ')} ${ADVISORY}`,
        reasons,
        reasonCodes,
    };
}

/** Ordinal rank for drainage tendency (well=0 … poor=2) for gap sizing. */
function rank(d: DrainageTendency): number {
    return d === 'well' ? 0 : d === 'moderate' ? 1 : 2;
}
