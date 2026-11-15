/**
 * `evaluateFrostRisk` — the pure rule behind «няма сеитба при слана» (#3077).
 *
 * Its two siblings are tested through `agro-signals`, which is right for them:
 * they describe a day that has happened and the interesting behaviour is the
 * claim. This one decides a BOUNDARY that a product ruling turns on, and the
 * three-state answer (`atRisk` plus a reason code that separates "clear" from
 * "unknown") is what stops an absent signal beyond the forecast horizon
 * rendering as "checked, nothing found". Both deserve their own assertions
 * rather than being inferred from whether a row got claimed.
 */
import {
    DEFAULT_FROST_THRESHOLDS,
    evaluateFrostRisk,
    type FrostReasonCode,
} from '@/lib/agro/rules';

const code = (r: { reasonCodes: Array<{ code: FrostReasonCode }> }): FrostReasonCode =>
    r.reasonCodes[0].code;

describe('evaluateFrostRisk', () => {
    it('warns at and below the threshold, which is 2°C by owner ruling', () => {
        // The ruling is 2 °C rather than 0 °C, to catch ground frost: the 2 m
        // air minimum is what we store, and on a clear calm night the surface
        // is typically 2-4 °C colder. If this constant is ever "corrected" to
        // zero, that is a product reversal and not a tidy-up.
        expect(DEFAULT_FROST_THRESHOLDS.tempMinC).toBe(2);

        for (const t of [2, 1.9, 0, -0.1, -12]) {
            const r = evaluateFrostRisk({ date: '2026-04-12', tempMinC: t });
            expect(r.atRisk).toBe(true);
            expect(code(r)).toBe('frostExpected');
            expect(r.tempMinC).toBe(t);
        }
    });

    it('does not warn above it', () => {
        for (const t of [2.1, 3, 14]) {
            const r = evaluateFrostRisk({ date: '2026-04-12', tempMinC: t });
            expect(r.atRisk).toBe(false);
            expect(code(r)).toBe('noFrostExpected');
        }
    });

    it('separates UNKNOWN from clear when no minimum was recorded', () => {
        // The distinction the whole feature rests on. Both answers have
        // `atRisk: false` — we may not warn on a day we know nothing about —
        // so a caller reading only that boolean cannot tell a clear day from
        // an unforecast one, and would render "no frost" 20 days out where
        // there is simply no forecast.
        for (const missing of [null, undefined]) {
            const r = evaluateFrostRisk({ date: '2026-05-01', tempMinC: missing });
            expect(r.atRisk).toBe(false);
            expect(code(r)).toBe('noForecast');
            expect(r.tempMinC).toBeNull();
        }

        const clear = evaluateFrostRisk({ date: '2026-05-01', tempMinC: 9 });
        expect(clear.atRisk).toBe(false);
        // Same boolean, different code — which is the point.
        expect(code(clear)).not.toBe(code(evaluateFrostRisk({ date: '2026-05-01' })));
    });

    it('carries an English sentence AND a code+params, like its siblings', () => {
        // The #2490 split: English for the copilot prompt and `detailsJson`,
        // codes for anything a farmer reads. Disease had to be retrofitted
        // with the second form after a push reached a Bulgarian farmer in
        // English; this one ships with both.
        const r = evaluateFrostRisk({ date: '2026-04-12', tempMinC: -1.5 });
        expect(r.reasons).toHaveLength(1);
        expect(r.reasons[0]).toMatch(/-1\.5/);
        expect(r.reasonCodes[0].params).toEqual({ temp: -1.5, threshold: 2 });
    });

    it('honours an explicit threshold, so the default is not the only path', () => {
        const strict = { tempMinC: 0 };
        expect(evaluateFrostRisk({ date: '2026-04-12', tempMinC: 1.5 }, strict).atRisk).toBe(false);
        expect(evaluateFrostRisk({ date: '2026-04-12', tempMinC: -0.5 }, strict).atRisk).toBe(true);
        // And the default really is the default — passing nothing agrees with
        // passing the documented value.
        expect(evaluateFrostRisk({ date: '2026-04-12', tempMinC: 1.5 }).atRisk).toBe(
            evaluateFrostRisk({ date: '2026-04-12', tempMinC: 1.5 }, DEFAULT_FROST_THRESHOLDS).atRisk,
        );
    });
});
