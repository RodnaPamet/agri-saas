import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { getCampaignProgress } from '@/app-layer/usecases/campaign-progress';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * `GET /api/agro-progress` — the field campaign's progress from МЗХ's weekly
 * bulletin (#3173), for Табло. National reference data, the same for every
 * farm, so it is person-scoped like `/api/agro-benchmarks`, open to every
 * signed-in caller. `progress` is null until the weekly job has stored a snapshot.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    await getUserCtx(req);
    return jsonWithETag(req, { progress: await getCampaignProgress() });
});
