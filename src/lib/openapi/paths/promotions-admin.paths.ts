/**
 * The promotions console's leaflet read — `/admin/promotions/leaflet-scan`
 * (#2664).
 *
 * Documented because `openapi-paths-complete`'s baseline only SHRINKS, and
 * because the two things a reader most needs to know are not visible from the
 * shapes: that this creates no promotion, and that it will not tell you
 * whether the promoted product is a plant protection product.
 *
 * Its sibling `admin/promotions` routes predate that rule and sit on the
 * baseline. This one is new, so it is described.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

const OfferDraftSchema = z
    .object({
        productName: z.string(),
        priceText: z.string().nullable().openapi({
            description:
                'The price EXACTLY as printed, including its unit and any condition — "от 1 200 лв./т", '
                + '"-15% до изчерпване". A STRING and never a number: a leaflet price is routinely '
                + 'conditional, and a bare figure loses the condition that makes it true.',
        }),
        validityText: z.string().nullable(),
        note: z.string().nullable(),
    })
    .openapi('PromotionOfferDraft');

const LeafletScanResultSchema = z
    .object({
        fileId: z.string().openapi({
            description:
                'The stored leaflet. Attach it to the promotion the operator then creates, so the '
                + 'source document stays reachable from the row.',
        }),
        companyName: z.string().nullable().openapi({
            description:
                'As printed on the leaflet, for the operator to match against `Company`. NOT resolved '
                + 'to a `companyId`: a near-match on a trading company name is the operator’s call.',
        }),
        offers: z.array(OfferDraftSchema),
        unreadableOfferCount: z.number().int().openapi({
            description:
                'Offers the model SAW and could not read. Surfaced rather than swallowed — a six-offer '
                + 'leaflet read as four is otherwise indistinguishable from a four-offer leaflet, and '
                + 'only the operator can open the PDF and check.',
        }),
    })
    .openapi('PromotionLeafletScanResult');

export function registerPromotionsAdminPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/promotions/leaflet-scan',
        operationId: 'scanPromotionLeaflet',
        summary: 'Read a supplier leaflet and propose its offers',
        description:
            'Upload a trading company’s promotion leaflet as it came — PDF or a photo — and get its '
            + 'offers back as a PROPOSAL.\n\n'
            + '**It creates no promotion.** `POST /admin/promotions` writes the row and publishing is '
            + 'a further deliberate action, because a misread price or end date would be repeated to '
            + 'farmers as fact by the assistant. Same ruling as `grain/costs/invoice-scan`, which '
            + 'creates no cost entry.\n\n'
            + '**It does not propose `pppRegistrationNo`.** That field decides whether Reg. (EC) '
            + '1107/2009 Art 66 applies to a promotion — prescribed safety wording, prohibited claim '
            + 'types — so it is set by the owner at review time against the БАБХ register. The read '
            + 'has no slot for it at all rather than a slot that is ignored: a misread registration '
            + 'number would silently reclassify a pesticide as a fertiliser.\n\n'
            + '`multipart/form-data` with one `file` field. Two gates: `admin.manage` AND the '
            + 'platform-support tenant, so this 404s everywhere else.\n\n'
            + 'Node runtime, 60s budget — a whole PDF goes to the model.',
        tags: ['Promotions'],
        // `bodyContentType`, not a hand-built `request.content`: the helper
        // has the field precisely because not every write here takes JSON, and
        // declaring a multipart upload as JSON would be a documented lie a
        // generated client cannot upload through.
        bodyContentType: 'multipart/form-data',
        body: z.object({
            file: z.string().openapi({
                format: 'binary',
                description: 'The leaflet as the trading company sent it: PDF, JPEG, PNG, GIF or WebP.',
            }),
        }),
        success: {
            status: 200,
            description:
                'The proposal. 200 and not 201: the only row created is the stored file, and the '
                + 'promotion a 201 would point at deliberately does not exist yet.',
            schema: LeafletScanResultSchema,
        },
        extraResponses: {
            400: {
                description:
                    '`LEAFLET_SCAN_INPUT_MISSING` — the request was not '
                    + '`multipart/form-data`, or carried no `file` field holding a real file. A '
                    + 'field sent as TEXT counts as absent rather than being coerced, so the '
                    + 'refusal names the real problem instead of failing later on empty bytes.',
            },
            415: {
                description:
                    '`LEAFLET_MEDIA_UNSUPPORTED` — the file is STORED and cannot be read '
                    + 'automatically. A workbook lands here: the owner asked to accept Excel and '
                    + 'there is no spreadsheet block in the Messages API, so the honest answer is '
                    + '"stored, type the offers in" rather than an empty read that would look '
                    + 'exactly like a leaflet with no offers on it. Carries `leafletFileId`.',
            },
            422: {
                description:
                    '`LEAFLET_NOT_RECOGNISED` — the model answered and the answer was unusable, or '
                    + 'the document is not a leaflet. ONE code, because the remedy is the same: the '
                    + 'file is stored, type the offers in. Carries `leafletFileId`.',
            },
            503: {
                description:
                    '`LEAFLET_READER_UNAVAILABLE` when the deployment has no model key, or '
                    + '`PLATFORM_AI_BUDGET_EXCEEDED` when the month’s platform AI ceiling is spent. '
                    + 'Separate from the 422 on purpose: these say "try later or change a setting", '
                    + 'not "retype a leaflet that would have read perfectly tomorrow".',
            },
        },
    });
}
