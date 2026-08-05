/**
 * Every key a form modal sends must exist in the Zod schema that receives it.
 *
 * `UpdateEvidenceSchema` is `.strip()`. That is the right default — it stops
 * clients writing columns nobody validated — but it is also completely silent:
 * an unknown key is removed, the parse succeeds, the route returns 200, and
 * the UI reports the save worked.
 *
 * The evidence edit modal sent `description` (the column is `content`) and
 * `controlId` (which had no field at all). Both were dropped on every save,
 * for as long as the modal has existed. Nothing failed: the request was
 * well-formed, the response was 200, the toast said saved. Editing an evidence
 * description simply did nothing, and re-assigning it to another control did
 * nothing, and there was no signal anywhere that either had happened.
 *
 * A type checker cannot see this — the payload is a `JSON.stringify` of an
 * object literal on one side of an HTTP boundary and a `z.object` on the
 * other. Nothing connects the two but a string. So this guard connects them.
 *
 * Adding a modal here is one line in `CONTRACTS` plus the fields it sends.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

interface Contract {
    /** Human label for the failure message. */
    name: string;
    /** The client file containing the fetch payload. */
    modal: string;
    /** The exported Zod schema name that receives it. */
    schemaName: string;
    /** File the schema lives in. */
    schemaFile: string;
    /**
     * Keys the modal is expected to send. Listed explicitly rather than parsed
     * out of the source: an extractor that missed a key would make this guard
     * pass by finding nothing, which is the failure mode it exists to prevent.
     */
    sends: readonly string[];
}

const CONTRACTS: readonly Contract[] = [
    {
        name: 'evidence edit modal → UpdateEvidenceSchema',
        modal: 'src/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal.tsx',
        schemaName: 'UpdateEvidenceSchema',
        schemaFile: 'src/lib/schemas/index.ts',
        sends: ['title', 'content', 'ownerUserId', 'controlId', 'folder'],
    },
];

/** Field names declared at the top level of `export const <name> = z.object({ … })`. */
function schemaKeys(source: string, schemaName: string): Set<string> {
    const start = source.indexOf(`export const ${schemaName} = z.object({`);
    if (start === -1) throw new Error(`schema ${schemaName} not found`);

    // Walk braces from the object literal's opening brace to its match, so a
    // nested object cannot end the scan early.
    const open = source.indexOf('{', source.indexOf('z.object(', start));
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    const body = source.slice(open + 1, end);

    // Top-level keys only: strip nested literals before matching.
    let flattened = body;
    let previous: string;
    do {
        previous = flattened;
        flattened = flattened.replace(/\{[^{}]*\}/g, '');
    } while (flattened !== previous);

    return new Set([...flattened.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]));
}

describe('modal payload ↔ schema parity', () => {
    it.each(CONTRACTS)('$name', ({ modal, schemaName, schemaFile, sends }) => {
        const modalSource = readFileSync(join(ROOT, modal), 'utf8');
        const keys = schemaKeys(readFileSync(join(ROOT, schemaFile), 'utf8'), schemaName);

        expect(keys.size).toBeGreaterThan(0); // the parser found something

        for (const field of sends) {
            // The modal really sends it…
            expect(modalSource).toMatch(new RegExp(`\\b${field}\\s*:`));
            // …and the schema really accepts it. A miss here is a field that
            // `.strip()` deletes on every save, silently.
            expect(keys.has(field)).toBe(true);
        }
    });

    it('rejects a key the schema does not declare (mutation proof)', () => {
        // The exact shape of the bug: the modal sends `description`, the
        // schema declares `content`.
        const fakeSchema = `export const FakeSchema = z.object({
            title: z.string().optional(),
            content: z.string().optional(),
        }).strip();`;
        const keys = schemaKeys(fakeSchema, 'FakeSchema');
        expect(keys.has('content')).toBe(true);
        expect(keys.has('description')).toBe(false);
    });

    it('reads top-level keys only, not nested ones (parser self-check)', () => {
        const nested = `export const NestedSchema = z.object({
            outer: z.object({ inner: z.string() }),
            sibling: z.string(),
        }).strip();`;
        const keys = schemaKeys(nested, 'NestedSchema');
        expect(keys.has('outer')).toBe(true);
        expect(keys.has('sibling')).toBe(true);
        expect(keys.has('inner')).toBe(false);
    });
});
