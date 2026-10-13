/**
 * DataStream usecases — sensor / external time-series streams (farmOS
 * data-stream concept), behind the AGRO_DATASTREAMS feature flag.
 *
 * Two surfaces:
 *
 *   • Tenant-scoped CRUD (createDataStream / listDataStreams /
 *     listReadings) — authenticated app routes, run through
 *     `runInTenantContext`, sanitise + audit on write. `createDataStream`
 *     MINTS a raw ingest token, stores only its SHA-256 hash
 *     (`ingestTokenHash`), and returns the raw token ONCE (mirrors
 *     `mintExternalAccessToken` in vendor-assessment-send).
 *
 *   • Public token-gated ingestion (`ingestReadings`) — called by the
 *     device-facing route with NO user RequestContext. Token verification
 *     (SHA-256 hash compare, constant-time) precedes tenant resolution:
 *     the device has no session and no tenantId until the token matches a
 *     stream row. We therefore use the GLOBAL prisma client to look up
 *     the stream by hash, then continue under that row's tenantId via
 *     `runWithAuditContext`. RLS bypass is intentional + bounded — the
 *     only write is a `createMany` of readings scoped to the matched
 *     stream's tenantId. This mirrors `vendor-assessment-response.ts`.
 *     The route-level anti-enumeration shape (vague 401) lives in the
 *     route handler; the no-direct-prisma allowlist carries this file.
 *
 * @module usecases/data-stream
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { runWithAuditContext } from '@/lib/audit-context';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest, notFound, codedNotFound } from '@/lib/errors/types';
import type { DataStreamKind } from '@prisma/client';
import { logger } from '@/lib/observability/logger';

const LIST_TAKE = 200;
const READINGS_TAKE = 500;

// ─── Token helpers ─────────────────────────────────────────────────

/**
 * Mint a 32-byte URL-safe ingest token. Only the SHA-256 hash is
 * stored; the raw token is returned to the caller ONCE.
 */
function mintIngestToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}

function hashIngestToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/** Constant-time hex-string compare (both are SHA-256 hex of equal length). */
function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Vague failure for the public ingestion path (anti-enumeration). */
export class DataStreamAccessDenied extends Error {
    constructor() {
        super('Data-stream access denied');
    }
}

// ─── Types ─────────────────────────────────────────────────────────

export interface CreateDataStreamInput {
    key: string;
    name: string;
    kind: DataStreamKind;
    unit?: string | null;
    locationId?: string | null;
}

export interface CreateDataStreamResult {
    id: string;
    key: string;
    name: string;
    kind: DataStreamKind;
    /** The RAW ingest token — shown ONCE. Re-create the stream to re-mint. */
    ingestToken: string;
}

export interface IngestReading {
    recordedAt: string;
    value: number;
    unit?: string | null;
}

// ─── Tenant-scoped CRUD ────────────────────────────────────────────

export async function createDataStream(
    ctx: RequestContext,
    input: CreateDataStreamInput,
): Promise<CreateDataStreamResult> {
    assertCanWrite(ctx);
    const key = sanitizePlainText(input.key).trim();
    const name = sanitizePlainText(input.name).trim();
    if (!key) throw badRequest('A data-stream key is required.');
    if (!name) throw badRequest('A data-stream name is required.');

    const { raw, hash } = mintIngestToken();

    return runInTenantContext(ctx, async (db) => {
        // Validate the optional location belongs to the tenant.
        if (input.locationId) {
            const loc = await db.location.findFirst({
                where: { id: input.locationId, tenantId: ctx.tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!loc) throw codedNotFound('LOCATION_NOT_FOUND', 'Location not found');
        }

        const stream = await db.dataStream.create({
            data: {
                tenantId: ctx.tenantId,
                locationId: input.locationId ?? null,
                key,
                name,
                kind: input.kind,
                unit: input.unit ? sanitizePlainText(input.unit).trim() : null,
                ingestTokenHash: hash,
                status: 'ACTIVE',
            },
            select: { id: true, key: true, name: true, kind: true },
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'DataStream',
            entityId: stream.id,
            details: `Created data stream: ${stream.name}`,
            detailsJson: { category: 'entity_lifecycle', operation: 'create', entityName: 'DataStream' },
        });

        return { ...stream, ingestToken: raw };
    });
}

export async function listDataStreams(ctx: RequestContext, opts: { take?: number } = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.dataStream.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: opts.take ?? LIST_TAKE,
            select: {
                id: true,
                key: true,
                name: true,
                kind: true,
                unit: true,
                status: true,
                locationId: true,
                createdAt: true,
                // Never expose the token hash to the client.
            },
        }),
    );
}

export async function listReadings(
    ctx: RequestContext,
    dataStreamId: string,
    opts: { take?: number } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const stream = await db.dataStream.findFirst({
            where: { id: dataStreamId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!stream) throw notFound('Data stream not found');
        return db.dataStreamReading.findMany({
            where: { tenantId: ctx.tenantId, dataStreamId },
            orderBy: { recordedAt: 'desc' },
            take: opts.take ?? READINGS_TAKE,
            select: { id: true, recordedAt: true, value: true, unit: true },
        });
    });
}

// ─── Public token-gated ingestion ──────────────────────────────────

export interface IngestResult {
    streamId: string;
    inserted: number;
}

/**
 * Ingest a batch of readings against a stream, gated by a raw ingest
 * token. NO user RequestContext — the device authenticates with the
 * token alone.
 *
 * Flow: hash the raw token → look up the stream by id (global prisma,
 * pre-tenant) → constant-time compare the stored hash → resolve the
 * stream's tenantId → `createMany` the readings under
 * `runWithAuditContext` bound to that tenant. Any mismatch (unknown
 * stream, no token minted, hash mismatch, disabled/deleted stream)
 * throws `DataStreamAccessDenied`, which the route maps to a vague 401.
 */
export async function ingestReadings(
    streamId: string,
    rawToken: string | null | undefined,
    readings: IngestReading[],
): Promise<IngestResult> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) {
        throw new DataStreamAccessDenied();
    }

    const stream = await prisma.dataStream.findUnique({
        where: { id: streamId },
        select: { id: true, tenantId: true, status: true, deletedAt: true, ingestTokenHash: true, unit: true },
    });
    // Uniform denial for every "can't ingest" reason — no oracle.
    if (
        !stream ||
        !stream.ingestTokenHash ||
        stream.deletedAt !== null ||
        stream.status !== 'ACTIVE'
    ) {
        throw new DataStreamAccessDenied();
    }

    const presented = hashIngestToken(rawToken);
    if (!constantTimeEquals(presented, stream.ingestTokenHash)) {
        throw new DataStreamAccessDenied();
    }

    const tenantId = stream.tenantId;
    const rows = readings.map((r) => ({
        tenantId,
        dataStreamId: stream.id,
        recordedAt: new Date(r.recordedAt),
        value: r.value,
        unit: r.unit ? r.unit.slice(0, 32) : stream.unit ?? null,
    }));

    return runWithAuditContext(
        {
            tenantId,
            actorUserId: 'data-stream-device',
            requestId: `data-stream-ingest:${stream.id}`,
        },
        async () => {
            const inserted = await prisma.dataStreamReading.createMany({ data: rows });
            logger.info('data-stream: readings ingested', {
                component: 'data-stream',
                tenantId,
                streamId: stream.id,
                count: inserted.count,
            });
            return { streamId: stream.id, inserted: inserted.count };
        },
    );
}
