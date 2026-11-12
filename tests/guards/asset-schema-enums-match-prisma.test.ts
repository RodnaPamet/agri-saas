/**
 * The asset schemas' enum lists must match the Prisma enums — #2950.
 *
 * ## Why the lists are spelled out at all
 *
 * `CreateAssetSchema.type` was `z.string().min(1)` while `Asset.type` is a
 * Prisma ENUM column, so `type: 'TRAKTOR'` passed validation, reached
 * `createAsset`, and failed at Prisma as a `PrismaClientValidationError` — a
 * **500 where the caller had earned a 400**. Harmless while the only caller was
 * a web form picking from a fixed list; #2948 puts an iOS client on that
 * endpoint, and a mobile client building a machine-creation screen is exactly
 * the caller that sends a typo or a localised label.
 *
 * The obvious fix is `z.nativeEnum(AssetType)`, and it was rejected for a
 * BUNDLE reason rather than a stylistic one: `src/lib/schemas/index.ts` does
 * not import `@prisma/client` and IS imported by two client components
 * (`NewTaskFields`, `ReportDialog`). Pulling the generated client in as a
 * VALUE there risks Prisma's runtime reaching the browser bundle — the class
 * `check-public-chunk-payload.mjs` exists to catch, and a cost paid by every
 * visitor of a public page.
 *
 * So the members are written out, like `status` and `criticality` already were,
 * and this file is what stops the copy drifting from the enum. Spelling a list
 * twice is only safe when something compares them.
 *
 * ## It covers THREE fields, not the one the issue named
 *
 * #2950 is about `type`. Measured while fixing it: `status` and `criticality`
 * were already spelled out and ALSO unguarded — no test anywhere compares any
 * of these lists to the schema. Guarding only the field that happened to be
 * broken would leave two copies of the same hazard, and the next enum value
 * added to either would diverge silently.
 *
 * `UpdateAssetSchema` carries the same three, and #2950 named only the create
 * schema — fixing that alone would have left the identical 500 reachable by
 * `PATCH`. `count-the-routes-a-gate-covers`.
 */
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCHEMA_DIR = path.join(ROOT, 'prisma/schema');
const SCHEMAS_TS = path.join(ROOT, 'src/lib/schemas/index.ts');

/** Every `.prisma` file, concatenated — Prisma itself reads the folder. */
function prismaSource(): string {
    return readdirSync(SCHEMA_DIR)
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8'))
        .join('\n');
}

/**
 * The members of a Prisma enum, in declaration order.
 *
 * Comment lines are dropped: `enum` bodies here carry `///` docstrings, and a
 * word inside one would otherwise be read as a member — the same reason the
 * removable-kinds guard blanks comments first.
 */
function prismaEnum(src: string, name: string): string[] {
    const m = src.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
    if (!m) return [];
    return m[1]
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

/** The string members of a named object's `z.enum([...])` field. */
function schemaEnum(src: string, schemaName: string, field: string): string[] {
    const start = src.indexOf(`export const ${schemaName}`);
    if (start === -1) return [];
    // Bound the search at the NEXT top-level export, so a field of the same
    // name in a later schema cannot be read as this one's.
    const nextExport = src.indexOf('\nexport const ', start + 1);
    const body = src.slice(start, nextExport === -1 ? undefined : nextExport);
    const f = body.match(new RegExp(`\\n\\s+${field}:\\s*z\\.enum\\(\\[([^\\]]*)\\]`));
    if (!f) return [];
    return [...f[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]);
}

const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['type', 'AssetType'],
    ['status', 'AssetStatus'],
    ['criticality', 'Criticality'],
];

