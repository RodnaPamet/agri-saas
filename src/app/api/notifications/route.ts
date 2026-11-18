import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { listMyNotifications } from '@/app-layer/usecases/notification';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getLegacyCtx(req, { allowOperator: true }); // the operator's own surface (#3207)
    const notifications = await listMyNotifications(ctx);
    return jsonResponse(notifications);
});
