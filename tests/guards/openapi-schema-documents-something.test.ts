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

/**
 * Nested positions that document nothing, and why each is still here.
 *
 * Separate from `KNOWN_EMPTY` because the keys are PATHS rather than component
 * names — `Owner.prop`, `Owner.prop[]` for an array's items, `Owner.prop{}` for
 * a map's values.
 */
const KNOWN_EMPTY_NESTED: Record<string, string> = {
    'SoilProfile.uncertainty':
        'planning.paths.ts:277 — `z.record(z.string(), z.unknown())`. The value is deliberately ' +
        'unknown: SoilGrids returns a per-property uncertainty bag whose keys and value shapes ' +
        'follow the upstream dataset rather than anything this codebase declares, so a schema ' +
        'here would be a guess that a client could rely on. The KEY type is documented; the ' +
        'value is honestly unknown. Revisit if the soil pipeline ever narrows it.',
};

/**
 * Keys that CONSTRAIN a schema. A value schema carrying none of them permits
 * anything, which is the case this guard is about.
 */
const CONSTRAINING_KEYS = new Set([
    'type', 'properties', 'items', '$ref', 'allOf', 'oneOf', 'anyOf', 'enum',
    'format', 'additionalProperties', 'required', 'pattern', 'minimum',
    'maximum', 'minLength', 'maxLength', 'nullable', 'const',
]);

/**
 * Is this `additionalProperties` value an UNDOCUMENTED one?
 *
 * The distinction the first version of this guard missed, and it matters
 * because it is the difference between a defect and a well-described map:
 *
 *     additionalProperties: {}                  -> any value. Documents nothing.
 *     additionalProperties: true                -> same.
 *     additionalProperties: { type: 'boolean' } -> a Record<string, boolean>.
 *                                                  FULLY documented; not a gap.
 *
 * `CurrentUser.featureFlags`, `BlendLotsResult.attributes` and
 * `LocationSmartDefaults.byParcel` are all the third kind. Flagging them would
 * have made this guard demand that a dictionary stop being a dictionary.
 */
function permitsAnyValue(additionalProperties: unknown): boolean {
    if (additionalProperties === true) return true;
    if (additionalProperties === null || typeof additionalProperties !== 'object') return false;
    return !Object.keys(additionalProperties as Record<string, unknown>)
        .some((k) => CONSTRAINING_KEYS.has(k));
}

/** Does this schema accept arbitrary keys while declaring none? */
export function documentsNothing(schema: SchemaLike): boolean {
    // A composed schema describes itself through its branches.
    if (schema.allOf || schema.oneOf || schema.anyOf || schema.$ref) return false;
    if (schema.type !== 'object') return false;
    const declared = Object.keys(schema.properties ?? {}).length;
    if (declared > 0) return false;
    // `properties: {}` ALONE is a deliberate empty body — the distinction is
    // whether it also accepts anything, AND whether what it accepts is itself
    // undescribed.
    if (schema.additionalProperties === undefined) return false;
    return permitsAnyValue(schema.additionalProperties);
}

/**
 * Every position in the spec that documents nothing, as a path.
 *
 * The first version of this guard checked `components.schemas` top-level ONLY,
 * so an open object nested inside an array's `items` was invisible to it. That
 * is not hypothetical: `FieldOperationDetail.parcels[]` was
 * `z.object({}).passthrough()` for its whole life, and the iOS client had to
 * model parcels from observed wire data because the contract described an
 * object with no fields. A guard aimed at "a schema that accepts anything must
 * not claim to describe nothing" could not see the live instance of exactly
 * that (found 2026-10-07, agrent-ios).
 *
 * `$ref` nodes are not followed — they point at a named schema this walk
 * reaches on its own, and following them would both double-report and risk a
 * cycle.
 */
