import { NextRequest } from 'next/server';
import { z } from 'zod';

import { listCalendarOverrides, setCalendarOverride } from '@/app-layer/usecases/agro-calendar-overrides';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * The agro calendar's overrides, from the phone's platform console — #3095
 * stage 2, the SESSION door. `admin.manage` alone is not enough: every
 * farm's admin holds it, and the calendar is the same for every farm, so
 * `assertPlatformSupport` confines it to the platform tenant (#2963's
 * two-door pattern). The keyed sibling is `/api/admin/agro-calendar/overrides`.
 */
const Body = z.object({
    cropKey: z.string().min(1).max(80),
    window: z.unknown(),
    basis: z.object({ bg: z.string().max(1000), en: z.string().max(1000).nullable().optional() }),
});

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _args, ctx) => {
        assertPlatformSupport(ctx);
        return jsonResponse({ overrides: await listCalendarOverrides() });
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _args, ctx) => {
        assertPlatformSupport(ctx);
        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'The request could not be read.');
        }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) throw codedBadRequest('INVALID_BODY', 'A crop, a window and a basis are required.');
        const override = await setCalendarOverride(parsed.data, { kind: 'user', userId: ctx.userId });
        return jsonResponse({ override });
    }),
);

export const runtime = 'nodejs';
