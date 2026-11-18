import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { markNotificationRead } from '@/app-layer/usecases/notification';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const PATCH = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getLegacyCtx(req, { allowOperator: true }); // the operator's own surface (#3207)
    const notification = await markNotificationRead(ctx, params.id);
    return jsonResponse(notification);
});
