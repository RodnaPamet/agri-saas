/**
 * «Вдъхновение» — seed one book from a FILE the operator supplies (#2980).
 *
 * ## The text is NOT in this repository, and that is the whole shape
 *
 * This repository is PUBLIC, so a commit IS publication. The owner's
 * constraint is that publishing waits for their review of the text, and a
 * committed seed fixture would pre-empt that review on merge — `publishedAt`
 * NULL in the database says nothing about a 7,500-word translation sitting in
 * a public git history.
 *
 * So the text travels as a JSON file on the operator's own machine and is read
 * at seed time:
 *
 *   docker compose exec -T app node dist/seed.mjs library --file /tmp/book.json
 *
 * Nothing about the text enters either repo. That also means this subcommand
 * is deliberately ABSENT from `all` — see `scripts/seed.ts`.
 *
 * ## WRITING and PUBLISHING are two commands, because they are two acts
 *
 * `seedLibraryBook` always writes `publishedAt: NULL` on insert and NEVER
 * touches it on update. Publishing is `publishLibraryBook`, a separate
 * explicit call. Three reasons, and the third is the one that matters:
 *
 *   1. it is the `channels` rule — a seed that wrote the create-shape every
 *      run would reset an operator's decision on every deploy;
 *   2. re-seeding a CORRECTED text must not silently unpublish a live book,
 *      nor publish one that was deliberately withheld;
 *   3. the review happens on the FILE, not through the app. `book_select`
 *      refuses an unpublished row to every session, so there is no way to read
 *      one back through the API — by design. The owner reads the JSON they are
 *      about to upload; this command then makes the decision they took.
 *
 * ## Chapters are REPLACED wholesale, inside the transaction
 *
 * Per-chapter upserts would leave an orphan behind whenever a revision merges
 * two chapters or renumbers them, and `@@unique([bookId, number])` makes that
 * failure a confusing constraint error rather than a clean result. Deleting
 * and recreating costs nothing — a chapter row holds only derived text, the
 * file is the source — and makes a re-seed exactly equal to a fresh one.
 *
 * ## Validation is in ZOD, so the operator gets a sentence
 *
 * The database already refuses a chapter with no paragraphs
 * (`BookChapter_paragraphs_nonempty`), but a raw 23514 names a constraint and
 * not a cause. The schema below refuses the same thing by saying which chapter
 * is empty — and the CHECK stays, because a future writer that is not this
 * script would otherwise have no floor at all.
 */
import { readFileSync } from 'node:fs';

import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

/**
 * The file's shape.
 *
 * `publishedAt` is deliberately NOT accepted. A file that could publish itself
 * would make the review step a thing somebody can forget, and `.strict()`
 * refuses it loudly rather than ignoring it — the opposite choice from
 * `FileReportSchema.strip()`, which drops an unexpected `reporterUserId`
 * silently so a caller cannot learn the field exists. Here the operator IS the
 * trusted party and a silent drop would hide their mistake from them.
 */
const ChapterSchema = z
    .object({
        number: z.number().int().positive(),
        title: z.string().min(1),
        originalTitle: z.string().min(1).optional(),
        paragraphs: z.array(z.string().min(1)).min(1),
    })
    .strict();

export const BookFileSchema = z
    .object({
        slug: z
            .string()
            .min(1)
            .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lower-case words joined by hyphens'),
        title: z.string().min(1),
        author: z.string().min(1),
        /**
         * The language of the TEXT. A string and not the UI `Locale` enum: a
         * library may hold a text in a language the interface does not speak,
         * and reusing that enum would make such a book unrepresentable.
         */
        locale: z.string().min(2).max(16),
        summary: z.string().min(1).optional(),
        sourceNote: z.string().min(1),
        licenseNote: z.string().min(1),
        version: z.number().int().positive(),
        // Kept in step with `BookUseCase` BY HAND, and the duplication is
        // deliberate: this validates a FILE the operator supplies, so it must
        // refuse an unknown code with a sentence rather than letting Postgres
        // answer `22P02 invalid input value for enum`. `.strict()` above means
        // the refusal happens before the database is consulted at all.
        //
        // The cost is that adding a member to the enum and not here produces a
        // zod refusal naming `useCases`, which reads as a bad staged file
        // rather than a missing code — measured on #2980's second book, where
        // a peer would have hit exactly that.
        useCases: z.array(z.enum(['STRATEGY', 'MANAGEMENT', 'FARMING'])).min(1),
        chapters: z.array(ChapterSchema).min(1),
    })
    .strict()
    .superRefine((book, ctx) => {
        // Checked here rather than left to `@@unique([bookId, number])`,
        // because the constraint fires mid-transaction and names a column
        // while this names the DUPLICATE.
        const seen = new Set<number>();
        for (const c of book.chapters) {
            if (seen.has(c.number)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `chapter number ${c.number} appears twice`,
                    path: ['chapters'],
                });
            }
            seen.add(c.number);
        }
    });

