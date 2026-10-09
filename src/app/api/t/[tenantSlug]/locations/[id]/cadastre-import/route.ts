/**
 * /api/t/[tenantSlug]/locations/[id]/cadastre-import
 *
 * POST — stage a КАИС cadastre-by-identifier import + enqueue the off-thread
 *        `cadastre-import` job (202 + jobId). Body: `{ identifiers: string[] }`.
 * GET  — report whether the feature is enabled on this deployment
 *        (`{ enabled: boolean }`). The КАИС URL is NEVER exposed; the client
 *        only learns the boolean, which gates the import tab.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    stageLocationCadastreImport,
    isCadastreImportEnabled,
    MAX_CADASTRE_IDENTIFIERS,
} from '@/app-layer/usecases/cadastre-import';
import { assertCanWrite } from '@/app-layer/policies/common';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        assertCanWrite(ctx);
        return jsonResponse({ enabled: isCadastreImportEnabled(), maxIdentifiers: MAX_CADASTRE_IDENTIFIERS });
    },
);

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const body = (await req.json().catch(() => null)) as { identifiers?: unknown } | null;
        const identifiers = Array.isArray(body?.identifiers)
            ? (body!.identifiers.filter((v) => typeof v === 'string') as string[])
            : null;
        if (!identifiers || identifiers.length === 0) {
            // Coded: this operation's 400 declares `ErrorResponse` while its
            // 413/415 declare `RawErrorResponse`, so the bare string
            // contradicted the one status it was returned with (#1447). Prose
            // preserved verbatim.
            throw codedBadRequest(
                'IDENTIFIERS_REQUIRED',
                'Provide a non-empty "identifiers" array.',
            );
        }

        const result = await stageLocationCadastreImport(ctx, params.id, { identifiers });
        // 202 Accepted — the fetch + parse + persist runs off-thread. The client
        // polls GET .../cadastre-import/:jobId for completion.
        return jsonResponse({ ...result, status: 'queued' }, { status: 202 });
    },
);
