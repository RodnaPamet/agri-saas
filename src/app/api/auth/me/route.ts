import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { parseBottomTabOrder } from '@/lib/account/bottom-tabs';

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

    return jsonResponse({
        user: {
            id: user?.id,
            email: user?.email,
            name: user?.name,
            // `null` means "no active membership", which is exactly what the
            // adjacent `tenant: null` already says. It must NOT fall back to a
            // real role: READER carries real grants (`view` on evidence/tasks/
            // reports/knowledge plus evidence `download`), so a fallback answers
            // "who am I" with view access for a principal who has none, and a
            // role with no tenant has no referent anyway. The live gates are RLS,
            // `requirePermission` and the middleware tenant check — none read this
            // field — so this is contract honesty, not the authorization boundary.
            role: membership?.role ?? null,
            // Bottom-row arrangement, returned here so a client can draw its
            // tab bar from the launch request it already makes rather than a
            // second round-trip. `null` means "never chosen, use the default";
            // `[]` means deliberately cleared. It is a PREFERENCE — resolve it
            // against the surfaces the member may reach on every render.
            bottomTabOrder: parseBottomTabOrder(user?.bottomTabOrder),
        },
        tenant: membership?.tenant ?? null,
    });
});
