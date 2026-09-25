/**
 * A property described as nullable must ADMIT null — with `$ref`s resolved.
 *
 * ## The version of this guard that was wrong
 *
 * It first asserted that a property must not be a BARE `$ref` while its
 * description said it could be null. That rule is false, and the iOS session
 * caught it: this spec expresses a nullable object two ways, and which one is
 * right depends on whether the target is REUSED.
 *
 *   LocationListItem.owner         allOf: [{$ref: UserRef}, {type: ["object","null"]}]
 *   AgDashboardPayload.achievements {$ref: AgDashboardAchievements}, whose own
 *                                   type is ["object","null"]
 *
 * `UserRef` appears in five payloads and cannot bake a null into itself, so the
 * nullability goes at the reference site. `AgDashboardAchievements` is
 * single-use, so it carries the null in its own type and the reference stays
 * bare. Both admit null. The first version of this guard would have failed the
 * second one, and passed only because the description happened to read
 * "`achievements` is null" rather than "`achievements`: null" — green by
 * phrasing, which is no better than red by accident.
 *
 * So the rule is about NULLABILITY, not about shape: resolve the reference and
 * ask whether null is admitted. That is the invariant worth holding, and it is
 * indifferent to which idiom expresses it.
 *
 * ## Why it is still worth having
 *
 * `.nullable()` CAN be lost — a `$ref` carries no siblings, so nullability
 * applied at a reference site to a target that does not carry it has nowhere to
 * live. And the pre-commit sync hook cannot see this class at all: it guards the
 * generated file against the source modules, and they agree, because the
 * generator faithfully reproduces whatever it decided the schema was. The
 * disagreement is between the schema and the prose beside it.
 *
 * ## What it does not reach
 *
 * Only SCHEMA and PROPERTY descriptions. A nullability claim made in an
 * OPERATION description is invisible to it — `AgDashboardPayload.achievements`
 * is exactly that case, and is correct only by luck of where the sentence was
 * written. Widening to operation descriptions means mapping a response schema
 * back to the operations that return it, which is more machinery than the two
 * properties this currently selects can justify. Recorded so the next person
 * knows the boundary rather than inferring a clean bill of health from green.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

type Node = Record<string, unknown>;

describe('a property described as nullable admits null, $refs resolved', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as {
        components: { schemas: Record<string, Node> };
    };
    const schemas = spec.components.schemas;

    /** Follow `$ref` into `components.schemas`. Depth-guarded against a cycle. */
    function resolve(node: Node, depth = 0): Node {
        const ref = node.$ref;
        if (typeof ref !== 'string' || depth > 8) return node;
        const name = ref.split('/').pop() as string;
        const target = schemas[name];
        return target ? resolve(target, depth + 1) : node;
    }

    function admitsNull(node: Node, depth = 0): boolean {
        if (depth > 8) return false;
        const n = resolve(node, depth);
        const t = n.type;
        if (t === 'null' || (Array.isArray(t) && t.includes('null'))) return true;
        for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
            const branch = n[key];
            if (Array.isArray(branch) && branch.some((b) => admitsNull(b as Node, depth + 1))) {
                return true;
            }
        }
        return false;
    }

    /** Properties whose own or containing description says THAT property is null. */
    function describedNullable(): Array<{ schema: string; prop: string; node: Node }> {
        const out: Array<{ schema: string; prop: string; node: Node }> = [];
        for (const [name, sch] of Object.entries(schemas)) {
            const props = (sch.properties ?? {}) as Record<string, Node>;
            for (const [prop, ps] of Object.entries(props)) {
                const text = `${(sch.description as string) ?? ''}\n${(ps.description as string) ?? ''}`;
                // `<prop>` followed by "is null" or ": null" — the two ways this
                // spec's prose says it. Deliberately not a bare search for
                // "null" anywhere in the description: that was measured and gave
                // 50% false positives, one description meaning a SIBLING could
                // be null and another describing parcels with null GEOMETRY.
                if (new RegExp(`\`?${prop}\`?\\s*(?::|\\bis\\b)\\s*\`?null`, 'i').test(text)) {
                    out.push({ schema: name, prop, node: ps });
                }
            }
        }
        return out;
    }

    it('finds properties described as nullable at all (positive control)', () => {
        // An empty selection satisfies the assertion below. If the prose is
        // reworded or the spec restructured, this says so rather than passing.
        expect(describedNullable().length).toBeGreaterThan(0);
    });

    it('every one of them admits null', () => {
        const offenders = describedNullable().filter(({ node }) => !admitsNull(node));
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} propert(ies) are DESCRIBED as nullable but the schema ` +
                    `does not admit null, with $refs resolved:\n` +
                    offenders.map((o) => `  ${o.schema}.${o.prop}`).join('\n') +
                    `\n\nEither the prose is wrong, or the null was lost. A \`$ref\` carries no ` +
                    `siblings, so nullability applied at a reference site to a target that does ` +
                    `not itself admit null has nowhere to live — put it on the target if the ` +
                    `target is single-use, or write the property as an explicit union.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
