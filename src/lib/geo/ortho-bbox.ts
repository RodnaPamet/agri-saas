/**
 * Parse and BOUND the bbox the phone sends to the ortho endpoints (#2421).
 *
 * The client's own discipline is to ask for blocks only below 0.12°, or 0.3°
 * for the farm's own bounds. That is sensible and it is not a bound: a bound
 * that lives in the client is a request the server has agreed to honour, not a
 * limit. A single `bbox=19,41,29,45` would otherwise ask the Ministry for
 * every physical block in Bulgaria, and the feature cap downstream would make
 * the answer look reasonable.
 *
 * ## One code for every way it can be wrong
 *
 * Malformed, out of range, inverted and too large all answer
 * `ORTHO_BBOX_INVALID`. They are distinguished in the MESSAGE, not the code,
 * because every one of them is the same thing to the only caller that can hit
 * them — a client bug — and none is actionable by a farmer. Four codes would
 * each need a catalogue entry and a line in the spec to say the same thing.
 *
 * The one case that is NOT an error: a well-formed bbox outside Bulgaria. That
 * returns no coverage and no blocks, like any other area the Ministry has not
 * photographed, because a farmer panning to the Aegean has not done anything
 * wrong.
 */

import { codedBadRequest } from '@/lib/errors/types';
import { BULGARIA_ENVELOPE } from '@/lib/geo/cadastre-tiles';
import type { LonLatBbox } from '@/lib/geo/ortho-source';

/**
 * The widest span the server will serve, per axis, in degrees.
 *
 * 0.5° is roughly 55 km north-south and 40 km east-west at Bulgaria's
 * latitude — comfortably more than the client's own 0.3° farm-bounds request,
 * so an honest client never meets this, and far less than the ~10° that would
 * sweep the country.
 */
export const ORTHO_BBOX_MAX_SPAN_DEG = 0.5;

function refuse(detail: string): never {
    throw codedBadRequest('ORTHO_BBOX_INVALID', `The map area is not valid: ${detail}.`, {
        reference: 'bbox',
    });
}

/**
 * `minLon,minLat,maxLon,maxLat` → a bbox, or a coded refusal.
 *
 * **Lon first**, which is the GeoJSON order and what the client sends. The
 * WFS wants lat first, and that transposition happens once, in
 * `latLonBboxParam` — not here, so that this module and the client agree on
 * one convention and only the upstream call flips it. A transposed box over
 * Bulgaria lands in the Indian Ocean and returns nothing, which reads as "no
 * blocks here" rather than as an error, so the flip is worth having in exactly
 * one place.
 */
export function parseLonLatBbox(raw: string): LonLatBbox {
    const parts = raw.split(',');
    if (parts.length !== 4) refuse('it needs four comma-separated numbers');

    const [west, south, east, north] = parts.map((p) => Number(p.trim()));
    // `Number('')` is 0 and `Number('abc')` is NaN — the first is why this
    // checks finiteness rather than just NaN, since an empty field would
    // otherwise silently become the equator.
    if (![west, south, east, north].every((n) => Number.isFinite(n))) {
        refuse('one of the coordinates is not a number');
    }
    if (west < -180 || east > 180 || south < -90 || north > 90) {
        refuse('a coordinate is outside the world');
    }
    if (east <= west || north <= south) {
        refuse('the corners are inverted or the area is empty');
    }
    if (east - west > ORTHO_BBOX_MAX_SPAN_DEG || north - south > ORTHO_BBOX_MAX_SPAN_DEG) {
        refuse(`the area is wider than ${ORTHO_BBOX_MAX_SPAN_DEG}°`);
    }

    return { west, south, east, north };
}

/**
 * Does this bbox touch Bulgaria at all?
 *
 * Not a refusal — see the module docblock. The callers use it to answer "no
 * imagery" without asking the Ministry about Greece.
 */
export function bboxTouchesBulgaria(bbox: LonLatBbox): boolean {
    return !(
        bbox.east < BULGARIA_ENVELOPE.west ||
        bbox.west > BULGARIA_ENVELOPE.east ||
        bbox.north < BULGARIA_ENVELOPE.south ||
        bbox.south > BULGARIA_ENVELOPE.north
    );
}
