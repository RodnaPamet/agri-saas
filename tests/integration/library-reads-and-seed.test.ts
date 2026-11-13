/**
 * «Вдъхновение» — the two reads and the seed, against a real database (#2980).
 *
 * ## The property this file exists for
 *
 * **A seeded book is invisible until somebody publishes it, and a re-seed
 * never changes that either way.**
 *
 * That is the owner's constraint — publishing waits for their review of the
 * text — and it is enforced in three places that have to agree: the seed never
 * writes `publishedAt`, the query filters on it, and `book_select` refuses an
 * unpublished row to every session. `library-books-rls` covers the policy;
 * this file covers the two layers above it and the seam between them.
 *
 * ## Why the reads are driven through the USECASE and not the route
 *
 * The routes are three lines each over `getUserCtx` + `assertFeatureEnabled` +
 * the usecase, and the flag gate has its own coverage
 * (`social-routes-flag-gated`, which now declares `src/app/api/library/` as a
 * root, plus the route unit test). What needs a database is the QUERY — the
 * `publishedAt` filter, the ordering, the chapter join — so that is what runs
 * here.
 *
 * ## Every absence is paired with a presence
 *
 * "The book is not in the directory" is also what a broken seed produces, and
 * "the detail read 404s" is also what a wrong slug produces. So each case that
 * asserts an absence asserts in the same breath that something IS there, or
 * that the row exists when read privileged.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listBooks, readBook } from '@/app-layer/usecases/library';
import {
    seedLibraryBook,
    publishLibraryBook,
    unpublishLibraryBook,
    readBookFile,
    type BookFile,
} from '../../scripts/library/seed-library';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SLUG = `test-book-${randomUUID()}`;
const READER = `u-2980-reader-${randomUUID()}`;

let tmp = '';

function ctx(): UserContext {
    return { requestId: `req-${randomUUID()}`, userId: READER, email: `${READER}@example.test` };
}

function bookFixture(overrides: Partial<BookFile> = {}): BookFile {
    return {
        slug: SLUG,
        title: 'Изкуството на войната',
        author: 'Сун Дзъ',
        locale: 'bg',
        summary: 'Кратко описание.',
        sourceNote: 'Публично достояние.',
        licenseNote: 'Собствен превод.',
        version: 1,
        useCases: ['STRATEGY'],
        chapters: [
            { number: 1, title: 'Планиране', originalTitle: '始計', paragraphs: ['Първи', 'Втори'] },
            { number: 2, title: 'Водене на война', paragraphs: ['Трети'] },
        ],
        ...overrides,
    } as BookFile;
}

/** Write a fixture to a temp file and return its path. */
function fileFor(book: BookFile | Record<string, unknown>): string {
    const p = path.join(tmp, `book-${randomUUID()}.json`);
    writeFileSync(p, JSON.stringify(book));
    return p;
}

/** The slugs this suite's reads can see, so an assertion never ranges over the whole table. */
async function visibleSlugs(): Promise<string[]> {
    const books = await listBooks(ctx());
    return books.map((b) => b.slug).filter((s) => s === SLUG);
}

