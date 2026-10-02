/**
 * `DELIBERATELY_PLAINTEXT` cannot become a place to park a field.
 *
 * The map exists because #1222 was a DEFAULT nobody chose: 18 (model, field)
 * pairs encrypted by field-name collision rather than by decision. Narrowing
 * the `'*'` fan-out fixes that — and would replace it with the mirror-image
 * accident, those same fields plaintext by default, if nothing recorded the
 * choice. So each entry is a claim, and this file checks the claims are the
 * kind that can be wrong.
 *
 * Deliberately the sibling of `global-kek-models-covers-tenantless`: both say
 * "deliberately not the default for this shape", and an exemption map without
 * a stale-entry test is somewhere a renamed or deleted field hides forever.
 */
import * as fs from 'node:fs';

import {
    ALL_ENCRYPTED_FIELD_NAMES,
    DELIBERATELY_PLAINTEXT,
    ENCRYPTED_FIELDS,
} from '@/lib/security/encrypted-fields';

import { collectSourceFiles } from '../helpers/collect-files';

/**
 * Every `model.field` the Prisma schema declares.
 *
 * Via `collectSourceFiles` rather than a `readdirSync`, because a hand-rolled
 * walk that silently resolves to nothing turns the stale-entry test below into
 * a pass — and `file-collection-is-not-silently-empty` caught exactly that in
 * the first version of this file. The floor is measured (22 .prisma files
 * today), not remembered.
 */
function schemaFields(): Set<string> {
    const src = collectSourceFiles({
        roots: ['prisma/schema'],
        extensions: ['.prisma'],
        floor: 15,
    })
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');
    const out = new Set<string>();
    for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        for (const f of m[2].matchAll(/^\s{2,}(\w+)\s+\S+/gm)) out.add(`${m[1]}.${f[1]}`);
    }
    return out;
}

const FIELDS = schemaFields();
const ENTRIES = Object.entries(DELIBERATELY_PLAINTEXT);

describe('DELIBERATELY_PLAINTEXT', () => {
    it('control: the schema parsed and the map is non-empty', () => {
        // Both halves matter: an empty schema set would make the stale-entry
        // test below fail everything, and an empty map would make every other
        // assertion here vacuous.
        expect(FIELDS.size).toBeGreaterThan(500);
        expect(ENTRIES.length).toBeGreaterThan(0);
    });

    it('every key is Model.field, not a bare model', () => {
        // Per-FIELD, unlike `DELIBERATELY_TENANT_DEK`, which is model-keyed
        // because a model's DEK serves all its fields. Plaintext-vs-encrypted
        // is decided per column: a non-manifest model could carry two
        // manifest-named fields and want different answers, and a model-keyed
        // map would exempt the second one silently.
        for (const [key] of ENTRIES) {
            expect(key).toMatch(/^[A-Z]\w*\.[a-z]\w*$/);
        }
    });

    it('every entry names a field the schema still has — no stale entries', () => {
        const stale = ENTRIES.map(([k]) => k).filter((k) => !FIELDS.has(k));
        expect(stale).toEqual([]);
    });

    it('every entry is actually AT RISK — its field name is in the manifest set', () => {
        // The load-bearing one. An entry for a field no manifest model declares
        // is not an exemption, it is noise: the fan-out could never have
        // touched it, so the map would be documenting a danger that does not
        // exist and quietly growing.
        const notAtRisk = ENTRIES.map(([k]) => k).filter(
            (k) => !ALL_ENCRYPTED_FIELD_NAMES.has(k.split('.')[1]),
        );
        expect(notAtRisk).toEqual([]);
    });

    it('no entry contradicts ENCRYPTED_FIELDS', () => {
        // A field cannot be both declared-encrypted and deliberately-plaintext.
        // Without this, the two maps could disagree and the middleware would
        // silently pick one — which is the shape of the original bug.
        const contradictions = ENTRIES.map(([k]) => k).filter((k) => {
            const [model, field] = k.split('.');
            return (ENCRYPTED_FIELDS as Record<string, readonly string[] | undefined>)[model]?.includes(field) ?? false;
        });
        expect(contradictions).toEqual([]);
    });

    it('every entry carries a reason that says something', () => {
        for (const [key, reason] of ENTRIES) {
            // Long enough to be an argument rather than a label. The existing
            // exemption maps in this repo use the same floor.
            expect(reason.trim().length).toBeGreaterThan(40);
            expect(reason).not.toBe(key);
        }
    });
});
