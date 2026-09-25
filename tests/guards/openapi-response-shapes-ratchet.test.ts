/**
 * Operations that document no 2xx SHAPE — a downward ratchet.
 *
 * A gap nothing was counting. `openapi-paths-complete` ratchets routes with no
 * OPERATION at all (309 and falling); this counts operations that have one and
 * describe no response body. There were 23, spread across three whole families,
 * and the baseline never moved because it was measuring something else.
 *
 * An empty schema and a WRONG schema are indistinguishable to a client, and only
 * one of them can be caught by reading. Both leave a client modelling from
 * measurement — which is the state the iOS side described as having seven
 * `CostEntry` fields it could not verify against anything.
 *
 * ── Why this is a ceiling and not zero ──
 *
 * `grain.paths.ts` documents its own reason for `z.unknown()`, and it is a good
 * one: hand-writing `CalculatorData` as Zod makes a THIRD spelling of one
 * payload, beside the TypeScript type and the mapper that builds it, free to
 * drift from both. A guard demanding zero would force exactly the duplication
 * that module exists to prevent.
 *
 * So the number may only FALL, and falling legitimately means one of two things:
 * pointing an operation at a schema that already exists (which is what took this
 * from 23 to 13 — `TaskDTOSchema` was already the trusted response for two other
 * route families), or giving a payload a real single source of truth. It does
 * not mean writing a copy to satisfy a count.
 *
 * ── what this scan EXEMPTS, and the hole that used to be here ──
 *
 * The first version of this guard skipped, unconditionally and with a one-line
 * comment, every 2xx that declared no `application/json` schema. That is right
 * for the four operations it was written against — two binary vector-tile
 * responses that declare their real media type, and two 204s — but it was a
 * blanket skip, so a genuinely-JSON operation documenting no content at all
 * would have passed invisibly. The guard would have read as complete while
 * missing exactly the class it hunts.
 *
 * It is now exempt-by-reason instead: 204/205 are bodyless by HTTP definition,
 * and a declared non-JSON media type is documentation rather than the absence
 * of it. Anything else with no content is COUNTED and named.
 *
 * The iOS session found this by reporting a different number than mine from the
 * same spec — same denominator, 86 operations. Reconciling the two is what
 * surfaced the skip. From inside, a guard's own blind spot reads as a clean
 * result.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

/**
 * Measured 2026-09-26. MAY ONLY FALL.
 *
 * 23 -> 13: tasks (9) and journal (1) now reference shapes that already existed.
 * 13 -> 1: costs and yield records are each mapped by ONE `toDto`, so their
 * shape was already defined in exactly one place; the contract list's three
 * decorations and its rollup are each a PURE, EXPORTED function, so each has a
 * single source of truth a schema can be checked against by running it. None of
 * that is a second spelling of anything.
 *
 * The one left is `GET /grain/calculator`, and it is the one the module's note
 * is actually about: its payload is assembled by a mapper module with no
 * exported pure pieces to check a schema against, so a Zod mirror would be a
 * third spelling of one money payload, free to drift from both the types and
 * the mapper. Draining it means giving that payload a single source of truth —
 * NOT writing the copy. Until then this stays at 1 rather than 0.
 */
const CEILING = 1;

/**
 * Slack tolerated before the ceiling must be lowered.
 *
 * Zero, now that the count is 1. An allowance is headroom, and headroom at this
 * size is the whole population: at 2 the ceiling could sit at 1 while three
 * operations were undocumented, which is the accumulated slack this sentinel
 * exists to forbid. It was 2 when the count was 13 and a single documented
 * shape was a rounding error; it is not one now.
 */
const DRIFT_ALLOWANCE = 0;

interface SpecLike {
    paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}

/**
 * Operations whose 2xx documents no shape.
 *
 * Takes the spec rather than closing over the real one, so the rules below can
 * be exercised against a synthetic document. The "no content declared" branch
 * has NO real instance today — it exists for a regression that has not happened
 * yet, which means the only way to know it works is to feed it one.
 */
