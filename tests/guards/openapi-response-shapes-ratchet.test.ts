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
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

/**
 * Measured 2026-09-25. MAY ONLY FALL.
 *
 * 23 -> 13: tasks (9) and journal (1) now reference shapes that already existed.
 * The 13 remaining are all grain. Twelve are contracts / costs / yield-records,
 * whose DTOs exist but describe shapes WITH relation includes that each need
 * checking against the usecase's actual return — `GrainCostRow` looked like the
 * cost-entry shape and is in fact planting-based, so wiring it would have
 * documented the wrong payload, which is worse than documenting none. The
 * thirteenth is the calculator, which is the one the module's own note is about.
 */
const CEILING = 13;

/** Slack tolerated before the ceiling must be lowered. */
const DRIFT_ALLOWANCE = 2;

describe('operations documenting no 2xx response shape', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as {
        paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };

    function shapeless(): string[] {
        const out: string[] = [];
        for (const [p, ops] of Object.entries(spec.paths)) {
            for (const [m, op] of Object.entries(ops)) {
                if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
                const responses = (op.responses ?? {}) as Record<string, {
                    content?: Record<string, { schema?: Record<string, unknown> }>;
                }>;
                for (const [code, r] of Object.entries(responses)) {
                    if (!code.startsWith('2')) continue;
                    const sch = r.content?.['application/json']?.schema;
                    if (sch === undefined) continue; // no JSON body at all — not this gap
                    const describes = ['$ref', 'properties', 'type', 'items', 'anyOf', 'oneOf', 'allOf']
                        .some((k) => sch[k] !== undefined);
                    if (!describes) out.push(`${m.toUpperCase()} ${p}`);
                }
            }
        }
        return out;
    }

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
