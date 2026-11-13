/**
 * «Вдъхновение» — the book library's two reads (#2980).
 *
 * ## PERSON-SCOPED, which decides the session context
 *
 * `Book` and `BookChapter` are tenantless GLOBAL CATALOGUE rows, like `Unit`
 * and `AgriEvent` — every farm reads the same copy. Their SELECT arm admits
 * EITHER session variable, because a book belongs to nobody and the only
 * question is whether the caller is authenticated: `runInUserContext` sets
 * `app.user_id`, `runInTenantContext` sets `app.actor_user_id`, and both answer
 * it. That is #1664 removed rather than documented — picking one variable is
 * what made `UserBlock`'s policy select from an empty view and return `false`
 * for every pair, with nothing erroring.
 *
 * The routes are non-tenant (`/api/library/...`, owner ruling 2026-11-13), so
 * these run through `runInUserContext`.
 *
 * ## `publishedAt` IS FILTERED HERE *AND* IN THE POLICY
 *
 * Both, and the duplication is the design. #2980 §3(d) names the failure mode
 * exactly: the flag "works in the seed and leaks through a read nobody
 * filtered". The owner's constraint is that publishing waits for their review
 * of the text, so production holds unpublished rows for as long as that takes.
 *
 * A `where` clause is one line somebody deletes while refactoring a list
 * query, so `book_select` carries the condition too and an `app_user` query
 * cannot see an unpublished book however this file is rewritten. The clause
 * here is what makes the REASON visible at the call site; the policy is what
 * survives the call site changing. Removing either leaves the other — which is
 * precisely why neither is redundant.
 *
 * ## NOT a privileged read, which is the tempting shortcut
 *
 * `prisma.book.findMany({ where: { publishedAt: { not: null } } })` on the
 * global client would work and would leave the `where` clause as the ONLY
 * gate — the arrangement P5.6a's export has to live with and warns about
 * ("a dropped clause exports the database"). Here a user context is available
 * and costs one transaction, so there is no reason to give up the second
 * layer.
 */
import { runInUserContext } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';
import type { UserContext } from '@/app-layer/types';
import type { BookUseCase } from '@prisma/client';

/** What the directory read returns per book. */
export interface BookSummary {
    slug: string;
    title: string;
    author: string;
    /** The language of the TEXT, not of the UI — see the schema docblock. */
    locale: string;
    summary: string | null;
    /**
     * Monotonic integer. The phone compares it to decide whether to
     * re-download; `updatedAt` is for display. Two fields because they answer
     * different questions and neither substitutes (#2980 §3(a)).
     */
    version: number;
    updatedAt: string;
    useCases: BookUseCase[];
}

export interface BookChapterView {
    number: number;
    title: string;
    /** Present only where the text is a translation — e.g. 始計. */
    originalTitle: string | null;
    paragraphs: string[];
}

export interface BookDetail extends BookSummary {
    sourceNote: string;
    licenseNote: string;
    chapters: BookChapterView[];
}

/**
 * The SELECT shape, spelled ONCE.
 *
 * Not a convenience: a second spelling is how the detail read comes to serve a
 * column the directory withholds, which is the #1664 class — two spellings of
 * one rule make the divergence a disclosure rather than a wrong sentence. The
 * same argument `toPostView` carries for channel posts.
 *
 * `id` is deliberately absent. `slug` is the handle every read is keyed on and
 * the only identifier a client needs, so the cuid is not published — nothing
 * accepts it as input, and a second identifier is a second thing to keep in
 * step.
 */
const SUMMARY_SELECT = {
    slug: true,
    title: true,
    author: true,
    locale: true,
    summary: true,
    version: true,
    updatedAt: true,
    useCases: true,
} as const;

/** `publishedAt IS NOT NULL`, spelled once — see the file docblock. */
const PUBLISHED = { publishedAt: { not: null } } as const;

function toSummary(row: {
    slug: string;
    title: string;
    author: string;
    locale: string;
    summary: string | null;
    version: number;
    updatedAt: Date;
    useCases: BookUseCase[];
}): BookSummary {
    return {
        slug: row.slug,
        title: row.title,
        author: row.author,
        locale: row.locale,
        summary: row.summary,
        version: row.version,
        // ISO, because the wire carries JSON and a `Date` serialises to one
        // anyway — spelled so the TYPE says what a client receives.
        updatedAt: row.updatedAt.toISOString(),
        useCases: row.useCases,
    };
}

/**
 * The directory — every PUBLISHED book.
 *
 * Unpaginated, and that is a measurement rather than an omission: the owner has
 * named one book, the catalogue is curated by hand, and a cursor over a list
 * that will hold single digits for years is machinery with nothing to do. The
 * `take` ceiling is there so the promise is bounded rather than trusting the
 * curation — and if it is ever reached, that is the signal to paginate rather
 * than to raise it.
 */
export const LIBRARY_MAX_BOOKS = 200;

export async function listBooks(ctx: UserContext): Promise<BookSummary[]> {
    return runInUserContext(ctx, async (tx) => {
        const rows = await tx.book.findMany({
            where: PUBLISHED,
            // Newest publication first: a new book is the reason to open the
            // screen. `slug` breaks a tie so the order is total — two books
            // published in the same transaction would otherwise come back in
            // whatever order the plan produced.
            orderBy: [{ publishedAt: 'desc' }, { slug: 'asc' }],
            take: LIBRARY_MAX_BOOKS,
            select: SUMMARY_SELECT,
        });
        return rows.map(toSummary);
    });
}

/**
 * One book with its whole text.
 *
 * ## The chapters come back with the book, not on a second read
 *
 * A book is ~7,500 words across 13 chapters — one payload the phone stores
 * offline and revalidates with an ETag, which is what #2980 §3(b) asks for. A
 * per-chapter read would make thirteen round trips on rural LTE to assemble
 * something that never changes between versions.
 *
 * ## An UNPUBLISHED slug answers the same 404 as a nonexistent one
 *
 * Deliberately indistinguishable. A distinct code would confirm that a book
 * exists and is merely withheld, which is an oracle over exactly the thing the
 * owner's review is protecting — and the slug of an unpublished book is
 * guessable from its title.
 */
export async function readBook(ctx: UserContext, slug: string): Promise<BookDetail> {
    const book = await runInUserContext(ctx, async (tx) => {
        return tx.book.findFirst({
            // `findFirst` with a compound `where`, never `findUnique({ where:
            // { slug } })` plus a check afterwards: the filter belongs in the
            // query so an unpublished row is never selected at all. Fetching
            // it and discarding it would put the text one `console.log` away
            // from a reader.
            where: { slug, ...PUBLISHED },
            select: {
                ...SUMMARY_SELECT,
                sourceNote: true,
                licenseNote: true,
                chapters: {
                    orderBy: { number: 'asc' },
                    select: {
                        number: true,
                        title: true,
                        originalTitle: true,
                        paragraphs: true,
                    },
                },
            },
        });
    });

    if (!book) {
        throw codedNotFound('BOOK_NOT_FOUND', 'That book is not in the library.');
    }

    return {
        ...toSummary(book),
        sourceNote: book.sourceNote,
        licenseNote: book.licenseNote,
        chapters: book.chapters,
    };
}
