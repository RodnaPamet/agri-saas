/**
 * A response union whose members a client can still tell apart (#1612).
 *
 * `GET /grain/costs/defaults` declares its 200 as a two-member union, and
 * `z.union` renders as **`anyOf`** — not `oneOf`. `anyOf` means "at least
 * one", so it does not by itself tell a client which member it received. The
 * published description instructs clients to branch on which KEY is present
 * (`overheads` or `lines`), and that instruction is only sound while the two
 * members have no required property in common and neither admits the other's
 * required keys.
 *
 * Today they are disjoint: `CostDefaults` requires `overheads`,
 * `CropCostDefaults` requires `commodity` and `lines`. Neither sets
 * `additionalProperties: false`, so nothing structural stops a future edit
 * from adding an optional `lines` to `CostDefaults` — at which point a
 * response could satisfy both members, a client branching on a key picks
 * whichever it tests first, and NOTHING fails. The spec would still be
 * valid, the breaking-change gate would see an added optional property (not
 * a break), and the only symptom would be a client occasionally rendering an
 * overhead sheet as a crop sheet.
 *
 * This is the test that notices. It is deliberately about the GENERATED spec
 * rather than the zod source: what a client reads is the spec.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

interface Schema {
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
}

/** Operations whose success response is a union, and must stay discriminable. */
const UNION_RESPONSES = [
    { operationId: 'getCostDefaults', status: '200' },
] as const;

describe('a union response stays discriminable by key (#1612)', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
        paths: Record<string, Record<string, { operationId?: string; responses: Record<string, {
            content?: Record<string, { schema?: { anyOf?: { $ref?: string }[]; oneOf?: { $ref?: string }[] } }>;
        }> }>>;
        components: { schemas: Record<string, Schema> };
    };

    const resolve = (ref: string): Schema => {
        const name = ref.replace('#/components/schemas/', '');
        const s = spec.components.schemas[name];
        expect(s).toBeDefined();
        return s;
    };

    const membersOf = (operationId: string, status: string): Schema[] => {
        for (const ops of Object.values(spec.paths)) {
            for (const op of Object.values(ops)) {
                if (op?.operationId !== operationId) continue;
                const schema = op.responses[status]?.content?.['application/json']?.schema;
                const refs = schema?.anyOf ?? schema?.oneOf;
                // Positive control: if the union is ever flattened back to a
                // single schema, this test must FAIL rather than silently
                // range over nothing — an empty selection passes everything.
                expect(refs).toBeDefined();
                return refs!.map((r) => resolve(r.$ref!));
            }
        }
        throw new Error(`no operation ${operationId} in the spec`);
    };

    it.each(UNION_RESPONSES)(
        '$operationId -> $status: members share no required property',
        ({ operationId, status }) => {
            const members = membersOf(operationId, status);
            expect(members.length).toBeGreaterThanOrEqual(2);
            for (let i = 0; i < members.length; i++) {
                for (let j = i + 1; j < members.length; j++) {
                    const a = new Set(members[i].required ?? []);
                    const shared = (members[j].required ?? []).filter((k) => a.has(k));
                    expect(shared).toEqual([]);
                }
            }
        },
    );

    it.each(UNION_RESPONSES)(
        '$operationId -> $status: no member declares another member’s required key',
        ({ operationId, status }) => {
            // The subtler half, and the one the issue called out. Disjoint
            // `required` is not enough: if `CostDefaults` gained an OPTIONAL
            // `lines`, a crop response would satisfy both members and a client
            // branching on `lines` could pick the overhead shape.
            const members = membersOf(operationId, status);
            for (const [i, m] of members.entries()) {
                const own = new Set(Object.keys(m.properties ?? {}));
                for (const [j, other] of members.entries()) {
                    if (i === j) continue;
                    const borrowed = (other.required ?? []).filter((k) => own.has(k));
                    expect(borrowed).toEqual([]);
                }
            }
        },
    );

    it('control: the checks DETECT a member that borrows a required key', () => {
        // Without this, both assertions above are satisfied by any pair of
        // schemas — including a pair the checks cannot actually judge.
        const a: Schema = { required: ['overheads'], properties: { overheads: {}, lines: {} } };
        const b: Schema = { required: ['commodity', 'lines'], properties: { commodity: {}, lines: {} } };
        const own = new Set(Object.keys(a.properties ?? {}));
        expect((b.required ?? []).filter((k) => own.has(k))).toEqual(['lines']);
    });
});
