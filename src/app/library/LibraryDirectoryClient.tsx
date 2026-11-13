'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiGet } from '@/lib/api-client';

/**
 * «Вдъхновение» — the directory (#2980 PR 3).
 *
 * ## The SWR key is the literal API path, and that is what persists it
 *
 * `/api/library/books` is the exact string in `PERSISTABLE_PATHS`.
 * `tenantRelativePath` strips only the `/api/t/<slug>/` prefix and hands a
 * non-tenant key back unchanged, so this key matches the allowlist entry
 * verbatim. Building it through a helper, or adding a query parameter that the
 * allowlist's query-stripped comparison would not mind but a reader would,
 * both still work — but the key is what the cache is keyed on, so keep it a
 * literal where the allowlist can be grepped against it.
 *
 * `useTenantSWR` is NOT used, and must not be: it builds
 * `/api/t/<slug>/<path>`, and there is no slug. A tenant-scoped read of a
 * tenantless table is the #1664 shape — zero rows, no error.
 *
 * ## An error must not read as an empty library
 *
 * `isError && books.length === 0` is the repo's rule (Epic 53): render the
 * error INSTEAD of the list only when there is nothing to show, so a failed
 * background revalidation keeps the cached books on screen. That matters more
 * here than on a farm list — the whole point of persisting this response is
 * that the farmer is somewhere with no signal, where a revalidation failing is
 * the EXPECTED state and the cached text is the feature.
 *
 * ## No chapter count here, because the directory payload has none
 *
 * `BookSummary` carries `title`, `author`, `locale`, `summary`, `version`,
 * `updatedAt` and `useCases` — deliberately not a chapter count, since
 * `SUMMARY_SELECT` is spelled once and the directory withholds the text. The
 * count belongs to the reader, which has the chapters. Writing "Глави: 13"
 * here would need a second SELECT shape, which is the #1664 split
 * `usecases/library.ts` exists to avoid.
 */
/**
 * What this component READS, not the whole payload.
 *
 * `BookSummary` also carries `locale`, `version`, `updatedAt` and `useCases`.
 * They are omitted here on purpose: a local view type listing fields nothing
 * renders reads as though the surface used them, and the next person to add a
 * column would not know which of the seven were load-bearing. `version` in
 * particular is for the phone deciding whether to re-download — not for
 * display, which is `updatedAt`'s job (#2980 §3(a)).
 */
interface BookCardView {
    slug: string;
    title: string;
    author: string;
    summary: string | null;
}

const ENDPOINT = '/api/library/books';

export function LibraryDirectoryClient() {
    const t = useTranslations('library');

    const { data, isLoading, error } = useSWR(ENDPOINT, (url: string) =>
        apiGet<{ books: BookCardView[] }>(url),
    );

    const books = data?.books ?? [];
    const isError = Boolean(error);

    return (
        <div className="mx-auto w-full max-w-3xl space-y-section p-4 md:p-8">
            <header className="space-y-tight">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-xs text-content-muted">{t('intro')}</p>
            </header>

            {isLoading ? (
                <div className="space-y-default" aria-busy="true">
                    {[0, 1].map((i) => (
                        <Skeleton key={i} className="h-24 w-full rounded-lg" />
                    ))}
                </div>
            ) : isError && books.length === 0 ? (
                <ErrorState title={t('error')} />
            ) : books.length === 0 ? (
                <EmptyState variant="no-records" title={t('empty')} />
            ) : (
                <ul className="space-y-default">
                    {books.map((book) => (
                        <li
                            key={book.slug}
                            className="rounded-lg border border-border-subtle p-4"
                        >
                            <Link
                                href={`/library/${book.slug}`}
                                className="block space-y-tight hover:underline"
                            >
                                <span className="block font-medium text-content-emphasis">
                                    {book.title}
                                </span>
                                <span className="block text-xs text-content-muted">
                                    {book.author}
                                </span>
                            </Link>
                            {book.summary ? (
                                <p className="mt-default text-xs text-content-muted">
                                    {book.summary}
                                </p>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
