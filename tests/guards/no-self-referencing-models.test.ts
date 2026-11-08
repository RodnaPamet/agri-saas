/**
 * GUARDRAIL: no Prisma model carries a foreign key pointing at itself.
 *
 * Re-homed from `tests/unit/tenant-safety-selfref.test.ts` during GRC
 * teardown phase 2. That file was 90% tests for the export/import
 * (data-portability) closure, which was deleted with the GRC surface — but
 * this one test is a REPO-WIDE schema scan that has nothing to do with
 * export/import, and it would have died silently with the file around it.
 *
 * Why a self-referencing FK is worth catching at all: a parent-child edge
 * inside a single table means any bulk writer has to insert parents before
 * children, i.e. topologically sort its own rows. That is easy to get wrong
 * and invisible until a real dataset arrives with the children first. The
 * original guard pointed offenders at `SELF_REFERENCING_FIELDS` in
 * `tenant-safety.ts`; that file no longer exists, so the message now states
 * the requirement directly instead of naming a deleted registry.
 *
 * The previous `EXEMPT_SELF_REF` entry (`RiskHierarchyNode`) went with the
 * risk register, so the exemption set starts empty. Add an entry here only
 * with a written reason — a self-referencing model is a design decision, not
 * an accident, and the note is what tells the next reader which it was.
 */
import { readPrismaSchema } from '../helpers/prisma-schema';

/** Models with a deliberate self-referencing FK. Each needs a reason. */
const EXEMPT_SELF_REF = new Map<string, string>([
    [
        'DirectMessage',
        'A reply points at the message it answers — #2829. The guard\'s concern '
        + 'is a bulk writer having to topologically sort its own rows, and this '
        + 'edge cannot produce that: a reply is written one message at a time by '
        + '`sendDirectMessage`, whose target already exists because a person read '
        + 'it in order to reply to it. There is no importer for this table and no '
        + 'seed writes one. The edge is also NOT a hierarchy — it is one hop with '
        + 'no transitive walk anywhere in the code, so there is no depth to '
        + 'recurse and no cycle to detect: a message cannot reply to itself '
        + '(nothing can name an id that does not exist yet) and a chain is read '
        + 'one level deep for the quoted preview. `ON DELETE SET NULL` is what '
        + 'keeps a lost target from taking the reply with it.',
    ],
]);

describe('Prisma schema — no unregistered self-referencing models', () => {
    test('no model has a foreign key pointing to itself', () => {
        const schemaContent = readPrismaSchema();

        const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
        const selfRefModels: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = modelRegex.exec(schemaContent)) !== null) {
            const modelName = match[1];
            const body = match[2];

            // FK relations look like: fieldName ModelName @relation(fields: [scalar])
            // A self-ref is a field whose referenced model is its own model.
            const fieldRegex =
                /^\s+(\w+)\s+(\w+)\??\s+@relation.*fields:\s*\[(\w+)\]/gm;
            let fieldMatch: RegExpExecArray | null;

            while ((fieldMatch = fieldRegex.exec(body)) !== null) {
                const referencedModel = fieldMatch[2];
                if (referencedModel === modelName && !EXEMPT_SELF_REF.has(modelName)) {
                    selfRefModels.push(`${modelName}.${fieldMatch[3]} → ${modelName}`);
                }
            }
        }

        expect(selfRefModels).toEqual([]);
    });

    test('every exemption carries a written reason', () => {
        for (const [model, reason] of EXEMPT_SELF_REF) {
            expect(reason.length).toBeGreaterThan(20);
            expect(model.length).toBeGreaterThan(0);
        }
    });
});
