import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createInsuranceLead, listInquiredParcelIds } from '@/app-layer/usecases/insurance';
import { CreateInsuranceLeadSchema } from '@/app-layer/schemas/insurance.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { EXCHANGE_INQUIRY_LIMIT } from '@/lib/security/rate-limit-middleware';
import { codedBadRequest } from '@/lib/errors/types';

/**
 * Bound the client's `Idempotency-Key` before it reaches a WHERE clause.
 *
 * It is attacker-controlled text used as a lookup key, so it gets a length cap
 * and a character allowlist rather than being trusted. 128 matches the
 * ExchangeMessage precedent.
 */
function readIdempotencyKey(req: NextRequest): string | null {
    const raw = req.headers.get('Idempotency-Key');
    if (raw === null) return null;
    if (raw.length > 128 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
        throw codedBadRequest(
            'IDEMPOTENCY_KEY_INVALID',
            'That request key is not valid.',
        );
    }
    return raw;
}

/**
 * Insurance quote leads (#13) — POST an "Ask for offer" request for a parcel.
 * The usecase persists the lead then writes a best-effort confirmation
 * notification. Lead-gen only.
 */
/**
 * Which parcels has this tenant already asked about?
 *
 * The read that did not exist. Without it the Risk page recorded "sent" in
 * component-local `useState`, which dies on unmount — so navigating away and
 * back re-enabled a button whose POST the database refuses with a 409
 * (`@@unique([parcelId, inquirerTenantId])`). The operator retyped a quote
 * request and was told off for it.
 *
 * Returns ids only. `jsonWithETag` per the cold-start convention — this is a
 * small, rarely-changing list a phone re-reads on every visit to the page.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const parcelIds = await listInquiredParcelIds(ctx);
        return jsonWithETag(req, { parcelIds });
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateInsuranceLeadSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const lead = await createInsuranceLead(
                ctx,
                {
                    parcelId: body.parcelId,
                    locationId: body.locationId ?? null,
                    message: body.message,
                    risk: body.risk ?? null,
                    quote: body.quote,
                },
                readIdempotencyKey(req),
            );
            // The SERVER's figures travel back, so the client shows the
            // authoritative number rather than the one it guessed. A replay
            // answers 201 with the ORIGINAL lead in this same shape.
            const quote = lead.quoteJson as {
                premiumCents: number;
                instalmentsCents: number[];
                tariffBp: number;
                engineVersion: number;
            } | null;
            return jsonResponse(
                {
                    id: lead.id,
                    status: lead.status,
                    ...(quote
                        ? {
                              quote: {
                                  premiumCents: quote.premiumCents,
                                  instalmentsCents: quote.instalmentsCents,
                                  tariffBp: quote.tariffBp,
                                  engineVersion: quote.engineVersion,
                              },
                          }
                        : {}),
                },
                { status: 201 },
            );
        },
    ),
    { rateLimit: { config: EXCHANGE_INQUIRY_LIMIT, scope: 'insurance-lead' } },
);
