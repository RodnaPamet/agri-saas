/**
 * The parcel-clusters route must return via `jsonWithETag`.
 *
 * It is a hot list read on a page that can hold 100+ parcels, and the
 * payload carries a coordinate per cluster plus every member id. The
 * cold-start data-cost work (`docs/implementation-notes/2026-07-11-cold-start-datacost.md`)
 * expects cacheable list GETs to honour `If-None-Match`, so re-opening
 * the tab or toggling back from the satellite view costs a 304 rather
 * than the whole payload — which on rural LTE is the difference between
 * instant and a visible wait.
 *
 * `jsonResponse` would still WORK. That is exactly why this needs a
 * guard: swapping it in produces no error, no failing test and no
 * visible defect in development, only a slower page for the operator on
 * a bad connection who will never file a bug about it.
 *
 * Source-text guard (CLAUDE.md, "Green is not the same as executed") —
 * it proves the call is present, not that a 304 is served.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const ROUTE = path.join(
    ROOT,
    'src/app/api/t/[tenantSlug]/locations/[id]/parcel-clusters/route.ts',
);

const ETAG_CALL = /jsonWithETag\s*\(/;
const PLAIN_JSON_CALL = /\bjsonResponse\s*\(/;

describe('parcel-clusters route returns via jsonWithETag', () => {
    it('the route file still exists where the guard expects it', () => {
        // A moved or renamed route would make every assertion below
        // vacuously pass.
        expect(fs.existsSync(ROUTE)).toBe(true);
    });

    const src = fs.existsSync(ROUTE) ? fs.readFileSync(ROUTE, 'utf8') : '';

    it('calls jsonWithETag', () => {
        expect(ETAG_CALL.test(src)).toBe(true);
    });

    it('imports it from the canonical module', () => {
        expect(src).toMatch(/from '@\/lib\/http\/etag'/);
    });

    it('does NOT fall back to jsonResponse', () => {
        expect(PLAIN_JSON_CALL.test(src)).toBe(false);
    });

    it.each([
        ['a jsonResponse swap', "return jsonResponse(overview);"],
        ['a spaced call', "return jsonResponse (overview);"],
    ])('the detector fires on %s (mutation proof)', (_label, planted) => {
        // Plant the regression, watch it match. A guard that only ever
        // passes is indistinguishable from one that cannot fail.
        expect(PLAIN_JSON_CALL.test(planted)).toBe(true);
        expect(ETAG_CALL.test(planted)).toBe(false);
    });

    it('the detector does NOT fire on the correct form (false-positive proof)', () => {
        const correct = 'return jsonWithETag(req, overview);';
        expect(ETAG_CALL.test(correct)).toBe(true);
        expect(PLAIN_JSON_CALL.test(correct)).toBe(false);
    });
});
