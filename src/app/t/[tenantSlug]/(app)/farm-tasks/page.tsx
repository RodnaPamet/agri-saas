import { auth } from '@/auth';
import { FarmTasksClient } from './FarmTasksClient';

export const dynamic = 'force-dynamic';

/**
 * Farm Tasks — Server Component wrapper.
 *
 * The farm queue is read client-side via SWR (GET /farm-tasks?scope=all), so
 * the wrapper only resolves the tenant slug + the caller's user id (used to
 * gate the assignee "Mark done" affordance) and mounts the client island.
 */
export default async function FarmTasksPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const session = await auth();
    return (
        <FarmTasksClient
            tenantSlug={tenantSlug}
            currentUserId={session?.user?.id ?? null}
        />
    );
}
