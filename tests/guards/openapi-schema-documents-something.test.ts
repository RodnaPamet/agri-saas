/**
 * A schema that accepts anything must not claim to describe nothing.
 *
 * ## The defect
 *
 * `UpdateFarmProfileRequest` reached the published spec with ZERO properties,
 * because `farm-profile.paths.ts` carried
 *
 *     // The handler's own schema, so the documented body cannot drift.
 *     body: z.object({}).passthrough().openapi('UpdateFarmProfileRequest', { … })
 *
 * — a comment asserting a property the code did not have. The handler's real
 * schema has thirteen fields with per-field bounds; the contract described an
 * empty object that accepts anything.
 *
 * That is worse than an undocumented route. An undocumented route is on
 * `openapi-undocumented-baseline.json`, where a client can see that it is
 * undescribed. A documented operation whose body schema is empty looks
 * complete: a generated client gets a type with no fields, and
 * agrent-ios#110's own rule — "read it out of the spec when it lands; do not
 * model from this message" — becomes impossible to follow while appearing to
 * be satisfied.
 *
 * ## The rule, and why it is structural rather than a name list
 *
 * The two cases are distinguishable from the schema itself:
 *
 *   properties: {}                        → a DELIBERATE empty body. `EmptyBody`
 *   (no additionalProperties)               is this: mutation endpoints whose
 *                                           semantics live entirely in the URL.
 *
 *   properties: {} + additionalProperties → `z.object({}).passthrough()`. It
 *                                           accepts any shape and documents
 *                                           none of it. Always a gap.
 *
 * So the guard does not need to know which names are legitimate. It fails on
 * the second shape, and `KNOWN_EMPTY` carries the three that predate it with a
 * reason each — shrink-only, with a no-stale-entries test, like every other
 * baseline in this repo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SPEC_REL = 'src/generated/openapi.json';
const ROOT = path.resolve(__dirname, '../..');

interface SchemaLike {
    type?: string;
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
    description?: string;
    allOf?: unknown[];
    oneOf?: unknown[];
    anyOf?: unknown[];
    $ref?: string;
}

/**
 * Names that document nothing while accepting anything, and why each is still
 * here. DELETE an entry in the same diff that documents it.
 */
const KNOWN_EMPTY: Record<string, string> = {
    SeasonDiaryRequest:
        'cadastre-reports.paths.ts:211 — `z.object({}).passthrough()` with no description at all. ' +
        'The season-diary report body is built by the web page only; no native client calls it. ' +
        'Needs its handler schema extracted the way farm-profile now is.',
    YearOnFarmRequest:
        'cadastre-reports.paths.ts:228 — same shape and same reason as SeasonDiaryRequest; the two ' +
        'were added together.',
    RentRoll:
        'cadastre-reports.paths.ts:144 — a RESPONSE, not a request, which makes it the worse case: ' +
        'a client reading the spec learns the endpoint returns an object and nothing about its ' +
        'fields. Described in prose ("Rent by lessor with obligations and payments") and nowhere ' +
        'in the schema.',
};

/** Does this schema accept arbitrary keys while declaring none? */
export function documentsNothing(schema: SchemaLike): boolean {
    // A composed schema describes itself through its branches.
    if (schema.allOf || schema.oneOf || schema.anyOf || schema.$ref) return false;
    if (schema.type !== 'object') return false;
    const declared = Object.keys(schema.properties ?? {}).length;
    if (declared > 0) return false;
    // `properties: {}` ALONE is a deliberate empty body — the distinction is
    // whether it also accepts anything.
    return schema.additionalProperties !== undefined;
}

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, SPEC_REL), 'utf8')) as {
    components: { schemas: Record<string, SchemaLike> };
    paths: Record<string, unknown>;
};
const schemas = spec.components.schemas;

