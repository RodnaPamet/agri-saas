/**
 * POST   /api/account/avatar — upload the caller's own avatar.
 * DELETE /api/account/avatar — remove the caller's own avatar.
 *
 * Self-service (avatar roadmap P3): both act ONLY on the
 * authenticated session user — there is no userId parameter, so one
 * user can never write another's avatar. Account-level, not
 * tenant-scoped; no `requirePermission` (mirrors `/api/auth/change-password`).
 *
 * The image arrives already resized + EXIF-stripped + webp-encoded by
 * the client `<canvas>` round-trip; `uploadOwnAvatar` validates the
 * bytes and persists them.
 */
import type { NextRequest } from 'next/server';

import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { unauthorized, badRequest } from '@/lib/errors/types';
import {
    uploadOwnAvatar,
    removeOwnAvatar,
    AVATAR_MAX_BYTES,
} from '@/lib/account/avatar';

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const session = await auth();
    if (!session?.user?.id) throw unauthorized();

    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
        throw badRequest('Missing avatar file in form data.');
    }
    // Reject oversized payloads before buffering them into memory.
    if (file.size > AVATAR_MAX_BYTES) {
        throw badRequest(
            'Processed avatar is too large — re-select a smaller image.',
        );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const result = await uploadOwnAvatar(session.user.id, buf);
    return jsonResponse(result, { status: 200 });
});

export const DELETE = withApiErrorHandling(async () => {
    const session = await auth();
    if (!session?.user?.id) throw unauthorized();

    await removeOwnAvatar(session.user.id);
    return jsonResponse({ success: true });
});
