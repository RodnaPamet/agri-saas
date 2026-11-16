/**
 * #3022 — no object in a message catalogue may declare the same key twice.
 *
 * ## The defect lives BELOW the layer every other check reads
 *
 * `JSON.parse` keeps the LAST occurrence of a duplicated key. So a translator
 * or an agent who greps for `CHANNEL_SLOW_MODE`, edits the first hit, and runs
 * the i18n check sees it pass — and has changed nothing. The string they are
 * looking at is not the string that ships.
 *
 * Measured when this was filed: fifteen `CHANNEL_*` keys duplicated inside
 * `errors` in BOTH catalogues, all holding identical values, so no user ever
 * saw a wrong string. The hazard was entirely in the next edit. It was
 * fourteen when the issue was written and fifteen when it was fixed —
 * `CHANNEL_NOT_JOINED` joined in between, which is the recurrence this guard
 * exists to stop.
 *
 * ## Why no existing check could see it, and none of them is at fault
 *
 * Each is asking a question a duplicate key is invisible to:
 *
 *   · `i18n-completeness` and `scripts/i18n-diff.mjs --check` compare the two
 *     catalogues to EACH OTHER, both through `JSON.parse`. Duplicates collapse
 *     identically on both sides, so parity is genuinely clean — and that
 *     check's own `duplicated` counter is about repeated VALUES, not keys.
 *   · `error-codes-are-documented` asks whether a code the server can send is
 *     named in the spec. A code named twice is still named.
 *   · nothing else parses the raw TEXT.
 *
 * So this reads the text. It is the whole mechanism: a `JSON.parse` reviver
 * cannot help, because by the time a reviver runs the collapse has happened.
 *
 * ## Counted PER OBJECT, never per file
 *
 * A flat key list reports nonsense — `ACTIVE` legitimately appears in five
 * different enum namespaces, and the issue's first attempt reported 62
 * "duplicates" that way. The question is only ever whether ONE object declares
 * a key twice.
 */
import { readFileSync } from 'fs';

import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = process.cwd();

/**
 * Every duplicated key, with the object path it sits in.
 *
 * A hand-written scanner rather than a library, because the thing being looked
 * for is destroyed by every JSON parser in the ecosystem — that is the defect.
 * It tracks nesting depth and the current key path, and notices a repeat
 * within one object's own key set.
 *
 * Strings are skipped character by character, escapes included, so a `"` or a
 * `{` inside a translated sentence cannot shift the depth. Bulgarian copy
 * contains both.
 */
export function duplicateKeys(src: string): { path: string; key: string }[] {
    const found: { path: string; key: string }[] = [];
    const stack: { keys: Set<string>; name: string }[] = [];
    let i = 0;
    let pendingKey: string | null = null;

    while (i < src.length) {
        const c = src[i];

        if (c === '"') {
            // Read the string, honouring escapes.
            let j = i + 1;
            let text = '';
            while (j < src.length) {
                if (src[j] === '\\') {
                    text += src[j + 1] ?? '';
                    j += 2;
                    continue;
                }
                if (src[j] === '"') break;
                text += src[j];
                j += 1;
            }
            // A key is a string followed (past whitespace) by a colon.
            let k = j + 1;
            while (k < src.length && /\s/.test(src[k])) k += 1;
            if (src[k] === ':') {
                pendingKey = text;
                const top = stack[stack.length - 1];
                if (top) {
                    if (top.keys.has(text)) {
                        found.push({ path: top.name || '(root)', key: text });
                    } else {
                        top.keys.add(text);
                    }
                }
            }
            i = j + 1;
            continue;
        }

        if (c === '{') {
            const parent = stack[stack.length - 1];
            const name = pendingKey
                ? (parent?.name ? `${parent.name}.${pendingKey}` : pendingKey)
                : (parent?.name ?? '');
            stack.push({ keys: new Set(), name });
            pendingKey = null;
            i += 1;
            continue;
        }
        if (c === '}') {
            stack.pop();
            i += 1;
            continue;
        }
        if (c === ',') {
            pendingKey = null;
        }
        i += 1;
    }
    return found;
}

describe('message catalogues declare no key twice (#3022)', () => {
    const files = collectTrackedFiles({
        roots: ['messages'],
        extensions: ['.json'],
        floor: 4,
    });

    it('prints its denominator', () => {
        console.log(`[catalogue-dupes] ${files.length} catalogue file(s) scanned as TEXT`);
        expect(files.length).toBeGreaterThanOrEqual(4);
    });

    it.each(files.map((f) => [f.replace(`${ROOT}/`, ''), f]))(
        '%s has no duplicated key within any object',
        (_rel, abs) => {
            const dupes = duplicateKeys(readFileSync(abs as string, 'utf8'));
            expect(dupes.map((d) => `${d.path}.${d.key}`)).toEqual([]);
        },
    );

    describe('the detector, proved against crafted text', () => {
        it('FINDS a duplicate inside one object', () => {
            const d = duplicateKeys('{"errors":{"A":"1","B":"2","A":"3"}}');
            expect(d).toEqual([{ path: 'errors', key: 'A' }]);
        });

        it('does NOT fire on the same key in DIFFERENT objects', () => {
            // The whole reason it counts per object: `ACTIVE` legitimately
            // appears in five enum namespaces, and a flat key list reported 62
            // nonsense "duplicates".
            expect(duplicateKeys('{"a":{"ACTIVE":"1"},"b":{"ACTIVE":"2"}}')).toEqual([]);
        });

        it('is not fooled by a brace or a quote INSIDE a translated string', () => {
            // Bulgarian copy contains both, and a depth counter that did not
            // skip strings would mis-nest and then miss or invent duplicates.
            expect(duplicateKeys('{"o":{"A":"a { brace","B":"a \\" quote"}}')).toEqual([]);
            expect(duplicateKeys('{"o":{"A":"{","A":"2"}}')).toEqual([{ path: 'o', key: 'A' }]);
        });

        it('does not read a VALUE that looks like a key as a key', () => {
            // `{"A":"B","B":"A"}` has no duplicate; a scanner that treated
            // every string as a key would report one.
            expect(duplicateKeys('{"o":{"A":"B","B":"A"}}')).toEqual([]);
        });

        it('names the nested path, so a finding is actionable', () => {
            const d = duplicateKeys('{"x":{"y":{"K":"1","K":"2"}}}');
            expect(d).toEqual([{ path: 'x.y', key: 'K' }]);
        });

        it('AND a JSON.parse-based check cannot see any of it — the point', () => {
            // The control for the whole guard. If `JSON.parse` could tell, the
            // existing i18n checks would already have caught this.
            const src = '{"errors":{"A":"first","A":"second"}}';
            expect(duplicateKeys(src)).toHaveLength(1);
            expect(JSON.parse(src)).toEqual({ errors: { A: 'second' } });
            expect(Object.keys(JSON.parse(src).errors)).toHaveLength(1);
        });
    });
});