export function collectDocumentsNothing(
    schemas: Record<string, SchemaLike>,
): string[] {
    const found: string[] = [];
    const walk = (node: unknown, pathLabel: string, depth: number): void => {
        if (depth > 8 || node === null || typeof node !== 'object') return;
        const s = node as SchemaLike & Record<string, unknown>;
        if (s.$ref) return;
        if (documentsNothing(s)) found.push(pathLabel);
        for (const [k, v] of Object.entries(s.properties ?? {})) {
            walk(v, `${pathLabel}.${k}`, depth + 1);
        }
        if (s.items && typeof s.items === 'object') walk(s.items, `${pathLabel}[]`, depth + 1);
        for (const comb of ['allOf', 'oneOf', 'anyOf'] as const) {
            const branches = s[comb];
            if (Array.isArray(branches)) {
                branches.forEach((b, i) => walk(b, `${pathLabel}|${comb}${i}`, depth + 1));
            }
        }
        const ap = s.additionalProperties;
        // Only descend into a map's value when it is a REAL schema — an empty
        // one is the offence itself, already reported above.
        if (ap && typeof ap === 'object' && !permitsAnyValue(ap)) {
            walk(ap, `${pathLabel}{}`, depth + 1);
        }
    };
    for (const [name, schema] of Object.entries(schemas)) walk(schema, name, 0);
    return found.sort();
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

    // Walks NESTED positions too — see `collectDocumentsNothing`.
    const offenders = collectDocumentsNothing(schemas);
    const isNested = (p: string) => /[.[|{]/.test(p);

    it('reports the population it covers, nested positions included', () => {
        // Printed rather than implied. The first version of this guard swept
        // 211 named schemas and 0 nested positions, and the difference is where
        // the defect was — so the count a reader sees should say which.
        const nested = offenders.filter(isNested);
        console.log(
            `documents-nothing sweep: ${Object.keys(schemas).length} named schemas, ` +
                `${offenders.length} offender(s) — ${offenders.length - nested.length} top-level, ` +
                `${nested.length} nested`,
        );
        expect(Array.isArray(offenders)).toBe(true);
    });

    it('no NEW schema accepts anything while describing nothing', () => {
        const unexpected = offenders.filter(
            (n) => !(n in KNOWN_EMPTY) && !(n in KNOWN_EMPTY_NESTED),
        );
        if (unexpected.length > 0) {
            throw new Error(
                `${unexpected.length} position(s) accept any shape and declare no properties:\n` +
                    unexpected.map((n) => `  ${n}`).join('\n') +
                    `\n\nThis is how \`UpdateFarmProfileRequest\` shipped with zero properties ` +
                    `while its\nhandler enforced thirteen bounded fields, and how ` +
                    `\`FieldOperationDetail.parcels[]\` shipped as\nan empty object while the route ` +
                    `sent full parcel geometry — the iOS client had to model\nfrom observed wire ` +
                    `data because the contract described an object with no fields.\n\n` +
                    `A documented operation with an empty schema looks COMPLETE to a client — ` +
                    `worse\nthan being on the undocumented baseline, where the gap is at least ` +
                    `visible.\n\n` +
                    `Import the real Zod schema and reference THAT (see how ` +
                    `field-operations.paths.ts\nimports \`ParcelGeo\` from locations.paths.ts), or ` +
                    `add an entry to KNOWN_EMPTY /\nKNOWN_EMPTY_NESTED with a written reason.\n\n` +
                    `NOTE: a typed map is NOT this. \`additionalProperties: { type: 'boolean' }\` ` +
                    `is a\nfully documented Record<string, boolean> and is deliberately not ` +
                    `flagged.`,
            );
        }
        expect(unexpected).toEqual([]);
    });

    it('both baselines only shrink — no stale entries', () => {
        const stale = [...Object.keys(KNOWN_EMPTY), ...Object.keys(KNOWN_EMPTY_NESTED)].filter(
            (n) => !offenders.includes(n),
        );
        expect(stale).toEqual([]);
    });

    it('control: a TYPED map is not flagged — a dictionary may stay a dictionary', () => {
        // The distinction the first version of this guard did not draw. Without
        // it, extending the walk to nested positions would have demanded that
        // `CurrentUser.featureFlags` (Record<string, boolean>) stop being a map.
        expect(
            documentsNothing({ type: 'object', properties: {}, additionalProperties: { type: 'boolean' } }),
        ).toBe(false);
        // ...while an undescribed value IS the offence.
        expect(documentsNothing({ type: 'object', properties: {}, additionalProperties: {} })).toBe(true);
        expect(documentsNothing({ type: 'object', properties: {}, additionalProperties: true })).toBe(true);
    });

    it('control: the walker finds an open object nested in array ITEMS', () => {
        // The exact shape that was invisible to this guard for its whole life.
        // Asserted on a synthetic spec so it keeps holding after the real
        // instance is fixed — otherwise this control retires itself.
        const found = collectDocumentsNothing({
            Holder: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: {} } },
                },
            } as never,
        });
        expect(found).toEqual(['Holder.rows[]']);
    });

    it('control: a $ref inside items is NOT reported — it is reached on its own', () => {
        const found = collectDocumentsNothing({
            Holder: {
                type: 'object',
                properties: { rows: { type: 'array', items: { $ref: '#/components/schemas/Thing' } } },
            } as never,
            Thing: { type: 'object', properties: { a: { type: 'string' } } } as never,
        });
        expect(found).toEqual([]);
    });

    it('the field-operation parcels are documented — the case that extended this guard', () => {
        // `FieldOperationDetail.parcels` was `z.object({}).passthrough()`, so a
        // client reading the spec learned the array existed and nothing about
        // its contents. It now references the one `ParcelGeo` definition that
        // `GET /locations/{id}/parcels` also serves, which is what the old
        // comment ("so the two cannot drift") was reaching for.
        const items = (schemas.FieldOperationDetail?.properties as Record<string, { items?: { $ref?: string } }>)
            ?.parcels?.items;
        expect(items?.$ref).toBe('#/components/schemas/ParcelGeo');
        // ...and the target actually describes something.
        expect(Object.keys(schemas.ParcelGeo?.properties ?? {}).length).toBeGreaterThan(5);
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