export function shapelessIn(spec: SpecLike): string[] {
        const out: string[] = [];
        for (const [p, ops] of Object.entries(spec.paths)) {
            for (const [m, op] of Object.entries(ops)) {
                if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
                const responses = (op.responses ?? {}) as Record<string, {
                    content?: Record<string, { schema?: Record<string, unknown> }>;
                }>;
                for (const [code, r] of Object.entries(responses)) {
                    if (!code.startsWith('2')) continue;

                    // 204/205 carry no body BY DEFINITION. Exempt on the status
                    // code, which is a fact about HTTP, not on the absence of a
                    // schema, which is the thing being measured.
                    if (code === '204' || code === '205') continue;

                    const media = Object.keys(r.content ?? {});

                    // A response declaring a non-JSON media type is DOCUMENTED.
                    // A vector tile is not missing a JSON schema; it is not JSON.
                    if (media.length > 0 && !media.includes('application/json')) continue;

                    const sch = r.content?.['application/json']?.schema;

                    // A 2xx that is not 204/205 and declares no content at all.
                    // This used to be skipped unconditionally and is the hole
                    // described above.
                    if (sch === undefined) {
                        out.push(`${m.toUpperCase()} ${p} (${code}: no content declared)`);
                        continue;
                    }

                    const describes = ['$ref', 'properties', 'type', 'items', 'anyOf', 'oneOf', 'allOf']
                        .some((k) => sch[k] !== undefined);
                    if (!describes) out.push(`${m.toUpperCase()} ${p}`);
                }
            }
        }
        return out;
}

describe('operations documenting no 2xx response shape', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as SpecLike;
    const shapeless = () => shapelessIn(spec);

    it(`stays at or below ${CEILING}`, () => {
        const hits = shapeless();
        if (hits.length > CEILING) {
            throw new Error(
                `${hits.length} operations document no 2xx shape (ceiling ${CEILING}):\n` +
                    hits.map((h) => `  ${h}`).join('\n') +
                    `\n\nPoint the operation at a schema that already exists, or give the ` +
                    `payload a single source of truth. Do NOT hand-write a mirror to satisfy ` +
                    `this count — see the note in grain.paths.ts.`,
            );
        }
        expect(hits.length).toBeLessThanOrEqual(CEILING);
    });

    it('the ceiling tracks reality — no accumulated slack', () => {
        // Without this, every shape documented silently buys headroom for a new
        // undocumented one and the ratchet stops ratcheting.
        expect(CEILING).toBeLessThanOrEqual(shapeless().length + DRIFT_ALLOWANCE);
    });

    it('the scan finds operations at all (positive control)', () => {
        // An empty selection satisfies a ceiling. If the spec is restructured or
        // the response key moves, this says so rather than reading as a clean
        // bill of health.
        const total = Object.values(spec.paths).flatMap((ops) =>
            Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)),
        ).length;
        expect(total).toBeGreaterThan(50);
    });
});

/**
 * The rules themselves, against a synthetic spec.
 *
 * The real document exercises exactly one of these branches. Everything else —
 * the 204 exemption, the non-JSON exemption, and the no-content branch that has
 * no instance at all — is proven here or not at all. A guard whose exemptions
 * are only ever asserted is a guard whose exemptions are only ever hoped for.
 */
describe('the counting rules', () => {
    const op = (responses: Record<string, unknown>) => ({ paths: { '/x': { get: { responses } } } });

    it('counts a JSON 2xx whose schema describes nothing', () => {
        expect(shapelessIn(op({ 200: { content: { 'application/json': { schema: {} } } } }))).toHaveLength(1);
    });

    it('does NOT count a JSON 2xx that describes something', () => {
        expect(
            shapelessIn(op({ 200: { content: { 'application/json': { schema: { $ref: '#/x' } } } } })),
        ).toHaveLength(0);
        expect(
            shapelessIn(op({ 200: { content: { 'application/json': { schema: { type: 'object' } } } } })),
        ).toHaveLength(0);
    });

    it('exempts 204/205 — bodyless by HTTP definition, not by omission', () => {
        expect(shapelessIn(op({ 204: {} }))).toHaveLength(0);
        expect(shapelessIn(op({ 205: {} }))).toHaveLength(0);
    });

    it('exempts a declared NON-JSON media type — a tile is not JSON, not missing JSON', () => {
        expect(
            shapelessIn(op({ 200: { content: { 'application/vnd.mapbox-vector-tile': {} } } })),
        ).toHaveLength(0);
    });

    it('COUNTS a 200 that declares no content at all — the branch with no real instance', () => {
        // This is the hole the previous version had: it skipped on a missing
        // JSON schema without asking WHY it was missing, so this case passed
        // silently. If this test ever goes green by returning 0, the skip has
        // been widened back.
        const hits = shapelessIn(op({ 200: { description: 'Fine.' } }));
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('no content declared');
    });

    it('ignores non-2xx responses', () => {
        expect(shapelessIn(op({ 400: { content: { 'application/json': { schema: {} } } } }))).toHaveLength(0);
        expect(shapelessIn(op({ 500: { content: { 'application/json': { schema: {} } } } }))).toHaveLength(0);
    });
});
