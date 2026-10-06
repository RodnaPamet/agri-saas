import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { parseBottomTabOrder } from '@/lib/account/bottom-tabs';
import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/layout/AppShell';
import { ClientProviders } from '@/components/layout/ClientProviders';
import { NavigationTracker } from '@/components/nav/NavigationTracker';

/**
 * Tenant app layout — Server Component.
 *
 * Responsibilities:
 *   - Resolve session server-side (via auth())
 *   - Resolve translations server-side (via getTranslations())
 *   - Compose client wrappers with minimal, serializable props
 *
 * Client boundaries:
 *   - AppShell: layout chrome (sidebar, drawer, mobile bar, signOut)
 *   - ClientProviders: data-layer providers (QueryClientProvider)
 *
 * Tenant context (tenantId, role, permissions) is provided by the parent
 * TenantLayout at src/app/t/[tenantSlug]/layout.tsx.
 */
export default async function AppLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ tenantSlug: string }>;
}) {
    // Resolve session server-side — no client-side useSession() needed
    const session = await auth();
    if (!session?.user) {
        redirect('/login');
    }

    // Resolve translations server-side — passed as plain string to AppShell
    const tc = await getTranslations('common');

    /**
     * P2.5 — the caller's saved bottom-bar arrangement, read HERE rather than
     * fetched by the bar itself.
     *
     * The three options were a client fetch, the JWT, or this. A client fetch
     * (`/api/auth/me` via SWR) would render the default bar first and re-order
     * it when the response landed — a visible shuffle after paint, which is
     * the same defect class P2.4 has just finished removing from the theme.
     * The JWT would be free but goes stale: a user who reorders their tabs
     * would keep the old bar until their token refreshed.
     *
     * So: one indexed primary-key select on a layout that is already dynamic
     * (it awaits `auth()` and `headers()`), and the bar is correct in the
     * first frame. `parseBottomTabOrder` degrades a hand-edited or
     * older-shaped row to `null` — "never chosen" — rather than throwing,
     * because this sits on the render path of every tenant page.
     */
    const bottomTabOrder = session.user.id
        ? parseBottomTabOrder(
              (
                  await prisma.user.findUnique({
                      where: { id: session.user.id },
                      select: { bottomTabOrder: true },
                  })
              )?.bottomTabOrder,
          )
        : null;

    // Operator (MECHANISATOR) mode → the app shell renders NO navigation.
    // The role is read from THIS tenant's membership (a user can hold
    // different roles per tenant). Display-only defence-in-depth; the
    // middleware route-guard is the enforcing layer.
    const { tenantSlug } = await params;
    const operator =
        session.user.memberships?.find((m) => m.slug === tenantSlug)?.role ===
        'MECHANISATOR';

    // ClientProviders sits inside AppShell so the page tree (children)
    // gets QueryClient + OnboardingTour context. AppShell's own
    // SidebarNav must NOT depend on either provider — the
    // calendar-badge hook (Epic 49) uses a plain fetch + useState
    // instead of useQuery for that reason.
    return (
        <AppShell
            operator={operator}
            user={{
                name: session.user.name,
                email: session.user.email,
                image: session.user.image,
                memberships: session.user.memberships,
                // B4 — thread orgMemberships into the workspace
                // switcher. JWT field may be undefined for sessions
                // minted pre-B4 / for users with no org memberships;
                // an empty array reads as "no orgs section".
                orgMemberships: session.user.orgMemberships,
                // P2.5 — shared with iOS; see `@/lib/nav/resolve-bottom-tabs`
                // for the rendering contract the two clients agreed on.
                bottomTabOrder,
            }}
            appName={tc('appName')}
        >
            <ClientProviders userId={session.user.id ?? null}>
                {/* Smart-nav: records the in-tenant referrer on every
                    route change so <BackAffordance> can resolve
                    "where you came from". Side-effect only (renders null). */}
                <NavigationTracker />
                {children}
            </ClientProviders>
        </AppShell>
    );
}