describeFn('#2980 — the library reads, and a book nobody published', () => {
    beforeAll(async () => {
        await prisma.$connect();
        tmp = mkdtempSync(path.join(os.tmpdir(), 'library-seed-'));
    }, 120_000);

    afterAll(async () => {
        await prisma.bookChapter.deleteMany({ where: { book: { slug: SLUG } } });
        await prisma.book.deleteMany({ where: { slug: SLUG } });
        await prisma.$disconnect();
    });

    describe('the seed writes an UNPUBLISHED book', () => {
        it('creates it, reports it as not published, and no read returns it', async () => {
            const res = await seedLibraryBook(prisma, fileFor(bookFixture()));
            expect(res.created).toBe(true);
            expect(res.chapters).toBe(2);
            // The REPORT matters as much as the state: a book nobody can see
            // is the expected outcome here, and an operator needs the run to
            // say so rather than reading silence as a failed seed.
            expect(res.published).toBe(false);

            // The row exists, read privileged — so the two absences below are
            // a refusal and not a failed write.
            const stored = await prisma.book.findUnique({
                where: { slug: SLUG },
                select: { publishedAt: true, chapters: { select: { number: true } } },
            });
            expect(stored?.publishedAt).toBeNull();
            expect(stored?.chapters).toHaveLength(2);

            expect(await visibleSlugs()).toEqual([]);
            await expect(readBook(ctx(), SLUG)).rejects.toThrow(/BOOK_NOT_FOUND|not in the library/);
        }, 60_000);

        it('answers an unpublished slug EXACTLY as it answers a nonexistent one', async () => {
            // A comparison, not two separate refusals: the property is that a
            // reader cannot tell the two apart, and that is only checkable by
            // running both and requiring every observable to match. A distinct
            // code for the middle case would confirm that a book exists and is
            // merely withheld — an oracle over what the review protects, and a
            // slug is guessable from a title.
            const observe = async (slug: string) => {
                try {
                    await readBook(ctx(), slug);
                    return { threw: false, code: null, status: null };
                } catch (err) {
                    const e = err as { code?: string; status?: number; message?: string };
                    return { threw: true, code: e.code ?? null, status: e.status ?? null };
                }
            };
            const unpublished = await observe(SLUG);
            const nonexistent = await observe(`no-such-book-${randomUUID()}`);

            expect(unpublished.threw).toBe(true);
            expect(unpublished).toEqual(nonexistent);
            // The control: the shape being compared is a real refusal rather
            // than two identical nulls from a reader that never ran.
            expect(unpublished.code).toBe('BOOK_NOT_FOUND');
        }, 60_000);
    });

    describe('publishing is a separate act', () => {
        it('makes the book readable, with its chapters in order', async () => {
            const pub = await publishLibraryBook(prisma, SLUG);
            expect(pub.alreadyPublished).toBe(false);

            expect(await visibleSlugs()).toEqual([SLUG]);

            const book = await readBook(ctx(), SLUG);
            expect(book.title).toBe('Изкуството на войната');
            expect(book.version).toBe(1);
            expect(book.chapters.map((c) => c.number)).toEqual([1, 2]);
            expect(book.chapters[0].originalTitle).toBe('始計');
            // A book written in its own language has none, so the column is
            // nullable and the absence is rendered rather than guessed.
            expect(book.chapters[1].originalTitle).toBeNull();
            expect(book.chapters[0].paragraphs).toEqual(['Първи', 'Втори']);
            // `sourceNote` and `licenseNote` reach the DETAIL read only — a
            // public-domain claim a reader cannot check is not a claim.
            expect(book.sourceNote).toBe('Публично достояние.');
            expect(book.licenseNote).toBe('Собствен превод.');
        }, 60_000);

        it('does NOT re-stamp a book that is already published', async () => {
            // `publishedAt` is the date the text became public, which is the
            // only thing a licence question or a takedown would be dated from.
            // The `suspendedAt` precedent (P5.9), for the same reason.
            const before = await prisma.book.findUnique({
                where: { slug: SLUG }, select: { publishedAt: true },
            });
            const again = await publishLibraryBook(prisma, SLUG);
            expect(again.alreadyPublished).toBe(true);
            const after = await prisma.book.findUnique({
                where: { slug: SLUG }, select: { publishedAt: true },
            });
            expect(after?.publishedAt?.toISOString()).toBe(before?.publishedAt?.toISOString());
        }, 60_000);

        it('refuses to publish a slug that was never seeded', async () => {
            await expect(publishLibraryBook(prisma, `never-seeded-${randomUUID()}`))
                .rejects.toThrow(/no book with slug/);
        }, 60_000);
    });

    describe('a re-seed with a corrected text', () => {
        it('updates in place and leaves the publication ALONE', async () => {
            // THE case that makes the two-command split worth having. A seed
            // writing its create-shape every run would reset the operator's
            // decision on every deploy — the `channels` rule, where
            // `memberCount`, `slowModeSeconds` and `archivedAt` are left alone
            // for the same reason.
            const res = await seedLibraryBook(prisma, fileFor(bookFixture({
                title: 'Изкуството на войната (преработено)',
                version: 2,
                chapters: [
                    { number: 1, title: 'Планиране', paragraphs: ['Нов първи абзац'] },
                ],
            })));
            expect(res.created).toBe(false);
            expect(res.published).toBe(true);

            const book = await readBook(ctx(), SLUG);
            expect(book.title).toBe('Изкуството на войната (преработено)');
            expect(book.version).toBe(2);
            // Chapters REPLACED wholesale: the second chapter is gone rather
            // than orphaned. Per-chapter upserts would have left it behind,
            // and `@@unique([bookId, number])` would have turned a merge of
            // two chapters into a constraint error.
            expect(book.chapters.map((c) => c.number)).toEqual([1]);
            expect(book.chapters[0].paragraphs).toEqual(['Нов първи абзац']);
            const orphans = await prisma.bookChapter.count({
                where: { book: { slug: SLUG } },
            });
            expect(orphans).toBe(1);
        }, 60_000);

        it('and unpublishing takes it back out without destroying it', async () => {
            const res = await unpublishLibraryBook(prisma, SLUG);
            expect(res.wasPublished).toBe(true);

            expect(await visibleSlugs()).toEqual([]);
            // Still there, read privileged — withdrawn, not deleted.
            const stored = await prisma.book.findUnique({
                where: { slug: SLUG },
                select: { version: true, publishedAt: true },
            });
            expect(stored?.version).toBe(2);
            expect(stored?.publishedAt).toBeNull();
        }, 60_000);
    });

    describe('the file schema refuses what the operator can act on', () => {
        it('names the chapter with no paragraphs, rather than raising 23514', () => {
            // The database already refuses this
            // (`BookChapter_paragraphs_nonempty`), and a raw 23514 names a
            // constraint rather than a cause. Both layers stay: a future
            // writer that is not this script would otherwise have no floor.
            const p = fileFor({
                ...bookFixture(),
                chapters: [{ number: 1, title: 'Пуста', paragraphs: [] }],
            });
            expect(() => readBookFile(p)).toThrow(/chapters/);
        });

        it('refuses a DUPLICATE chapter number by naming it', () => {
            const p = fileFor({
                ...bookFixture(),
                chapters: [
                    { number: 1, title: 'Едно', paragraphs: ['a'] },
                    { number: 1, title: 'Пак едно', paragraphs: ['b'] },
                ],
            });
            expect(() => readBookFile(p)).toThrow(/chapter number 1 appears twice/);
        });

        it('REFUSES a file that tries to publish itself', () => {
            // `.strict()`, not `.strip()`. A file able to set `publishedAt`
            // would make the review step a thing somebody can forget, and a
            // silent drop would hide the operator's mistake from the operator
            // — the opposite choice from `FileReportSchema`, where the caller
            // is untrusted and must not learn the field exists.
            const p = fileFor({ ...bookFixture(), publishedAt: new Date().toISOString() });
            expect(() => readBookFile(p)).toThrow(/publishedAt/);
        });

        it('refuses an unknown useCase code', () => {
            const p = fileFor({ ...bookFixture(), useCases: ['TACTICS'] });
            expect(() => readBookFile(p)).toThrow(/useCases/);
        });

        it('accepts the valid fixture — the positive control', () => {
            expect(readBookFile(fileFor(bookFixture())).slug).toBe(SLUG);
        });
    });
});
