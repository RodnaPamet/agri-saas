import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { resolveTenantContext } from '@/lib/tenant-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import prisma from '@/lib/prisma';
import type { Role } from '@prisma/client';
import { Check } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cardVariants } from '@/components/ui/card-variants';
import { cn } from '@/lib/cn';

export const dynamic = 'force-dynamic';

/**
 * Admin-only RBAC overview page.
 * Authorization: handled by centralized admin layout guard.
 * Shows: the permission matrix by role. Members are NOT listed here —
 * /admin/members owns them, and a second read-only copy is a second thing
 * to keep in step.
 */
export default async function RbacPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const t = await getTranslations('admin.rbac');

    // ─── Server-side guard ───
    const session = await auth();
    if (!session?.user?.id) redirect('/login');

    let tenantCtx;
    try {
        tenantCtx = await resolveTenantContext({ tenantSlug }, session.user.id);
    } catch {
        redirect(`/t/${tenantSlug}/dashboard`);
    }



    // ─── Data fetching ───
    //
    // No member query here any more. This page listed the tenant's members
    // beside the permission matrix, which meant members lived in TWO places:
    // here, read-only, and at /admin/members, which owns them and can actually
    // change a role. Two lists of one thing is two things to keep in step, and
    // the read-only one is the copy a reader reaches for and then cannot act on.
    //
    // The matrix is about ROLES, not about who holds them. It stands alone.

    const roles: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'];
    const permissionMatrix: Record<Role, PermissionSet> = {
        OWNER: getPermissionsForRole('OWNER'),
        ADMIN: getPermissionsForRole('ADMIN'),
        EDITOR: getPermissionsForRole('EDITOR'),
        AUDITOR: getPermissionsForRole('AUDITOR'),
        READER: getPermissionsForRole('READER'),
        MECHANISATOR: getPermissionsForRole('MECHANISATOR'),
    };

    // Flatten permission keys for the matrix table
    const permissionRows: { resource: string; action: string }[] = [];
    const sampleSet = permissionMatrix.ADMIN;
    for (const [resource, actions] of Object.entries(sampleSet)) {
        for (const action of Object.keys(actions as Record<string, boolean>)) {
            permissionRows.push({ resource, action });
        }
    }

    return (
        <div className="space-y-page animate-fadeIn">
            {/* Header */}
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('breadcrumbAdmin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('breadcrumbRolesAccess') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('heading')}</Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t.rich('matrixFor', {
                        name: tenantCtx.tenant.name,
                        b: (chunks) => <span className="text-content-emphasis font-medium">{chunks}</span>,
                    })}{' '}
                    {t('yourRole')} <StatusBadge variant="info">{tenantCtx.role}</StatusBadge>
                </p>
            </div>

            {/* Members live at /admin/members — see the note above. */}
            <section>
                <p className="text-sm text-content-muted">
                    {t.rich('membersMovedNotice', {
                        link: (chunks) => (
                            <Link
                                href={`/t/${tenantSlug}/admin/members`}
                                className="text-[var(--brand-default)] underline"
                            >
                                {chunks}
                            </Link>
                        ),
                    })}
                </p>
            </section>

            {/* Permission Matrix */}
            <section>
                <Heading level={2} className="mb-3">{t('permissionMatrix')}</Heading>
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-x-auto')}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th className="sticky left-0 bg-bg-default/90 z-10">{t('resource')}</th>
                                <th className="sticky left-[120px] bg-bg-default/90 z-10">{t('action')}</th>
                                {roles.map((r) => (
                                    <th key={r} className="text-center">{r}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {permissionRows.map(({ resource, action }) => (
                                <tr key={`${resource}.${action}`}>
                                    <td className="text-xs font-medium text-content-default sticky left-0 bg-bg-default/50">{resource}</td>
                                    <td className="text-xs text-content-muted sticky left-[120px] bg-bg-default/50">{action}</td>
                                    {roles.map((role) => {
                                        const resourcePerms = permissionMatrix[role][resource as keyof PermissionSet];
                                        const granted = (resourcePerms as Record<string, boolean>)[action];
                                        return (
                                            <td key={role} className="text-center">
                                                {granted ? (
                                                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-bg-success text-content-success"><Check size={10} /></span>
                                                ) : (
                                                    <span className="inline-block w-4 h-4 rounded-full bg-bg-elevated/50 text-content-subtle text-[10px] leading-4">—</span>
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
