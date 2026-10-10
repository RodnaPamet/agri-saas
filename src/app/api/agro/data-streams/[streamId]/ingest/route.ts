/**
 * POST /api/agro/data-streams/[streamId]/ingest
 *
 * PUBLIC, token-gated, NO session. Device-facing reading ingestion for
 * the Agro-intel data-stream feature.
 *
 * Body:
 *   {
 *     token: string,                       // raw ingest token from createDataStream
 *     readings: [{ recordedAt, value, unit? }]   // max ~1000
 *   }
 *
 * `recordedAt` must be a real RFC 3339 instant — `Z` or an explicit offset
 * such as `+03:00`. A date-only value or a space-separated datetime is
 * REFUSED with a 400, because without a zone the consumer's `new Date` reads
 * it in the server's timezone and the same payload would store a different
 * instant depending on where the server runs. For a sensor feed that is
 * silent corruption, so this endpoint is stricter than the tenant-UI schemas
 * (#1539). The check is `instantTimestamp()`, shared with this route's
 * declaration in `src/lib/openapi/paths/agro.paths.ts` so the published
 * `format: date-time` and the executing check cannot drift apart.
 *
 * Gating:
 *   • Feature flag — AGRO_DATASTREAMS_ENABLED must be '1', else 503
 *     `{ error: 'feature_disabled' }` (operator opts in before exposing).
 *   • Token — SHA-256(token) is constant-time compared to the stream's
 *     `ingestTokenHash` inside `ingestReadings`. Tenant is resolved from
 *     the matched stream row. Any mismatch → vague 401 (anti-enumeration),
 *     so probing stream ids without a valid token yields no oracle.
 *
 * Bare route (the standard API error-handler wrapper is intentionally
 * NOT used) — the custom { error } shapes and the uniform 401 are the
 * contract; registered in `src/lib/errors/route-exemptions.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/env';
import { ingestReadings, DataStreamAccessDenied } from '@/app-layer/usecases/data-stream';
import { instantTimestamp } from '@/lib/schemas/timestamp';

const IngestBodySchema = z
    .object({
        token: z.string().min(16).max(512),
        readings: z
            .array(
                z.object({
                    recordedAt: instantTimestamp(),
                    value: z.number().finite(),
                    unit: z.string().max(32).nullable().optional(),
                }),
            )
            .min(1)
            .max(1000),
    })
    .strip();

export async function POST(
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ streamId: string }> },
) {
    // ── Feature flag ──
    if (env.AGRO_DATASTREAMS_ENABLED !== '1') {
        return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
    }

    const params = await paramsPromise;

    let body: z.infer<typeof IngestBodySchema>;
    try {
        body = IngestBodySchema.parse(await req.json());
    } catch (err) {
        return NextResponse.json(
            { error: 'invalid_body', issues: (err as { issues?: unknown }).issues },
            { status: 400 },
        );
    }

    try {
        const result = await ingestReadings(params.streamId, body.token, body.readings);
        return NextResponse.json({ status: 'ok', inserted: result.inserted });
    } catch (err) {
        if (err instanceof DataStreamAccessDenied) {
            // Uniform 401 — never leak which gate tripped (unknown stream,
            // disabled stream, bad token all collapse here).
            return NextResponse.json({ error: 'access_denied' }, { status: 401 });
        }
        throw err;
    }
}
