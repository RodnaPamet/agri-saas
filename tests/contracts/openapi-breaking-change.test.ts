/**
 * The breaking-change guard, and the mutation proof that it is calibrated.
 *
 * Two failure modes, and this file exists to rule out BOTH:
 *
 *   1. Too loose — a removed field ships and breaks every installed app. An
 *      App Store binary cannot be rolled back the way a Watchtower-updated
 *      image can, so the only fast remedy is a server revert.
 *   2. Too strict — every new optional field trips the guard, people route
 *      around it, and it protects nothing. Not hypothetical here: the OI-3
 *      auth guard hard-pinned an action version and reddened on routine
 *      Dependabot bumps until #599 relaxed it. A contract guard that cries
 *      wolf earns the same contempt.
 *
 * So the additive cases below are as load-bearing as the breaking ones.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildOpenApiDoc, serializeDoc } from '../../scripts/openapi-build';
import { findBreakingChanges } from '../../scripts/openapi-breaking';

const COMMITTED = path.resolve(__dirname, '../../public/openapi.json');

function schemaSpec(schemas: Record<string, unknown>) {
    return { components: { schemas } };
}

describe('breaking-change classifier — the BREAKING cases', () => {
    it('flags a REMOVED schema', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({});
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('schema-removed');
    });

    it('flags a REMOVED property — the canonical case from the DONE WHEN', () => {
        const before = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        });
        const after = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('property-removed');
        expect(found[0].property).toBe('b');
    });

    it('flags a property BECOMING REQUIRED', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('property-now-required');
    });

    it('flags a NARROWED enum', () => {
        const before = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A', 'B', 'C'] } } },
        });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A', 'B'] } } },
        });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('enum-narrowed');
    });

    it('flags a CHANGED type', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { n: { type: 'string' } } } });
        const after = schemaSpec({ Thing: { type: 'object', properties: { n: { type: 'number' } } } });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('type-changed');
    });
});

describe('breaking-change classifier — the ADDITIVE cases must stay SILENT', () => {
    // These matter as much as the ones above. A guard that fires here is a
    // guard people disable.
    it('a NEW schema is not breaking', () => {
        const before = schemaSpec({ A: { type: 'object', properties: {} } });
        const after = schemaSpec({ A: { type: 'object', properties: {} }, B: { type: 'object', properties: {} } });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a NEW OPTIONAL property is not breaking — the DONE WHEN case', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a WIDENED enum is not breaking', () => {
        const before = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A'] } } },
        });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A', 'B'] } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a WIDENED type (string -> string|null) is not breaking', () => {
        // A superset still decodes everything the old client could send.
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: ['string', 'null'] } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a description-only change is not breaking', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string', description: 'now documented' } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a property that was ALREADY required staying required is not breaking', () => {
        const s = { Thing: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } };
        expect(findBreakingChanges(schemaSpec(s), schemaSpec(s))).toEqual([]);
    });
});

describe('the guard, against the real committed spec', () => {
    // The CI gate. The committed spec is the baseline every PR is measured
    // against, and it lives in the SAME test runtime as the generator
    // (scripts/generate-openapi.ts delegates to Jest precisely so the writer
    // and verifier share one module-loading path) — so a comparison here
    // cannot drift for reasons unrelated to the API.
    const committed = JSON.parse(fs.readFileSync(COMMITTED, 'utf-8'));
    const generated = JSON.parse(serializeDoc(buildOpenApiDoc({ verbose: false })));

    it('HEAD introduces no breaking change against the committed contract', () => {
        const found = findBreakingChanges(committed, generated);
        expect({ breaking: found }).toEqual({ breaking: [] });
    });

    it('MUTATION PROOF: deleting a real field from the real spec IS caught', () => {
        // Proves the gate above is not vacuously passing because the two specs
        // happen to be identical. Removes an actual property from an actual
        // schema and asserts the classifier notices.
        const name = Object.keys(committed.components.schemas).find((n) => {
            const props = committed.components.schemas[n].properties;
            return props && Object.keys(props).length > 0;
        });
        expect(name).toBeDefined();

        const mutated = JSON.parse(JSON.stringify(committed));
        const props = mutated.components.schemas[name!].properties;
        const victim = Object.keys(props)[0];
        delete props[victim];

        const found = findBreakingChanges(committed, mutated);
        expect(found.length).toBeGreaterThan(0);
        expect(found[0].kind).toBe('property-removed');
        expect(found[0].property).toBe(victim);
    });

    it('MUTATION PROOF: adding an optional field to the real spec is NOT caught', () => {
        const mutated = JSON.parse(JSON.stringify(committed));
        const name = Object.keys(mutated.components.schemas)[0];
        mutated.components.schemas[name].properties = {
            ...mutated.components.schemas[name].properties,
            aBrandNewOptionalField: { type: 'string' },
        };
        expect(findBreakingChanges(committed, mutated)).toEqual([]);
    });
});
