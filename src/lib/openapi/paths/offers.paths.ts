/**
 * «Оферти» — the farmer-facing supplier promotions feed and its lead (#2725).
 *
 * Documented because the phone builds its client from `openapi.json` and
 * neither route was in it: the list did not exist at all (the web page is a
 * server component calling the usecase directly), and `offers/leads` shipped
 * with #12, before the rule that a new path is described.
 *
 * Both are tenant-scoped although `Promotion` is one GLOBAL catalogue, because
 * the CALLER is a farm member — and `hasRequested` is viewer-relative, so the
 * tenant is load-bearing for the payload and not only for the gate.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const PromotionSchema = z
    .object({
        id: z.string(),
        company: z.string().openapi({
            description: 'The supplier’s name as curated in `Company`, not as typed on a leaflet.',
        }),
        title: z.string(),
        body: z.string().nullable().openapi({
            description:
                'PLAIN TEXT, never HTML. Written through `sanitizePlainText` on both the create and '
                + 'the update, and the web renders it as text. Render it as text.',
        }),
        mediaUrl: z.string().nullable().openapi({
            description:
                'ROOT-RELATIVE, always — `/api/promotions/{id}/image` — or null when no image was '
                + 'uploaded.\n\n'
                + '`promotionImageServeUrl` is its only producer, and the field is absent from both '
                + 'write schemas, so an operator cannot set an off-site URL. That matters to a native '
                + 'client specifically: it fetches this with the person’s bearer, and an external URL '
                + 'would carry that credential to a third party. **If an external image is ever '
                + 'allowed it must be proxied through that route rather than served as an absolute '
                + 'URL here.**',
        }),
        category: z.string().openapi({
            description:
                'One of `culture`, `fertilizer`, `seeds`, `products`, `service`. A `String` column '
                + 'validated against that curated set on write, so an unknown value means somebody '
                + 'wrote past the schema — render it as "other" rather than failing the decode.',
        }),
        ctaUrl: z.string().nullable(),
        validFrom: z.string().nullable().openapi({
            example: '2026-11-02',
            description:
                'The campaign’s FIRST day, `YYYY-MM-DD`. See `validTo` for why this is a day and not '
                + 'an instant.',
        }),
        validTo: z.string().nullable().openapi({
            example: '2026-11-30',
            description:
                'The campaign’s LAST day, `YYYY-MM-DD`, **inclusive**.\n\n'
                + 'A day rather than an instant because a campaign window is a pair of days in the '
                + 'operator’s head; an instant on the wire makes every client decide which day it '
                + 'means and they will not all agree. Taken in the FARM timezone, which is the zone '
                + 'the web renders in, so this value and the web page always name the same day — a '
                + 'UTC day-key would be one day earlier, because the console’s picker writes local '
                + 'midnight.',
        }),
        hasRequested: z.boolean().openapi({
            description:
                'Has the VIEWING FARM already sent a lead for this promotion? Viewer-relative, and '
                + 'it exists because `@@unique([promotionId, inquirerTenantId])` makes a second lead '
                + 'impossible — without it the UI invites someone to retype a message the database '
                + 'will refuse. Gate the «Поискай оферта» control on `!hasRequested`.',
        }),
    })
    .openapi('Promotion');

const OffersResponseSchema = z
    .object({ offers: z.array(PromotionSchema) })
    .openapi('OffersResponse');

const CreateLeadSchema = z.object({
    promotionId: z.string().min(1),
    message: z.string().min(1).max(2000).openapi({
        description: 'What the farmer wants to ask the supplier. 1–2000 characters.',
    }),
    consent: z.literal(true).openapi({
        description:
            'Explicit consent to pass the request to the supplier. **Must be literally `true`** — '
            + 'absent or `false` is a schema refusal (400) at the edge, deliberately, rather than '
            + 'something the usecase has to remember to check. `PromotionLead.consentedAt` is NOT '
            + 'NULL for the same reason: a lead without recorded consent is one we may not lawfully '
            + 'forward, so the column is the enforcement point and not a flag. Collect it as an '
            + 'explicit tick, cleared whenever the form closes.',
    }),
});

const LeadResponseSchema = z
    .object({ id: z.string(), status: z.string() })
    .openapi('PromotionLeadCreated');

export function registerOffersPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/offers',
        operationId: 'listOffers',
        summary: 'The supplier promotions a farm can see',
        description:
            'Published promotions whose campaign window is open, newest first.\n\n'
            + 'An ENVELOPE — `{ offers }` — so a later `nextCursor` or feed-level note does not break '
            + 'a decode already shipped on devices.\n\n'
            + '**Both gates are applied, not just publication.** A row appears only when '
            + '`publishedAt` is set AND `validFrom` has passed AND `validTo` has not. The same '
            + 'predicate decides whether `offers/leads` will accept a request, so a card from this '
            + 'feed is a card the lead route will take — until the window closes under it.\n\n'
            + 'Returns a weak ETag and honours `If-None-Match`: this path is on the client’s '
            + 'persistent cache allowlist, so a relaunch revalidates and should cost a 304 rather '
            + 'than the body.\n\n'
            + '`assertCanRead`, so a READER sees the feed. Sending a lead needs write permission — '
            + 'see the sibling operation; the two gates differ deliberately.',
        tags: ['Promotions'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The feed. An empty `offers` array when nothing is published.',
            schema: OffersResponseSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/offers/leads',
        operationId: 'createOfferLead',
        summary: 'Ask a supplier for an offer',
        description:
            'Records the farm’s request and forwards it to the supplier.\n\n'
            + '**One lead per farm per promotion**, enforced by '
            + '`@@unique([promotionId, inquirerTenantId])`. Read `hasRequested` on the feed and gate '
            + 'the control on it rather than discovering the 409.\n\n'
            + '**Needs WRITE permission**, unlike the feed. Owner ruling 2026-11-02: owners, admins '
            + 'and members ask suppliers on the farm’s behalf; a Читател sees offers and does not '
            + 'ask. Gate the control on write permission rather than letting someone compose a '
            + 'message and be refused.\n\n'
            + 'The message is stored encrypted under the INQUIRING farm’s key and is destined for a '
            + 'third party, which is why consent is a column rather than a checkbox.',
        tags: ['Promotions'],
        params: TenantParams,
        body: CreateLeadSchema,
        success: {
            status: 201,
            description: 'The lead was recorded and the supplier notified.',
            schema: LeadResponseSchema,
        },
        extraResponses: {
            403: {
                description:
                    '`WRITE_FORBIDDEN_FOR_ROLE` — a READER or MECHANISATOR. A role refusal rather '
                    + 'than an error: the feed is readable by both and asking is not.',
            },
            404: {
                description:
                    'TWO distinct codes, and they mean different things.\n\n'
                    + '`PROMOTION_NOT_FOUND` — no promotion exists under that id.\n\n'
                    + '`PROMOTION_NOT_AVAILABLE` — it exists and is no longer running: withdrawn, '
                    + 'not yet started, or past its last day. The expected case for a card held in '
                    + 'a client cache, so show «Тази оферта вече не е активна» and refresh the feed '
                    + 'rather than reporting a missing record. These were ONE uncoded 404 until '
                    + '#2725; separating them leaks nothing, because `Promotion` is a global '
                    + 'catalogue every farm sees identically.',
            },
            409: {
                description:
                    '`PROMOTION_LEAD_ALREADY_SENT` — this farm has already asked about this '
                    + 'promotion.\n\n'
                    + '**NOT a stale-edit 409.** There is no version to re-read and nothing to '
                    + 'merge: the row already exists and a second one is impossible by '
                    + '`@@unique([promotionId, inquirerTenantId])`. Re-reading the feed is still '
                    + 'the right response, because `hasRequested` will come back true and the '
                    + 'control should then be hidden rather than retried.',
            },
        },
    });
}
