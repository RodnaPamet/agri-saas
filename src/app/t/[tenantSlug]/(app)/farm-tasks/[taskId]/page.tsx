import { auth } from '@/auth';
import { FarmTaskDetailClient } from './FarmTaskDetailClient';

export const dynamic = 'force-dynamic';

/**
 * Farm task detail — Server Component wrapper.
 *
 * This is the single task-detail destination in the app (the compliance
 * /tasks/[taskId] page was retired; inbound deep-links repoint here). The
 * detail is read client-side via SWR (GET /tasks/[taskId]); the wrapper only
 * resolves the slug + the caller's user id, which the client uses to gate the
 * assignee self-serve "Mark done" affordance (no client SessionProvider read —
 * identity is threaded from the server per repo convention).
 */
export default async function FarmTaskDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; taskId: string }>;
}) {
    const { tenantSlug, taskId } = await params;
    const session = await auth();
    return (
        <FarmTaskDetailClient
            tenantSlug={tenantSlug}
            taskId={taskId}
            currentUserId={session?.user?.id ?? null}
        />
    );
}
