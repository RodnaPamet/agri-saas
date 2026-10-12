/**
 * /tenants — Tenant picker page (R-1 closure).
 *
 * Rendered when a user has >1 active tenant membership and needs to choose
 * which workspace to enter. Also handles the degenerate cases:
 *   0 memberships → redirect to /no-tenant
 *   1 membership  → redirect directly to that tenant's dashboard
 *
 * This page is listed in PUBLIC_PATH_PREFIXES in guard.ts so the
 * middleware tenant-access gate does not bounce the user trying to
 * reach the picker before an active tenant is set in the JWT.
 *
 * The membership list is queried directly from the DB, NOT read from
 * `session.user.memberships`: the JWT list is capped at
 * `MAX_JWT_MEMBERSHIPS` for cookie-size safety, but the picker is a
 * server component with no Edge constraint and must show EVERY
 * workspace the user belongs to.
 */
import { auth, signOut } from '@/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import prisma from '@/lib/prisma';
import { Heading } from '@/components/ui/typography';
import { redirectIfSuspended } from '@/lib/auth/suspension-page';

export default async function TenantsPage() {
    const session = await auth();

    if (!session?.user?.id) {
        redirect('/login');
    }

    // Not covered by `getTenantServerContext` — this page is person-scoped and
    // reads its farm list straight from Prisma, which is exactly why it needs
    // its own call (#1657). Without it a suspended account is shown the names
    // of every farm it belongs to.
    await redirectIfSuspended(session.user.id);

    const t = await getTranslations('tenants');

    // Complete, authoritative membership list — see the file header.
    const rows = await prisma.tenantMembership.findMany({
        // Exclude soft-deleted (org-removed) tenants from the picker.
        where: {
            userId: session.user.id,
            status: 'ACTIVE',
            tenant: { deletedAt: null },
        },
        orderBy: { createdAt: 'asc' },
        include: { tenant: { select: { slug: true } } },
    });
    const memberships = rows.map((m) => ({ slug: m.tenant.slug, role: m.role }));

    if (memberships.length === 0) {
        redirect('/no-tenant');
    }

    if (memberships.length === 1) {
        redirect(`/t/${memberships[0].slug}/dashboard`);
    }

    // >1 memberships — render the picker
    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div className="max-w-lg w-full">
                <div className="mb-8 text-center">
                    <Heading level={1} className="mb-2">
                        {t('title')}
                    </Heading>
                    <p className="text-content-muted">
                        {t('subtitle')}
                    </p>
                </div>
                <div className="flex flex-col gap-compact">
                    {memberships.map((m) => (
                        <a
                            key={m.slug}
                            href={`/t/${m.slug}/dashboard`}
                            className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-default px-5 py-4 hover:bg-bg-muted/50 transition-colors"
                        >
                            <div>
                                <p className="font-medium text-content-default">{m.slug}</p>
                                <p className="text-sm text-content-muted capitalize">
                                    {m.role.toLowerCase()}
                                </p>
                            </div>
                            <svg
                                className="h-4 w-4 text-content-muted"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M6 3l5 5-5 5" />
                            </svg>
                        </a>
                    ))}
                </div>
                <div className="mt-6 text-center">
                    <form
                        action={async () => {
                            'use server';
                            await signOut({ redirectTo: '/login' });
                        }}
                    >
                        <button
                            type="submit"
                            className="text-sm text-content-muted hover:text-content-default transition-colors"
                        >
                            {t('signOut')}
                        </button>
                    </form>
                </div>
            </div>
        </main>
    );
}
