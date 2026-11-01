import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { CROP_PICKER_VALUES } from '@/lib/grain/crop-picker';
import {
    NAME_SHAPE,
    USAGE_EVENT_NAMES,
    USAGE_SURFACES,
} from '@/app-layer/telemetry/usage-events';

const ROOT = path.resolve(__dirname, '../..');
const MODULE = path.join(ROOT, 'src/app-layer/telemetry/usage-events.ts');

/**
 * Names carrying a DIGIT.
 *
 * Module-level and named so `selector-teeth` has a selector to mutate, and so
 * the controls below can prove it selects. A digit in an event name is the
 * cheapest tell that a value was appended — `screen_opened_2`, or an id.
 */
export function namesCarryingDigits(names: readonly string[]): string[] {
    return names.filter((n) => /\d/.test(n));
}

/**
 * Names containing a CROP, derived from the product's own picker rather than
 * restated here — so a crop added to `CROP_PICKER_VALUES` is covered the day it
 * lands rather than when somebody remembers this file.
 */
export function namesCarryingACrop(names: readonly string[]): string[] {
    const crops = CROP_PICKER_VALUES.map((c) => c.toLowerCase());
    return names.filter((n) => crops.some((c) => n.toLowerCase().includes(c)));
}

/**
 * Surfaces that are PARAMETERISED rather than static.
 *
 * This is the concrete, checkable form of "a surface must not encode a
 * parcel". `/locations` is a screen; `/locations/[id]` is a screen plus a
 * parcel id, and storing the second would put a farm's record identifiers in
 * an analytics table by way of a client that only meant to say which screen was
 * open. The word «parcel» itself is fine — `parcel_located` carries no parcel.
 */
export function parameterisedSurfaces(surfaces: readonly string[]): string[] {
    return surfaces.filter((s) => /[[\]:{}]|\d/.test(s));
}

describe('usage-event names carry no data (#493)', () => {
    it('the population is real — a shrunk enum must not pass by being empty', () => {
        // Floors, because every assertion below ranges over these arrays and an
        // empty array satisfies all of them.
        console.log(
            `[usage-event-vocabulary] names=${USAGE_EVENT_NAMES.length} surfaces=${USAGE_SURFACES.length} crops=${CROP_PICKER_VALUES.length}`,
        );
        expect(USAGE_EVENT_NAMES.length).toBeGreaterThanOrEqual(20);
        expect(USAGE_SURFACES.length).toBeGreaterThanOrEqual(10);
        // The derived crop list is the other population — if it emptied, the
        // crop assertion below would pass over nothing.
        expect(CROP_PICKER_VALUES.length).toBeGreaterThanOrEqual(5);
    });

    it('every name is lowercase snake_case and nothing else', () => {
        const bad = USAGE_EVENT_NAMES.filter((n) => !NAME_SHAPE.test(n));
        expect(bad).toEqual([]);
    });

    it('no name carries a digit', () => {
        expect(namesCarryingDigits(USAGE_EVENT_NAMES)).toEqual([]);
    });

    it('no name carries a crop', () => {
        // The failure this exists to stop: `track('treatment_saved_' + crop)`
        // is the obvious thing to write when you want a per-crop breakdown, and
        // it puts what a farm grows into an analytics row.
        expect(namesCarryingACrop(USAGE_EVENT_NAMES)).toEqual([]);
    });

    it('every surface is a STATIC screen, never a parameterised route', () => {
        expect(parameterisedSurfaces(USAGE_SURFACES)).toEqual([]);
    });

    it('the vocabulary is LITERAL — no name is assembled at runtime', () => {
        // Comments stripped first: this file's own prose names the failure
        // modes, and a scan that read them would report the explanation as the
        // defect. Same reason `social-routes-flag-gated` blanks before matching.
        const src = blankNonCode(fs.readFileSync(MODULE, 'utf8'), { strings: false });
        // A template literal or a concatenation inside the arrays would defeat
        // every assertion above, because the union would no longer be the set
        // of values that can reach the column.
        const arrays = src.slice(
            src.indexOf('USAGE_SURFACES'),
            src.indexOf('export function isUsageEventName'),
        );
        expect(arrays.length).toBeGreaterThan(200);
        expect(arrays).not.toMatch(/`/);
        expect(arrays).not.toMatch(/\+\s*[A-Za-z_$]/);
    });

    it('the selectors discriminate — they are not returning empty', () => {
        // Mutation proof. Every assertion above is `toEqual([])`, which an
        // always-empty selector satisfies perfectly, so each selector is shown
        // to SELECT on a value of the shape it hunts.
        expect(namesCarryingDigits(['screen_opened', 'cost_saved_2'])).toEqual(['cost_saved_2']);
        expect(namesCarryingDigits(['screen_opened'])).toEqual([]);

        expect(namesCarryingACrop(['treatment_saved_wheat', 'task_closed'])).toEqual([
            'treatment_saved_wheat',
        ]);
        expect(namesCarryingACrop(['task_closed'])).toEqual([]);

        expect(parameterisedSurfaces(['/locations/[id]', '/journal'])).toEqual([
            '/locations/[id]',
        ]);
        expect(parameterisedSurfaces(['/journal'])).toEqual([]);

        // ...and the shape regex refuses what it should.
        expect(NAME_SHAPE.test('screen_opened')).toBe(true);
        expect(NAME_SHAPE.test('Screen_Opened')).toBe(false);
        expect(NAME_SHAPE.test('screen opened')).toBe(false);
        expect(NAME_SHAPE.test('screen__opened')).toBe(false);
    });
});
