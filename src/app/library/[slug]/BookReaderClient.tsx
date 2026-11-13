'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiGet } from '@/lib/api-client';

/**
 * One book, read on a phone (#2980 PR 3).
 *
 * ## The key is the API path, so the TEXT is what gets persisted
 *
 * `PERSISTABLE_PATHS` carries `/api/library/books`, and its matcher is
 * `path === p || path.startsWith(p + '/')` — so that single entry covers this
 * read too. That is the decision, not an accident of prefix matching: #2980
 * asks for an offline copy, and the copy worth having is the chapters, not the
 * directory listing. Accepting it means accepting a published book's text on a
 * phone that may be lost or sold, which is the easy direction of that
 * allowlist — public-domain text every reader sees the same of, with no
 * personal data in it. `ParcelLease.lessorName` is the question the allowlist
 * exists to force, and this is not it.
 *
 * ## The response is the BOOK, not `{ book }`
 *
 * The directory wraps its array (`{ books }`) to leave room for a cursor; the
 * detail route returns the object directly. Two shapes, read from the routes
 * rather than assumed — a wrong guess here renders a book with no title and no
 * error, which is the failure mode this whole PR has been about.
 *
 * ## `originalTitle` is rendered only where it exists, and carries NO `lang`
 *
 * Present where the text is a translation — 始計 for Sun Tzu's first chapter.
 * It is the ORIGINAL, so it is neither translated nor transliterated.
 *
 * It deliberately has no `lang` attribute, and the first draft had
 * `lang="zh-Hant"`. That is right for Sun Tzu and WRONG for Franklin, whose
 * original is English — and the payload carries no original-language field to
 * derive it from. `locale` is the language of the TEXT, i.e. the translation,
 * so it answers a different question. A wrong `lang` is worse than none: a
 * screen reader would pronounce English with Chinese phonetics, whereas an
 * absent one falls back to the page language, which is wrong for at most the
 * handful of words in a chapter heading. Adding `originalLocale` to
 * `BookChapter` would fix it properly and is a schema change, so it is not
 * smuggled into a page PR — #3036.
 */
interface ChapterView {
    number: number;
    title: string;
    originalTitle: string | null;
    paragraphs: string[];
}

interface BookDetailView {
    slug: string;
    title: string;
    author: string;
    locale: string;
    summary: string | null;
    sourceNote: string;
    licenseNote: string;
    chapters: ChapterView[];
}

export function BookReaderClient({ slug }: { slug: string }) {
    const t = useTranslations('library');

    const { data, isLoading, error } = useSWR(`/api/library/books/${slug}`, (url: string) =>
        apiGet<BookDetailView>(url),
    );

    if (isLoading) {
        return (
            <div className="mx-auto w-full max-w-2xl space-y-default p-4 md:p-8" aria-busy="true">
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    // No cached copy AND the read failed — see the directory's note: a failed
    // revalidation with a cached book must keep showing the book, because
    // being offline is the expected state for this surface rather than an
    // exception.
    if (error && !data) {
        return (
            <div className="mx-auto w-full max-w-2xl p-4 md:p-8">
                <ErrorState title={t('notFound')} />
                <Link href="/library" className="text-xs underline">
                    {t('back')}
                </Link>
            </div>
        );
    }

    if (!data) return null;

    return (
        <article className="mx-auto w-full max-w-2xl space-y-section p-4 md:p-8">
            <nav>
                <Link href="/library" className="text-xs text-content-muted underline">
                    {t('back')}
                </Link>
            </nav>

            <header className="space-y-tight">
                <Heading level={1}>{data.title}</Heading>
                <p className="text-xs text-content-muted">{data.author}</p>
                {data.summary ? (
                    <p className="text-sm text-content-muted">{data.summary}</p>
                ) : null}
            </header>

            {data.chapters.map((chapter) => (
                <section key={chapter.number} className="space-y-default">
                    <Heading level={2}>
                        {chapter.number}. {chapter.title}
                        {chapter.originalTitle ? (
                            <span className="ml-tight text-xs font-normal text-content-muted">
                                {chapter.originalTitle}
                            </span>
                        ) : null}
                    </Heading>
                    {chapter.paragraphs.map((paragraph, i) => (
                        <p key={i} className="text-sm leading-relaxed text-content-default">
                            {paragraph}
                        </p>
                    ))}
                </section>
            ))}

            <footer className="space-y-tight border-t border-border-subtle pt-default text-xs text-content-muted">
                <p>
                    {t('source')}: {data.sourceNote}
                </p>
                <p>
                    {t('license')}: {data.licenseNote}
                </p>
            </footer>
        </article>
    );
}
