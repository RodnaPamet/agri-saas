/**
 * PATCH /api/account/profile — update the caller's own display name (UI 14b).
 *
 * Self-service (mirrors `/api/account/avatar` + `/api/auth/change-password`):
 * acts ONLY on the authenticated session user — no userId parameter, so one
 * user can never write another's profile. Account-level, not tenant-scoped;
 * no `requirePermission`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { unauthorized, badRequest } from '@/lib/errors/types';
import { updateOwnDisplayName, DISPLAY_NAME_MAX } from '@/lib/account/profile';

const ProfileNameSchema = z.object({
    firstName: z.string().max(DISPLAY_NAME_MAX).optional(),
    lastName: z.string().max(DISPLAY_NAME_MAX).optional(),
});

export const PATCH = withApiErrorHandling(async (req: NextRequest) => {
    const session = await auth();
    if (!session?.user?.id) throw unauthorized();

    const parsed = ProfileNameSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw badRequest('Invalid profile payload.');

    const result = await updateOwnDisplayName(
        session.user.id,
        parsed.data.firstName,
        parsed.data.lastName,
    );
    return jsonResponse(result, { status: 200 });
});
