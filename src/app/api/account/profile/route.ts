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

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {badRequest } from '@/lib/errors/types';
import { updateOwnDisplayName, DISPLAY_NAME_MAX } from '@/lib/account/profile';

const ProfileNameSchema = z.object({
    firstName: z.string().max(DISPLAY_NAME_MAX).optional(),
    lastName: z.string().max(DISPLAY_NAME_MAX).optional(),
});

export const PATCH = withApiErrorHandling(async (req: NextRequest) => {
    // `getUserCtx`, not `auth()` (#1579). It refuses three callers this route
    // used to answer: an `iflk_` API key presented as a person credential
    // (which must not be served as the cookie's user), an MFA-pending session,
    // and — on a social surface — the operator-only persona. This is an
    // `account` surface, so a MECHANISATOR is correctly NOT refused.
    const ctx = await getUserCtx(req);

    const parsed = ProfileNameSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw badRequest('Invalid profile payload.');

    const result = await updateOwnDisplayName(
        ctx.userId,
        parsed.data.firstName,
        parsed.data.lastName,
    );
    return jsonResponse(result, { status: 200 });
});
