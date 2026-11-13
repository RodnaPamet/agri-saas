/**
 * «Вдъхновение» — the book library's two reads (#2980).
 *
 * Its own module, like `me-stream.paths.ts`: the library is not a farm
 * resource and a file named for tenants is where a global catalogue's spec
 * goes to be lost.
 *
 * ## What a client most needs from this spec
 *
 * Three properties, and none of them is a field:
 *
 *   1. **the paths carry NO tenant slug**, deliberately — a book belongs to no
 *      farm, so a client must not build these through a tenant-relative URL
 *      helper the way it does for every other read;
 *   2. **both reads are SIGNED-IN**, so a client needs its session even though
 *      the content is public-domain text;
 *   3. **both answer 404 while `library.enabled` is off**, which a client
 *      cannot tell from "no such book" — and should not try to.
 *
 * ## `version` is the field the offline copy turns on
 *
 * The one thing worth reading twice: it is an INTEGER and `updatedAt` sits
 * beside it. A client compares `version` to decide whether to re-download; a
 * timestamp invites a string comparison and a clock question. `updatedAt` is
 * for display only.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

const BookUseCaseSchema = z.enum(['STRATEGY', 'MANAGEMENT']).openapi({
    description:
        'What the book is FOR, as a CODE the client localises — never display text. An enum rather than a free-text list so the DATABASE refuses an unknown value and a seed cannot introduce one; a client renders an unknown code as a missing string, which is what keeps the two in step. PROVISIONAL: the vocabulary grows as books are added, and a client should tolerate a value it does not know \u2014 `MANAGEMENT` («\u0423\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435») joined on 2026-11-13 with the second book, which is the note being cashed rather than a change of design. Widening an enum is additive, so a client pinned to the older spec keeps working on every book it already knew.',
});

const BookSummarySchema = z
    .object({
        slug: z.string().openapi({
            description:
                'The stable handle every read is keyed on. UNIQUE, and what makes the seed idempotent by construction — so a renamed TITLE keeps the book’s identity and a phone’s offline copy stays addressable. The internal id is deliberately not published: nothing accepts it as input.',
        }),
        title: z.string().openapi({
            description:
                'The title in the language of the TEXT, NOT of the UI — there is deliberately no `titleBg`/`titleEn` pair. A book title names an ARTEFACT: «Изкуството на войната» is this project’s own Bulgarian translation from the public-domain classical Chinese, and rendering it as “The Art of War” would name a different artefact. Display it as given, whatever the interface language.',
        }),
        author: z.string().openapi({ description: 'The author, in the same language as `title`.' }),
        locale: z.string().openapi({
            description:
                'The language of the TEXT (`bg` for every book today). A free string rather than the UI’s two-language enum, because a library may hold a text in a language the interface does not speak.',
        }),
        summary: z.string().nullable().openapi({
            description: 'A short blurb in the book’s own language, or null.',
        }),
        version: z.number().int().openapi({
            description:
                'Monotonic INTEGER, bumped whenever the text changes. **This is the field an offline copy compares** — if it is unchanged, the stored text is current and needs no download. Never compare `updatedAt` for this: a timestamp invites a string comparison and a clock question.',
        }),
        updatedAt: z.string().datetime().openapi({
            description: 'ISO-8601, for DISPLAY. Not a cache key — see `version`.',
        }),
        useCases: z.array(BookUseCaseSchema),
    })
    .openapi('LibraryBookSummary', {
        description:
            'One book in the directory. Only PUBLISHED books ever appear: a book awaiting review is invisible to every caller, enforced in the query AND in the row-level policy beneath it.',
    });

const BookChapterSchema = z
    .object({
        number: z.number().int().openapi({ description: '1-based, and the chapter’s identity within the book.' }),
        title: z.string(),
        originalTitle: z.string().nullable().openapi({
            description:
                'The chapter’s title in the ORIGINAL language where there is one — e.g. 始計 beside «Планиране». Null for a book written in its own language. For display, never for matching.',
        }),
        paragraphs: z.array(z.string()).openapi({
            description:
                'The body, one entry per paragraph. Render paragraph by paragraph: splitting display text on a delimiter is a decision that silently changes with the text. Never empty — the database refuses a chapter with no paragraphs.',
        }),
    })
    .openapi('LibraryBookChapter');

const BookDetailSchema = BookSummarySchema.extend({
    sourceNote: z.string().openapi({
        description: 'Where the text came from. Displayed, because a public-domain claim a reader cannot check is not a claim.',
    }),
    licenseNote: z.string().openapi({ description: 'Under what licence the text is distributed.' }),
    chapters: z.array(BookChapterSchema).openapi({
        description:
            'The whole text, ordered by `number`. One payload rather than a chapter-per-request: a book is ~7,500 words that never changes between versions, and thirteen round trips on rural LTE to assemble it is the cost this avoids.',
    }),
}).openapi('LibraryBookDetail');

export function registerLibraryPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/library/books',
        operationId: 'listLibraryBooks',
        summary: '«Вдъхновение» — the book directory',
        description:
            'Every PUBLISHED book. Signed-in, and NOT tenant-scoped: a book belongs to no farm, so this path carries no slug and must not be built through a tenant-relative URL helper. '
            + '\n\n**It reaches every role, including MECHANISATOR.** The operator confinement engages only when a farm slug parses out of the path, so a non-tenant path is never asked about — which is the reason this surface lives outside the tenant tree rather than inside it. '
            + '\n\n**Behind the `library.enabled` flag, default OFF**, so this answers 404 until an operator turns it on. A client cannot distinguish that from "no such route" and should not try: the flag is this deployment’s only way to turn a new surface off without shipping an image. '
            + '\n\n**Carries a weak ETag.** Send `If-None-Match` on revalidation and expect 304 — the catalogue changes when a book is added, which is months apart, so almost every revalidation is a few dozen bytes. '
            + '\n\nUnpaginated by measurement rather than omission: the catalogue is curated by hand and holds single digits. There is a hard ceiling of 200 so the promise is bounded; reaching it is the signal to paginate, not to raise it.',
        tags: ['Library'],
        success: {
            status: 200,
            description: 'The published books, newest publication first.',
            schema: z.object({ books: z.array(BookSummarySchema) }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/library/books/{slug}',
        operationId: 'readLibraryBook',
        summary: 'One book, with its whole text',
        description:
            'The book and every chapter, ordered. Signed-in and non-tenant, like its sibling. '
            + '\n\n**A 404 means EITHER "no such book" OR "not published yet" OR "the flag is off"**, and the three are deliberately indistinguishable. A distinct code for the middle one would confirm that a book exists and is merely withheld — an oracle over exactly what an owner’s pre-publication review protects, and a slug is guessable from a title. '
            + '\n\n**Carries a weak ETag**, and this is the read it matters for: the body is a whole book, and it changes only when `version` is bumped. Send `If-None-Match` and keep the text you already hold. '
            + '\n\nThe slug travels in the PATH, which is safe here and is not the general rule: iOS logs the full URL unsuppressably, so a third party’s identifier belongs in a body (which is why `DELETE /api/social/blocks` takes one). A book slug identifies a published public-domain text and nobody’s person.'
            + '\n\n**404 code:** `BOOK_NOT_FOUND`. One code for all three causes, on purpose — see above.',
        tags: ['Library'],
        params: z.object({
            slug: z.string().openapi({
                description: 'The book’s stable handle, from the directory read.',
                example: 'sun-tzu-izkustvoto-na-voynata',
            }),
        }),
        success: {
            status: 200,
            description: 'The book and its chapters.',
            schema: BookDetailSchema,
        },
    });
}