describe('#2950 — the asset schemas cannot drift from the Prisma enums', () => {
    const prisma = prismaSource();
    const ts = readFileSync(SCHEMAS_TS, 'utf8');

    it('ranges over a real population — an empty extraction passes vacuously', () => {
        // Every assertion below compares two lists. Two empty lists are equal,
        // so without these floors a renamed schema or a changed field shape
        // turns this file into a no-op that still reports green.
        expect(prismaEnum(prisma, 'AssetType').length).toBeGreaterThanOrEqual(10);
        expect(prismaEnum(prisma, 'AssetStatus').length).toBeGreaterThanOrEqual(3);
        expect(prismaEnum(prisma, 'Criticality').length).toBeGreaterThanOrEqual(3);
        for (const schema of ['CreateAssetSchema', 'UpdateAssetSchema']) {
            for (const [field] of PAIRS) {
                expect(schemaEnum(ts, schema, field).length).toBeGreaterThanOrEqual(3);
            }
        }
        console.log(
            `[asset-schema-enums] prisma_type=${prismaEnum(prisma, 'AssetType').length} `
            + `prisma_status=${prismaEnum(prisma, 'AssetStatus').length} `
            + `prisma_criticality=${prismaEnum(prisma, 'Criticality').length} `
            + `schemas=2 fields=${PAIRS.length}`,
        );
    });

    describe.each(['CreateAssetSchema', 'UpdateAssetSchema'])('%s', (schema) => {
        it.each(PAIRS)('%s matches the %s enum EXACTLY', (field, enumName) => {
            const declared = schemaEnum(ts, schema, field);
            const actual = prismaEnum(prisma, enumName);
            // A SET comparison, and sorted: the schema may list members in a
            // product order rather than the schema's. What must not differ is
            // membership — a missing member is a 400 for a value the column
            // accepts, and an extra one is the 500 this issue is about.
            expect([...declared].sort()).toEqual([...actual].sort());
        });
    });

    describe('the detector can fail — proved on crafted sources', () => {
        const CRAFTED_PRISMA = `
            enum AssetType {
              /// A doc comment mentioning NOTAMEMBER, which must be ignored.
              TRACTOR
              HARVESTER
            }
        `;
        it('DETECTS a schema list missing an enum member', () => {
            const ts2 = `export const CreateAssetSchema = z.object({\n    type: z.enum(['TRACTOR']),\n});`;
            expect(schemaEnum(ts2, 'CreateAssetSchema', 'type'))
                .not.toEqual(prismaEnum(CRAFTED_PRISMA, 'AssetType'));
        });

        it('DETECTS a schema list with a value the enum does not have', () => {
            const ts2 = `export const CreateAssetSchema = z.object({\n    type: z.enum(['TRACTOR', 'HARVESTER', 'TRAKTOR']),\n});`;
            expect(schemaEnum(ts2, 'CreateAssetSchema', 'type'))
                .not.toEqual(prismaEnum(CRAFTED_PRISMA, 'AssetType'));
        });

        it('does NOT read a member out of a Prisma doc COMMENT', () => {
            // The false-alarm half: `NOTAMEMBER` sits in a `///` line, and a
            // naive line filter would return it as an enum member and then
            // demand it in the schema.
            const members = prismaEnum(CRAFTED_PRISMA, 'AssetType');
            expect(members).toEqual(['TRACTOR', 'HARVESTER']);
            expect(members).not.toContain('NOTAMEMBER');
        });

        it('does NOT read a LATER schema\'s field as this one\'s', () => {
            // Two schemas, same field name, different lists. Without the
            // next-export bound the first lookup would find whichever came
            // first in the file and grade the wrong object.
            const ts2 = [
                "export const CreateAssetSchema = z.object({",
                "    type: z.enum(['TRACTOR']),",
                "});",
                "",
                "export const UpdateAssetSchema = z.object({",
                "    type: z.enum(['HARVESTER']),",
                "});",
            ].join('\n');
            expect(schemaEnum(ts2, 'CreateAssetSchema', 'type')).toEqual(['TRACTOR']);
            expect(schemaEnum(ts2, 'UpdateAssetSchema', 'type')).toEqual(['HARVESTER']);
        });

        it('returns EMPTY for a schema or field that does not exist', () => {
            // Which the floors above convert into a failure rather than a pass.
            expect(schemaEnum(ts, 'NoSuchSchema', 'type')).toEqual([]);
            expect(schemaEnum(ts, 'CreateAssetSchema', 'noSuchField')).toEqual([]);
            expect(prismaEnum(prisma, 'NoSuchEnum')).toEqual([]);
        });
    });
});
