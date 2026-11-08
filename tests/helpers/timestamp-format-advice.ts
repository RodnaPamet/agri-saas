/**
 * The refusal text for `timestamps-declare-their-format` (#2557).
 *
 * A helper rather than part of the guard because the guard is a `.test.ts`:
 * importing it to unit-test one function would re-register its whole suite in
 * the importing file. `tests/helpers/prisma-schema-models.ts` is the precedent
 * for lifting a guard's reusable half out this way.
 */

export interface Found {
    /** `Schema.path/to/prop` — the dotted path a reader can grep for. */
    where: string;
    root: string;
    format: string | null;
    /**
     * The format found on an `anyOf`/`oneOf` BRANCH, when the property itself
     * has none (#2557).
     *
     * This is carried so the refusal can name the right cause. It is NOT a way
     * to satisfy the rule: a property whose format sits on a union branch still
     * counts as missing, deliberately, because a client reading the spec has to
     * descend the union to learn the encoding — which is the thing #1391 was
     * raised about. The field only changes the SENTENCE, never the verdict.
     */
    branchFormat: string | null;
}

/**
 * The `format` on a union BRANCH, if the property keeps none of its own.
 *
 * `z.union([z.string().datetime(), z.null()])` renders as
 * `{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}]}` — the
 * format is present and sits where a generator will not look. `oneOf` is read
 * too: nothing in this spec emits it today, but the shape is equally invisible
 * and a reader should not have to find out which keyword their generator
 * handles.
 */
export function branchFormatOf(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const rec = value as Record<string, unknown>;
    for (const key of ['anyOf', 'oneOf'] as const) {
        const branches = rec[key];
        if (!Array.isArray(branches)) continue;
        for (const b of branches) {
            if (typeof b !== 'object' || b === null) continue;
            const f = (b as { format?: unknown }).format;
            if (typeof f === 'string') return f;
        }
    }
    return null;
}

/**
 * The refusal text, SPLIT by cause (#2557).
 *
 * Exported and pure because of what it is for. #2543 declared an expiry as
 * `z.union([z.string().datetime(), z.null()])`; `.datetime()` was right there,
 * the property carried no `format`, and this guard correctly refused it while
 * printing "Add `.datetime()` to the Zod declaration" — advice the author had
 * already followed. The twenty minutes this guard's docblock says it buys back
 * were spent re-reading a declaration that was not the problem.
 *
 * The spelling was corrected by #2555, so the union group is EMPTY against
 * today's spec. That is exactly why this is a function with its own unit test
 * rather than a second branch inside `it()`: a sentence that only renders for a
 * shape nobody currently emits is unexecuted text, and the file has already
 * carried one thing that read as right and had never run.
 */
export function describeMissingFormats(missing: Found[], total: number): string {
    const name = (p: Found): string => `${p.root}.${p.where}`;
    const onBranch = missing.filter((p) => p.branchFormat !== null);
    const absent = missing.filter((p) => p.branchFormat === null);

    const parts = [
        `${missing.length} of ${total} response-side timestamps are typed without a ` +
            `\`format\`:\n`,
    ];

    if (absent.length) {
        parts.push(
            `NO format anywhere (${absent.length}):\n\n` +
                absent.map((p) => `    ${name(p)}`).join('\n') +
                `\n\nA client decoding one has to guess the encoding, and a generated ` +
                `client gets a bare \`string\` where it could have had a date (#1391).\n\n` +
                `Add \`.datetime()\` to the Zod declaration and run ` +
                `\`npm run openapi:generate\`. It is free: \`format\` is none of the six ` +
                `classes scripts/openapi-breaking.ts scores, and these schemas are ` +
                `registration-only — they are never \`.parse()\`d, so nothing starts ` +
                `validating.\n\n` +
                `If the field is genuinely day-resolution, \`format: date\` satisfies this ` +
                `rule — what a client cannot work with is the absence.`,
        );
    }

    if (onBranch.length) {
        parts.push(
            `FORMAT IS ON A UNION BRANCH (${onBranch.length}) — your \`.datetime()\` is ` +
                `already there, so do not go looking for a missing one:\n\n` +
                onBranch.map((p) => `    ${name(p)}  (branch carries \`${p.branchFormat}\`)`).join('\n') +
                `\n\n\`z.union([z.string().datetime(), z.null()])\` renders as ` +
                `\`anyOf\`, which puts \`format\` inside a branch where a generator will ` +
                `not look for it. Use the other nullable spelling:\n\n` +
                `    z.string().datetime().nullable()\n\n` +
                `It parses identically and renders ` +
                `\`{"type": ["string", "null"], "format": "date-time"}\` — which is what ` +
                `every other timestamp in this spec does.\n\n` +
                `This still counts as missing ON PURPOSE. A client reading \`anyOf\` has to ` +
                `descend the union to learn the encoding, which is materially worse than ` +
                `reading it off the property — and #1391 was raised by a client ` +
                `hand-writing models from this spec.`,
        );
    }

    return parts.join('\n');
}

