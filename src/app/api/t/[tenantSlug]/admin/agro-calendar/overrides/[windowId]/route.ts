import { NextRequest } from 'next/server';

import { clearCalendarOverride } from '@/app-layer/usecases/agro-calendar-overrides';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * Clear a window's override from the platform console (#3095): a correction
 * gives МЗХ's cited window back, an addition disappears. 404 when nothing is
 * live on the window.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; windowId: string }>(
        'admin.manage',
        async (_req: NextRequest, { params }, ctx) => {
            assertPlatformSupport(ctx);
            await clearCalendarOverride(params.windowId, { kind: 'user', userId: ctx.userId });
            return new Response(null, { status: 204 });
        },
    ),
);

export const runtime = 'nodejs';
