/**
 * A `$ref` cannot carry siblings, so `.nullable()` on a REGISTERED schema is
 * silently dropped at generation.
 *
 * This shipped. `FieldBriefingPayload.briefing` was written
 * `FieldBriefing.nullable()` in the source module and came out of the generator
 * as a bare `$ref`, in `required`, with the null gone — while the operation
 * description said "`briefing: null`" three times and the three
 * `*Configured` / `*Available` booleans existed for no other purpose than to
 * explain its absence. A client generated from the file would have declared it
 * non-optional and thrown on exactly the state the paragraph was about.
 *
 * The pre-commit sync hook cannot catch this: it guards the generated file
 * against the source modules, and here they AGREED — the generator faithfully
 * reproduced what it had decided the schema was. The disagreement was between
 * the schema and the prose sitting beside it.
 *
 * ── What this checks, and why it is narrow ──
 *
 * A property that is a BARE `$ref` (no `anyOf`/`allOf`/siblings) while the
 * surrounding description says that property can be null.
 *
 * A broader version — "any property whose description mentions null must admit
 * null" — was measured first and rejected: of its four hits, two were false
 * positives (one description said a sibling could be null, another described
 * parcels with null GEOMETRY) and two were `z.unknown()` holes rather than
 * nullability bugs. A guard that needs an allowlist on the day it is written is
 * one people learn to ignore, which is the same ending as the silence it was
 * meant to fix.
 *
 * The fix, when this fires: write the property as an explicit union —
 * `z.union([Thing, z.null()])` — which yields `anyOf: [{$ref}, {type: null}]`
 * and stays in `required`. Do NOT reach for `.nullable().optional()`, which is
 * what the neighbouring nullable refs in this spec use: `.optional()` also
 * drops the property out of `required`, and a field that is always present but
 * sometimes null is a different contract from one that may be absent.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

interface SchemaNode {
    $ref?: string;
    description?: string;
    properties?: Record<string, SchemaNode>;
}

describe('a nullable $ref must not lose its null at generation', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as {
        components: { schemas: Record<string, SchemaNode> };
    };
    const schemas = spec.components.schemas;

    /** Properties that are a `$ref` and nothing else. */
    function bareRefProperties(): Array<{ schema: string; prop: string; containerDesc: string }> {
        const out: Array<{ schema: string; prop: string; containerDesc: string }> = [];
        for (const [name, sch] of Object.entries(schemas)) {
            for (const [prop, ps] of Object.entries(sch.properties ?? {})) {
                if (Object.keys(ps).length === 1 && ps.$ref) {
                    out.push({
                        schema: name,
                        prop,
                        containerDesc: `${sch.description ?? ''}\n${ps.description ?? ''}`,
                    });
                }
            }
        }
        return out;
    }

    it('finds bare $ref properties at all (positive control)', () => {
        // Without this, a renamed key or a restructured spec would make the
        // assertion below vacuous and read as a clean bill of health.
        expect(bareRefProperties().length).toBeGreaterThan(0);
    });

    it('no bare $ref is described as nullable', () => {
        const offenders = bareRefProperties().filter(({ prop, containerDesc }) =>
            new RegExp(`\`?${prop}\`?\\s*:?\\s*null`, 'i').test(containerDesc),
        );

        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} propert(ies) are a bare $ref while their description says ` +
                    `they can be null — the null was dropped at generation:\n` +
                    offenders.map((o) => `  ${o.schema}.${o.prop}`).join('\n') +
                    `\n\nWrite it as z.union([Thing, z.null()]) in the paths module. ` +
                    `NOT .nullable() (silently dropped on a registered schema) and NOT ` +
                    `.nullable().optional() (also drops it from \`required\`).`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
