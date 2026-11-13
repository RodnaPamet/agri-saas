import { notFound, redirect } from 'next/navigation';

import { auth } from '@/auth';
import { redirectIfSuspended } from '@/lib/auth/suspension-page';
import { isFeatureEnabled } from '@/lib/feature-flags';

import { LibraryDirectoryClient } from './LibraryDirectoryClient';

/**
 * «Вдъхновение» — the book library (#2980 PR 3).
 *
 * ## It is NOT under `/t/{slug}`, by owner ruling with a mechanism behind it
 *
 * Owner ruling 2026-11-13. A book belongs to no farm — `Book` and
 * `BookChapter` carry no `tenantId` — and the path SHAPE is what makes the
 * surface reach every role, including a MECHANISATOR. The operator lockdown
 * in `src/middleware.ts` sits inside `if (isTenantPath(pathname))`, so a
 * non-tenant path is excluded before `isOperatorAllowedPath` is consulted at
 * all; that allowlist would deny `/library` read in isolation.
 *
 * The alternative, `/t/{slug}/library`, was rejected for two reasons: it would
 * need an entry in the separate hand-written page enumeration, and it would
 * imply a per-farm library that does not exist.
 * `tests/unit/library-reaches-the-operator.test.ts` already drives the real
 * middleware for the API half, so the claim is executed rather than asserted.
 *
 * ## THE PAGE IS A SHELL OVER THE API, and that is the offline requirement
 *
 * It would be shorter to call `listBooks` here and server-render the
 * directory. That would break the thing #2980 is for: the offline copy. The
 * persistent SWR cache populates from CLIENT fetches
 * (`SWRPersistenceProvider` wraps one `<SWRConfig provider>`), so a
 * server-rendered read puts nothing on the phone and a farmer in a field with
 * no signal sees an empty page. `PERSISTABLE_PATHS` therefore carries
 * `/api/library/books`, and the client is what asks for it.
 *
 * Note the entry is the FULL path and not `/library/books`:
 * `tenantRelativePath` strips only the `/api/t/<slug>/` prefix and returns a
 * non-tenant key unchanged, so a tenant-relative spelling would match nothing
 * and persist nothing — silently, which is the failure this comment exists to
 * prevent.
 *
 * ## `auth()`, not `getTenantCtx` — and `/library` joins `isPersonPath`
 *
 * There is no slug to resolve. The page authenticates with `auth()` like
 * `/tenants` does, and `book_select` admits either session variable so a
 * person context is sufficient.
 *
 * `/library` is added to `isPersonPath` in the same change, and that is not
 * tidiness. That predicate's own docblock records what a path in NEITHER
 * population costs: `/api/account/**` was not a tenant path and not a person
 * path, so its seven routes "took no Edge MFA gate and no read tier" until
 * #1192. A page outside both lists is the same hole — an MFA-pending session
 * would read the library — and it is the shape that produced three
 * gate-coverage findings in one day (#1652, #1665, #1745).
 *
 * It is deliberately NOT added to `isOperatorBlockedPersonPath`: the owner
 * chose this path precisely so a field operator reaches it.
 *
 * ## The flag answers 404, and the nav item hides
 *
 * `library.enabled` is default-OFF like every dark-launch rail, and a flag-off
 * deployment must not serve an empty shell. 404 rather than a redirect,
 * matching `assertFeatureEnabled` on the API and the channels page next door:
 * a dark surface is one that does not resolve. The sidebar item is gated on
 * the same flag server-side, because a nav item leading to a 404 is worse than
 * an absent one (P9.5).
 *
 * ## A suspended account is turned away
 *
 * `server-pages-check-suspension` covers `src/app` excluding `src/app/api` by
 * SUBTREE, so this page is in its population and must gate or be allowlisted
 * with a reason. It gates. The library is not farm data, so an exemption would
 * have been arguable — and gating is the cheaper of the two defensible
 * answers: nothing is lost (a reinstated account reads the books again) and it
 * needs no new entry in a map somebody must later re-justify.
 */
export default async function LibraryPage() {
    const session = await auth();
    if (!session?.user?.id) redirect('/login');

    await redirectIfSuspended(session.user.id);

    if (!(await isFeatureEnabled('library.enabled', session.user.id))) notFound();

    return <LibraryDirectoryClient />;
}
