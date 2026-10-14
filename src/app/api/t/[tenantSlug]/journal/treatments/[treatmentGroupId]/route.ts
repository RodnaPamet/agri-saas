import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedNotFound } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * Look a recorded treatment up by its handle (#1740).
 *
 * The handle is in the PATH rather than a query parameter deliberately: iOS
 * writes the full URL including the query string to the device log,
 * unsuppressably, and a path segment is the one place an identifier can sit
 * without that. It is a server-minted UUID or the client's own
 * `Idempotency-Key`, so it names nothing about a person either way.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const treatment = await getDiaryTreatment(ctx, params.treatmentGroupId);
        if (!treatment) {
            throw codedNotFound(
                'TREATMENT_NOT_FOUND',
                'No treatment was recorded under that handle.',
                { reference: 'treatmentGroupId' },
            );
        }
        return jsonResponse(treatment);
    },
);
