/**
 * КАИС cadastre import — cheap synchronous staging boundary.
 *
 * The expensive work (КАИС tree walk + archive download + shapefile parse +
 * reprojection) runs OFF the request thread in the `cadastre-import` job. This
 * usecase validates the identifier list, verifies the target Location, and
 * enqueues the job. Returns immediately with the job id; the route answers 202.
 *
 * Feature-gated: the import is only available when `CADASTRE_OPENDATA_INDEX_URL`
 * is configured. `isCadastreImportEnabled()` is the SERVER-side boolean the UI
 * tab is gated on — the URL itself is never exposed to the client.
 */
import { RequestContext } from '../types';
import { assertCanWrite } from '../policies/common';
import { badRequest, codedNotFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { enqueue } from '@/app-layer/jobs/queue';
import { logger } from '@/lib/observability/logger';
import { env } from '@/env';
import {
    normalizeCadastreIdentifier,
    isValidCadastreIdentifier,
} from '@/lib/cadastre/identifier';

/** Max identifiers accepted per import (bounds the КАИС walk + parse cost). */
export const MAX_CADASTRE_IDENTIFIERS = 500;

/** SERVER-side feature flag — true when КАИС OpenData is configured. */
export function isCadastreImportEnabled(): boolean {
    return Boolean(env.CADASTRE_OPENDATA_INDEX_URL);
}

export interface CadastreImportStageResult {
    /** BullMQ job id — poll `GET .../cadastre-import/:jobId` for progress. */
    jobId: string;
    /** How many identifiers were accepted (valid, de-duplicated). */
    accepted: number;
    /** Normalized lines rejected client-side validation echoed back. */
    invalid: string[];
}

/**
 * Stage a cadastre-by-identifier import and enqueue the off-thread job.
 * Validates + de-duplicates the identifier list, caps it, verifies the target
 * location exists, then enqueues. Throws `badRequest` when the feature is
 * disabled or no valid identifier remains.
 */
export async function stageLocationCadastreImport(
    ctx: RequestContext,
    locationId: string,
    input: { identifiers: string[] },
): Promise<CadastreImportStageResult> {
    assertCanWrite(ctx);

    if (!isCadastreImportEnabled()) {
        throw badRequest('Cadastre import is not enabled on this deployment.');
    }

    // Validate + normalize + de-duplicate.
    const seen = new Set<string>();
    const accepted: string[] = [];
    const invalid: string[] = [];
    for (const raw of input.identifiers ?? []) {
        if (typeof raw !== 'string') continue;
        const norm = normalizeCadastreIdentifier(raw);
        if (!norm) continue;
        if (isValidCadastreIdentifier(norm)) {
            if (!seen.has(norm)) {
                seen.add(norm);
                accepted.push(norm);
            }
        } else {
            invalid.push(norm);
        }
    }

    if (accepted.length === 0) {
        throw badRequest('No valid cadastral identifiers (expected ЕКАТТЕ.масив.номер, e.g. 68134.8360.729).');
    }
    if (accepted.length > MAX_CADASTRE_IDENTIFIERS) {
        throw badRequest(`Too many identifiers (${accepted.length}); the maximum per import is ${MAX_CADASTRE_IDENTIFIERS}.`);
    }

    // Verify the target location exists (tenant-scoped) before enqueueing.
    await runInTenantContext(ctx, async (db) => {
        const location = await db.location.findFirst({
            where: { id: locationId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!location) throw codedNotFound('LOCATION_NOT_FOUND', 'Location not found');
    });

    const job = await enqueue('cadastre-import', {
        tenantId: ctx.tenantId,
        initiatedByUserId: ctx.userId,
        locationId,
        identifiers: accepted,
        requestId: ctx.requestId,
    });

    logger.info('cadastre-import.enqueued', {
        component: 'cadastre-import-stage',
        tenantId: ctx.tenantId,
        locationId,
        jobId: job.id,
        accepted: accepted.length,
        invalid: invalid.length,
    });

    return { jobId: String(job.id), accepted: accepted.length, invalid };
}
