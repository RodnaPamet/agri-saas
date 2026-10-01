import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { parseBottomTabOrder } from '@/lib/account/bottom-tabs';
import { resolveFlags } from '@/lib/feature-flags';

export const GET = withApiErrorHandling(async () => {
    const session = await auth();
    if (!session?.user) {
        return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
            id: true,
            email: true,
            name: true,
            bottomTabOrder: true,
            tenantMemberships: {
                where: { status: 'ACTIVE' },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: {
                    role: true,
                    tenant: { select: { id: true, name: true, slug: true } },
                },
            },
        },
    });

    const membership = user?.tenantMemberships[0];

    // Flags resolved FOR THIS USER, on the launch request the client already
    // makes. Cohort-gated flags are therefore already narrowed — a client never
    // sees a flag that is enabled for someone else, so it cannot accidentally
    // render a surface it is not in the cohort for.
    const featureFlags = await resolveFlags(session.user.id ?? null);

    return jsonResponse({
        user: {
            id: user?.id,
            email: user?.email,
            name: user?.name,
            role: membership?.role ?? 'READER',
            // Bottom-row arrangement, returned here so a client can draw its
            // tab bar from the launch request it already makes rather than a
            // second round-trip. `null` means "never chosen, use the default";
            // `[]` means deliberately cleared. It is a PREFERENCE — resolve it
            // against the surfaces the member may reach on every render.
            bottomTabOrder: parseBottomTabOrder(user?.bottomTabOrder),
        },
        tenant: membership?.tenant ?? null,
        /**
         * Runtime feature flags, already resolved for this caller.
         *
         * An ABSENT key means OFF. Do not treat a missing key as a default-on:
         * the whole point of the rail is that a surface nobody has enabled is
         * invisible, and the global kill switch (`FEATURE_FLAGS_FORCE_OFF`)
         * answers with an EMPTY OBJECT rather than a set of falses — so
         * "no keys at all" is a legitimate state meaning everything is off.
         *
         * Re-read it; do not cache across sessions. The server caches the table
         * for 30s, which is the propagation bound for a flip.
         */
        featureFlags,
    });
});
