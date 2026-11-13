/**
 * Both library reads filter on `publishedAt` IN THE QUERY — #2980.
 *
 * ## Why this is a source guard and not a behavioural one
 *
 * It is the half that behaviour cannot see, and that was MEASURED rather than
 * assumed. `publishedAt` is enforced twice: in the `where` clause and in
 * `book_select`'s USING clause. Removing the `where` clause from both reads
 * left all twelve cases of `library-reads-and-seed` GREEN, because the policy
 * caught it; only the COMBINED mutation — the clause AND the policy arm — went
 * red.
 *
 * That is the signature of defence in depth working, not of a weak test: each
 * layer alone is sufficient, so a single-site mutation correctly survives. The
 * consequence is that neither layer is independently proven by behaviour, and
 * what proves each is the other's absence. The `take: limit + 1` precedent
 * applies — a property a response cannot show is asserted on the SOURCE.
 *
 * ## What the `where` clause is FOR, given the policy already refuses
 *
 * Two things the policy cannot do. It makes the reason visible at the call
 * site, where somebody writing the next read will see it. And it survives a
 * legitimate widening of the policy: if a private-channel-style visibility
 * column ever joins `Book`, `book_select` will be rewritten, and a read whose
 * only gate was that policy becomes a leak in the same diff.
 *
 * ## The population is DERIVED from the query calls, not a count of two
 *
 * A third read added to this file is covered the moment it exists. The floor
 * is what stops an extraction that stops matching from passing over nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const USECASE = 'src/app-layer/usecases/library.ts';

/**
 * Every Prisma query call on `tx.book` in a source, with its argument span.
 *
 * Paren-matched rather than regex-bounded: the argument object contains its own
 * braces and parens, and a non-greedy match would end at the first of them —
 * which would report a filtered read as unfiltered.
 */
export function bookQuerySpans(source: string): string[] {
    const code = blankNonCode(source);
    const spans: string[] = [];
    const NEEDLE = /tx\.book\.(findMany|findFirst|findUnique)\(/g;
    for (const m of code.matchAll(NEEDLE)) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < code.length; i += 1) {
            if (code[i] === '(') depth += 1;
            else if (code[i] === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        spans.push(code.slice(m.index, i + 1));
    }
    return spans;
}

/** Does this query span reference the shared published filter? */
export function filtersPublished(span: string): boolean {
    // The CONSTANT, or the literal it expands to. Accepting both means a
    // future read that inlines the condition is not reported as a defect
    // while one that forgets it entirely still is.
    return span.includes('PUBLISHED') || /publishedAt\s*:\s*\{\s*not\s*:\s*null\s*\}/.test(span);
}

describe('library reads filter on publishedAt in the query', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, USECASE), 'utf8');
    const spans = bookQuerySpans(source);

    it('reports the population it examined', () => {
        // A floor, because an extraction that stopped matching would pass over
        // nothing — and `expect([]).toEqual([])` is the shape this guard would
        // then have.
        console.log(`[library-published-filter] book_queries=${spans.length}`);
        expect(spans.length).toBeGreaterThanOrEqual(2);
    });

    it('the shared filter is still `publishedAt: { not: null }`', () => {
        // Asserted separately, because every span below is accepted on the
        // strength of naming `PUBLISHED`-the-constant. A constant that had
        // been changed to `{}` would satisfy all of them.
        const code = blankNonCode(source);
        expect(code).toMatch(/const PUBLISHED = \{\s*publishedAt:\s*\{\s*not:\s*null\s*\}\s*\}/);
    });

    it('every book query filters on it', () => {
        const unfiltered = spans.filter((s) => !filtersPublished(s));
        expect(unfiltered).toEqual([]);
    });

    describe('the detector', () => {
        it('accepts a filtered read — the positive control', () => {
            const good = `
                const rows = await tx.book.findMany({ where: PUBLISHED, select: { slug: true } });
            `;
            expect(bookQuerySpans(good)).toHaveLength(1);
            expect(filtersPublished(bookQuerySpans(good)[0])).toBe(true);
        });

        it('accepts the inlined literal too', () => {
            const good = `
                await tx.book.findFirst({ where: { slug, publishedAt: { not: null } } });
            `;
            expect(filtersPublished(bookQuerySpans(good)[0])).toBe(true);
        });

        it('REJECTS a read with no filter', () => {
            const bad = `
                const rows = await tx.book.findMany({ select: { slug: true } });
            `;
            expect(filtersPublished(bookQuerySpans(bad)[0])).toBe(false);
        });

        it('is not fooled by the filter appearing in prose', () => {
            const prose = `
                // where: PUBLISHED — intentionally omitted
                await tx.book.findMany({ select: { slug: true } });
            `;
            expect(filtersPublished(bookQuerySpans(prose)[0])).toBe(false);
        });

        it('does not stop the span at a nested paren', () => {
            // The paren-matching half. A non-greedy match would cut the span
            // at `toISOString()` and miss the filter that follows it.
            const nested = `
                await tx.book.findMany({
                    orderBy: [{ publishedAt: 'desc' }],
                    take: Number(String(2).trim()),
                    where: PUBLISHED,
                });
            `;
            const [span] = bookQuerySpans(nested);
            expect(filtersPublished(span)).toBe(true);
        });
    });
});
