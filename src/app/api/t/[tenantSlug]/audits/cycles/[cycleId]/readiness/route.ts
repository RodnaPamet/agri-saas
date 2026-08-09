import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    computeReadiness, exportReadinessJson, exportUnmappedCsv, exportPracticeGapsCsv,
} from '@/app-layer/usecases/audit-readiness-scoring';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; cycleId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'export-json') {
        const data = await exportReadinessJson(ctx, params.cycleId);
        return jsonResponse(data);
    }

    if (action === 'export-unmapped-csv') {
        const { csv, filename } = await exportUnmappedCsv(ctx, params.cycleId);
        return new NextResponse(csv, {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${filename}"` },
        });
    }

    if (action === 'export-practice-gaps-csv') {
        const { csv, filename } = await exportPracticeGapsCsv(ctx, params.cycleId);
        return new NextResponse(csv, {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${filename}"` },
        });
    }

    // Default: compute readiness
    const result = await computeReadiness(ctx, params.cycleId);
    return jsonResponse(result);
});