describe('every documented schema describes something', () => {
    // ── Positive controls ────────────────────────────────────────────
    //
    // The assertion below is "this list is empty", which two empty inputs also
    // produce. Without these, a spec that failed to parse would read clean.

    it('control: the spec parsed and carries a real schema population', () => {
        expect(Object.keys(schemas).length).toBeGreaterThan(100);
        expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
        // Something in there genuinely declares properties, or the extractor
        // is reading the wrong shape.
        expect(
            Object.values(schemas).filter((s) => Object.keys(s.properties ?? {}).length > 0)
                .length,
        ).toBeGreaterThan(50);
    });

    it('control: documentsNothing separates the two empty shapes', () => {
        // The passthrough shape — accepts anything, declares nothing.
        expect(documentsNothing({ type: 'object', properties: {}, additionalProperties: {} })).toBe(
            true,
        );
        // A DELIBERATE empty body: no additionalProperties.
        expect(documentsNothing({ type: 'object', properties: {} })).toBe(false);
        // Declaring even one field is enough.
        expect(
            documentsNothing({ type: 'object', properties: { a: {} }, additionalProperties: {} }),
        ).toBe(false);
        // Non-objects and composed schemas describe themselves elsewhere.
        expect(documentsNothing({ type: 'string' })).toBe(false);
        expect(documentsNothing({ allOf: [{ $ref: '#/x' }] })).toBe(false);
        expect(documentsNothing({ $ref: '#/components/schemas/Thing' })).toBe(false);
    });

    it('control: EmptyBody is the deliberate shape, and is NOT flagged', () => {
        // Pins the real distinction against the real artifact: if someone adds
        // `.passthrough()` to EmptyBody, this control fails rather than the
        // baseline quietly absorbing it.
        const empty = schemas.EmptyBody;
        expect(empty).toBeDefined();
        expect(Object.keys(empty.properties ?? {})).toEqual([]);
        expect(empty.additionalProperties).toBeUndefined();
        expect(empty.description).toMatch(/empty request body/i);
        expect(documentsNothing(empty)).toBe(false);
    });

    // ── The rule ─────────────────────────────────────────────────────

    const offenders = Object.entries(schemas)
        .filter(([, s]) => documentsNothing(s))
        .map(([name]) => name)
        .sort();

    it('no NEW schema accepts anything while describing nothing', () => {
        const unexpected = offenders.filter((n) => !(n in KNOWN_EMPTY));
        if (unexpected.length > 0) {
            throw new Error(
                `${unexpected.length} schema(s) accept any shape and declare no properties:\n` +
                    unexpected.map((n) => `  ${n}`).join('\n') +
                    `\n\nThis is how \`UpdateFarmProfileRequest\` shipped with zero properties ` +
                    `while its\nhandler enforced thirteen bounded fields. A documented operation ` +
                    `with an empty body\nschema looks COMPLETE to a client — worse than being on ` +
                    `the undocumented baseline,\nwhere the gap is at least visible.\n\n` +
                    `Import the handler's Zod schema and register THAT (see ` +
                    `farm-profile.paths.ts),\nor add an entry to KNOWN_EMPTY with a written reason.`,
            );
        }
        expect(unexpected).toEqual([]);
    });

    it('KNOWN_EMPTY only shrinks — no stale entries', () => {
        const stale = Object.keys(KNOWN_EMPTY).filter((n) => !offenders.includes(n));
        expect(stale).toEqual([]);
    });

    it('every KNOWN_EMPTY entry carries a real reason', () => {
        for (const [name, reason] of Object.entries(KNOWN_EMPTY)) {
            expect(reason.length).toBeGreaterThan(40);
            // A reason that does not say where it lives is not actionable.
            expect(reason).toMatch(/paths\.ts/);
            expect(name).not.toBe('');
        }
    });

    it('the farm-profile request is documented — the case this guard came from', () => {
        const u = schemas.UpdateFarmProfileRequest;
        expect(u).toBeDefined();
        expect(Object.keys(u.properties ?? {}).sort()).toEqual([
            'address',
            'agricultureDirectorateCity',
            'egn',
            'eik',
            'grainProduced',
            'municipality',
            'odbhCity',
            'producerName',
            'registrationEkatte',
            'registrationPlace',
            'settlement',
            'sizeHa',
            'urn',
        ]);
        // The hazard a generated client cannot infer from types: an omitted
        // field is cleared. It has to be in the description or it is nowhere.
        // The hazard a generated client cannot infer from thirteen optional
        // properties — which way the merge goes. #1176 made absent mean
        // "unchanged"; before it, absent meant "cleared". A client reading a
        // stale copy of this spec would get that exactly backwards, so the
        // description states which it is and this pins that it says so.
        expect(u.description).toMatch(/MERGE SEMANTICS/);
        expect(u.description).toMatch(/LEFT UNCHANGED/);
        expect(u.description).toMatch(/only an explicit `null` clears/);
        expect(documentsNothing(u)).toBe(false);
    });
});
