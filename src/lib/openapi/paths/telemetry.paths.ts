/**
 * Product-usage telemetry ingest — #493.
 *
 * One route. The contract matters more than its size, because an iOS client
 * builds a closed enum against it and a name that drifts here is a measurement
 * that silently stops arriving.
 */
import { RecordUsageEventsSchema } from '@/app-layer/usecases/usage-events';
import {
    MAX_USAGE_EVENTS_PER_BATCH,
    USAGE_EVENT_NAMES,
    USAGE_EVENT_RETENTION_DAYS,
    USAGE_SURFACES,
} from '@/app-layer/telemetry/usage-events';
import { codedErrorResponses, op } from './helpers';
import { z } from '../zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerTelemetryPaths(registry: OpenAPIRegistry) {
    const TenantParams = z.object({
        tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/usage-events',
        operationId: 'recordUsageEvents',
        summary: 'Record a batch of product-usage events',
        description:
            'First-party product analytics — screen opens and key actions. No third-party ' +
            'analytics is involved.\n\n' +
            `Send at most ${MAX_USAGE_EVENTS_PER_BATCH} events per batch. Answers **204 with no ` +
            'body**, deliberately: a client must not branch on what telemetry replied, and ' +
            'parsing a body invites exactly that.\n\n' +
            '**Unknown names are DROPPED, never refused.** A shipped build cannot be recalled, so ' +
            'retiring a name here must not start failing requests — and telemetry must never ' +
            'break the product it measures. A batch containing unknown names still answers 204; ' +
            'the unknown ones are simply not stored, and the drop COUNT is logged server-side so ' +
            'client drift stays visible.\n\n' +
            '**Treat every non-2xx as a no-op.** Never surface a telemetry failure to a user, ' +
            'never block a screen on it, never retry aggressively. Drop the batch and move on.\n\n' +
            '`tenantId` and `userId` come from the SESSION. Sending either in the body has it ' +
            'silently STRIPPED rather than rejected, so an error can never teach a caller that ' +
            'the field exists.\n\n' +
            '`at` is the client’s clock and is **advisory**: it is clamped to now if it is in ' +
            'the future or more than 48h old, because a phone left in a vehicle reports a past ' +
            'that never happened. The server stamps `receivedAt` and every count groups by that. ' +
            'Clamped rather than rejected — discarding it would bias the data toward people ' +
            'with correct clocks.\n\n' +
            'Gated on the `usage.events` feature flag, **default OFF**; expect 403 until an ' +
            'operator enables it, which is the normal state rather than a fault. The resolved ' +
            'flag is also returned by `GET /api/auth/me` under `featureFlags`, so a client should ' +
            'check it and record nothing while it is false rather than learning from a refusal. ' +
            'An ABSENT key means off.\n\n' +
            'Rate-limited in its OWN bucket (30 requests/min per IP+user), deliberately not the ' +
            'shared mutation budget — on that budget a looping telemetry client would consume ' +
            'the allowance a farmer’s journal write needs, putting the failure on the field ' +
            `record instead of on the measurement.\n\n` +
            `**Retention: ${USAGE_EVENT_RETENTION_DAYS} days**, swept daily. This is Product ` +
            'Interaction data LINKED to the user, so declare it that way in App Privacy — ' +
            'linked to the user, NOT used for tracking.\n\n' +
            `**The ${USAGE_EVENT_NAMES.length} accepted names:** \`${USAGE_EVENT_NAMES.join('`, `')}\`.\n\n` +
            `**The ${USAGE_SURFACES.length} accepted surfaces**, for \`screen_opened\` only (sent ` +
            `on any other name, \`surface\` is discarded): \`${USAGE_SURFACES.join('`, `')}\`.\n\n` +
            'A surface must be one of those STATIC values. A parameterised route such as ' +
            '`/locations/{id}` is a screen plus a farm record identifier and is dropped — the ' +
            'vocabulary is a closed union precisely so a record id, a crop or a parcel cannot ' +
            'reach this table by way of a client that means well.',
        tags: ['Telemetry'],
        params: TenantParams,
        // The REAL schema the route validates against, not a restatement of it.
        // A second copy here would drift, and the drift would be invisible: the
        // spec would describe a body the server refuses.
        body: RecordUsageEventsSchema,
        success: { status: 204, description: 'Accepted. No body, ever.' },
        extraResponses: codedErrorResponses({
            400:
                'The BATCH is malformed — which is a different failure from an unknown event '
                + 'NAME inside a well-formed batch, and gets a different answer. '
                + '`USAGE_EVENTS_INVALID_BODY` — the request body is not JSON at all. '
                + '`USAGE_EVENTS_INVALID_BATCH` — it is JSON but not the documented shape: no '
                + '`events` array, an empty one, more than the per-batch maximum, or an entry '
                + 'missing `name` or `at`. Both are client bugs worth naming, unlike an unknown '
                + 'name, which is drift and is dropped silently with a 204.',
        }),
    });
}
