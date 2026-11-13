import { notFound, redirect } from 'next/navigation';

import { auth } from '@/auth';
import { redirectIfSuspended } from '@/lib/auth/suspension-page';
import { isFeatureEnabled } from '@/lib/feature-flags';

import { BookReaderClient } from './BookReaderClient';

/**
 * «Вдъхновение» — one book (#2980 PR 3).
 *
 * The same four gates as the directory next door, for the same reasons, and
 * they are repeated rather than hoisted into a `layout.tsx`: a layout cannot
 * `notFound()` per-flag without also owning the auth redirect, and two pages
 * each stating their own gate is what `count-the-routes-a-gate-covers` asks
 * for. If a third library page appears, hoist them then — with a guard
 * deriving the population from the directory, not a third copy.
 *
 * ## The slug is passed through, never resolved here
 *
 * `readBook` throws a coded not-found for an unknown or unpublished slug, and
 * the client surfaces that. Resolving it server-side would mean a second read
 * of the same row and would put the book TEXT in the server-rendered HTML,
 * which is the one thing the offline design does not want: the text has to
 * arrive through the client fetch so `PERSISTABLE_PATHS` can keep it. A phone
 * that read the book from SSR'd markup would have nothing cached the next time
 * it opened the page with no signal.
 *
 * `publishedAt` is enforced in BOTH the `where` clause and `book_select`, and
 * that redundancy is load-bearing: dropping it from either one alone leaves all
 * twelve integration cases green, so only the COMBINED mutation reddens.
 * Nothing here may add a third place it is decided.
 */
export default async function BookPage({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;

    const session = await auth();
    if (!session?.user?.id) redirect('/login');

    await redirectIfSuspended(session.user.id);

    if (!(await isFeatureEnabled('library.enabled', session.user.id))) notFound();

    return <BookReaderClient slug={slug} />;
}