export type BookFile = z.infer<typeof BookFileSchema>;

export interface SeedLibraryResult {
    slug: string;
    created: boolean;
    chapters: number;
    /** Whether the row is live. Reported so a run says what a reader would see. */
    published: boolean;
    version: number;
}

/** Parse and validate a book file, with the path in any error. */
export function readBookFile(path: string): BookFile {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(
            `${path}: not readable as JSON — ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const parsed = BookFileSchema.safeParse(raw);
    if (!parsed.success) {
        const lines = parsed.error.issues.map(
            (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
        );
        throw new Error(`${path}: not a valid book file\n${lines.join('\n')}`);
    }
    return parsed.data;
}

/**
 * Write (or update) one book and its chapters. NEVER publishes.
 *
 * Idempotent by the UNIQUE index on `slug` — the `Channel.key` precedent, so a
 * re-run with a corrected text updates in place and a renamed TITLE keeps the
 * book's identity and its readers' offline copies addressable.
 */
export async function seedLibraryBook(
    prisma: PrismaClient,
    path: string,
): Promise<SeedLibraryResult> {
    const book = readBookFile(path);

    return prisma.$transaction(async (tx) => {
        const existing = await tx.book.findUnique({
            where: { slug: book.slug },
            select: { id: true, publishedAt: true },
        });

        const content = {
            title: book.title,
            author: book.author,
            locale: book.locale,
            summary: book.summary ?? null,
            sourceNote: book.sourceNote,
            licenseNote: book.licenseNote,
            version: book.version,
            useCases: book.useCases,
        };

        // `publishedAt` appears in NEITHER branch. On insert the column's own
        // default (NULL) applies; on update it is left exactly as the operator
        // set it. Spelling it on either side is how a deploy would silently
        // undo a publishing decision.
        const row = existing
            ? await tx.book.update({
                  where: { id: existing.id },
                  data: content,
                  select: { id: true, publishedAt: true },
              })
            : await tx.book.create({
                  data: { slug: book.slug, ...content },
                  select: { id: true, publishedAt: true },
              });

        // Replaced wholesale — see the file docblock.
        await tx.bookChapter.deleteMany({ where: { bookId: row.id } });
        await tx.bookChapter.createMany({
            data: book.chapters.map((c) => ({
                bookId: row.id,
                number: c.number,
                title: c.title,
                originalTitle: c.originalTitle ?? null,
                paragraphs: c.paragraphs,
            })),
        });

        return {
            slug: book.slug,
            created: existing === null,
            chapters: book.chapters.length,
            published: row.publishedAt !== null,
            version: book.version,
        };
    });
}

export interface PublishLibraryResult {
    slug: string;
    publishedAt: Date;
    /** True when the row was ALREADY live, so a repeat run says so. */
    alreadyPublished: boolean;
}

/**
 * Make one book readable — the owner's decision, performed explicitly.
 *
 * Does NOT re-stamp an already-published book: `publishedAt` is the date the
 * text became public, which is the only thing a licence question or a takedown
 * would be dated from. The `suspendedAt` precedent (P5.9), for the same
 * reason.
 */
export async function publishLibraryBook(
    prisma: PrismaClient,
    slug: string,
): Promise<PublishLibraryResult> {
    const existing = await prisma.book.findUnique({
        where: { slug },
        select: { publishedAt: true },
    });
    if (!existing) {
        throw new Error(`no book with slug '${slug}' — seed it first with --file`);
    }
    if (existing.publishedAt) {
        return { slug, publishedAt: existing.publishedAt, alreadyPublished: true };
    }
    const row = await prisma.book.update({
        where: { slug },
        data: { publishedAt: new Date() },
        select: { publishedAt: true },
    });
    // Non-null by construction: the update just set it.
    return { slug, publishedAt: row.publishedAt as Date, alreadyPublished: false };
}

/** Take a book back out of the library without destroying it. */
export async function unpublishLibraryBook(
    prisma: PrismaClient,
    slug: string,
): Promise<{ slug: string; wasPublished: boolean }> {
    const existing = await prisma.book.findUnique({
        where: { slug },
        select: { publishedAt: true },
    });
    if (!existing) {
        throw new Error(`no book with slug '${slug}'`);
    }
    if (!existing.publishedAt) return { slug, wasPublished: false };
    await prisma.book.update({ where: { slug }, data: { publishedAt: null } });
    return { slug, wasPublished: true };
}
