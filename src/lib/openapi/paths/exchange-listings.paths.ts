/**
 * Борса — the listings marketplace and the inquiry flow.
 *
 * `exchange-messaging.paths.ts` documented the THREAD side and stopped there,
 * so the exchange tag described how two parties talk without describing what
 * they talk about. These five routes are the marketplace itself, and Борса is
 * one of five tabs on the phone.
 *
 * ── this is the mapper's shape, not a new one ──
 *
 * Every listing on the wire goes through `toPublicListing` and every inquiry
 * through `toPublicInquiry`, both in `@/lib/exchange/public-listing`. One
 * mapper per shape, so the schemas below are written against it rather than
 * beside it. Request bodies are the routes' OWN Zod schemas, imported from
 * `@/app-layer/schemas/exchange.schemas`.
 *
 * ── three things a client gets wrong if nobody says them ──
 *
 * **1. `quantityTonnes` and `pricePerTonne` are DECIMAL STRINGS.** They are
 * quantity and money. A client that parses them into a double has undone the
 * reason they are strings, and the error is silent until a tonnage stops
 * round-tripping.
 *
 * **2. `ExchangePublicInquiry.listing` is OPTIONAL, and its absence is a
 * PLACE, not a missing value.** It is attached in the buyer's outbox
 * (`GET /exchange/inquiries`) and deliberately omitted in the seller's
 * per-listing nest (`GET /exchange/my-listings`), where the listing is already
 * the row above. A client declaring it non-optional decodes the buyer's view
 * and fails the seller's ENTIRELY — these are arrays, so one absent key takes
 * the whole response with it. That is exactly how a required `variant` against
 * an optional field took out the calculator on the native client.
 *
 * **3. `counterpartyContact` is a CONSENT GATE, not a field that happens to be
 * null.** It is null until the seller accepts, and null forever on decline.
 * `contactSharedAt` says when the two-sided consent completed. Neither is a
 * value to retry for, and neither should be rendered as "no contact given".
 *
 * ── two envelopes and two bare arrays, deliberately different ──
 *
 *   GET /exchange/listings      -> { rows, nextCursor }   keyset-paginated
 *   GET /exchange/my-listings   -> [ ... ]                BARE ARRAY
 *   GET /exchange/inquiries     -> [ ... ]                BARE ARRAY
 *
 * The bare arrays are the seller's own listings and the buyer's own outbox —
 * both bounded by what one tenant created, neither paginated. Documented as
 * they are rather than normalised, because changing a response shape for
 * symmetry breaks a client that exists.
 */
import { z } from '@/lib/openapi/zod';
import {
    CreateListingSchema,
    CreateInquirySchema,
    RespondToInquirySchema,
    UpdateListingStatusSchema,
} from '@/app-layer/schemas/exchange.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const ListingParams = TenantParams.extend({
    listingId: z.string().openapi({ param: { name: 'listingId', in: 'path' } }),
});
const InquiryParams = TenantParams.extend({
    inquiryId: z.string().openapi({ param: { name: 'inquiryId', in: 'path' } }),
});

const PublicListingSchema = z
    .object({
        id: z.string(),
        side: z.enum(['SELL', 'BUY']),
        kind: z.enum(['CULTURE', 'FERTILIZER', 'SEEDS', 'PRODUCT']),
        /** Free text — a seller types it, so it is NOT the canonical vocabulary. */
        commodity: z.string(),
        /** Tonnes as an exact DECIMAL STRING. Never parse as a float. */
        quantityTonnes: z.string(),
        /** Per tonne, decimal STRING, or null when the seller omitted a price. */
        pricePerTonne: z.string().nullable(),
        priceCurrency: z.string(),
        regionCode: z.string(),
        regionName: z.string(),
        lat: z.number(),
        lon: z.number(),
        description: z.string().nullable(),
        /** Null when the seller has no display name resolved. */
        sellerDisplayName: z.string().nullable(),
        status: z.string(),
        createdAt: z.string().datetime(),
        expiresAt: z.string().datetime().nullable(),
        /**
         * True when the VIEWING tenant owns this listing. Viewer-dependent, so
         * the same listing differs between two callers — it cannot be cached
         * across tenants.
         */
        isOwn: z.boolean(),
    })
    .openapi('ExchangeListing', {
        description:
            'A marketplace listing, in the projection every tenant sees. quantityTonnes and pricePerTonne are exact decimal STRINGS — they are quantity and money and must not be parsed as floats. isOwn is computed for the VIEWING tenant, so this projection is not shareable between callers.',
    });

const PublicInquirySchema = z
    .object({
        id: z.string(),
        message: z.string(),
        /** Decimal STRING, or null when the buyer named no quantity. */
        quantityTonnes: z.string().nullable(),
        status: z.string(),
        createdAt: z.string().datetime(),
        /**
         * The COUNTERPARTY's contact — the buyer sees the seller's, the seller
         * sees the buyer's. A CONSENT GATE: null until the seller accepts, and
         * null forever on decline. Not a value to retry for, and not "no
         * contact given".
         */
        counterpartyContact: z.string().nullable(),
        /** When two-sided consent completed. Null until then. */
        contactSharedAt: z.string().datetime().nullable(),
        /**
         * ATTACHED in the buyer's outbox; ABSENT in the seller's per-listing
         * nest, where the listing is the row above. Absent means "not sent
         * here", never "this inquiry has no listing".
         */
        listing: PublicListingSchema.optional(),
    })
    .openapi('ExchangeInquiry', {
        description:
            'An inquiry against a listing. No inquirer ids ever reach the wire. counterpartyContact and contactSharedAt are a two-sided consent gate rather than ordinary nullable fields: null means consent has not completed, and on a declined inquiry it never will. The listing key is present in the buyer’s outbox and omitted in the seller’s nest — absent, not null.',
    });

const MyListingSchema = PublicListingSchema.extend({
    /** The seller's own inbox for this listing, nested. Never paginated. */
    inquiries: z.array(PublicInquirySchema),
}).openapi('ExchangeMyListing', {
    description:
        'A listing the calling tenant owns, with its inquiries nested. The nested inquiries omit their `listing` key, because this row is it.',
});

/** The shape both status mutations answer with. */
const StatusAckSchema = z
    .object({ id: z.string(), status: z.string() })
    .openapi('ExchangeStatusAck', {
        description:
            'A status transition acknowledgement. Deliberately NOT the full object: the caller already holds it and the transition is the only thing that changed.',
    });

export function registerExchangeListingPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/listings',
        operationId: 'listExchangeListings',
        summary: 'Browse active listings',
        description:
            'The active marketplace, keyset-paginated. Page size defaults to 50 and is capped at 100; pass `cursor` back VERBATIM from `nextCursor` and stop when it is null. ' +
            '\n\n`side`, `kind`, `commodity` and `region` are COMMA-SEPARATED multi-value params in ONE parameter (`?side=SELL&kind=CULTURE,SEEDS`) — a multi-select facet arrives joined, and a bad member is a clean 400 rather than a 500. `commodity` is opaque free text, not an enum: a seller types it on the create form. ' +
            '\n\n`q` also matches Bulgarian oblast NAMES against stored English region names, so «Пловдив» finds a listing whose `regionName` is "Plovdiv". ' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**.',
        tags: ['Exchange'],
        params: TenantParams,
        query: z.object({
            side: z.string().optional().openapi({ description: 'CSV of SELL,BUY' }),
            kind: z.string().optional().openapi({ description: 'CSV of CULTURE,FERTILIZER,SEEDS,PRODUCT' }),
            commodity: z.string().optional().openapi({ description: 'CSV of free-text commodity names' }),
            region: z.string().optional().openapi({ description: 'CSV of region codes' }),
            minTonnes: z.coerce.number().optional(),
            maxTonnes: z.coerce.number().optional(),
            q: z.string().optional().openapi({ description: 'Free text; also matches oblast names.' }),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().optional().openapi({ description: 'Opaque. Pass back verbatim.' }),
        }),
        success: {
            status: 200,
            description: 'A page of active listings. `nextCursor` is null on the last page.',
            schema: z.object({
                rows: z.array(PublicListingSchema),
                nextCursor: z.string().nullable(),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/listings',
        operationId: 'createExchangeListing',
        summary: 'Publish a listing',
        description:
            'Publishes a listing for the calling tenant. Requires the EXCHANGE module — 403 `module_disabled: EXCHANGE` otherwise. Rate-limited separately from ordinary writes.',
        tags: ['Exchange'],
        params: TenantParams,
        body: CreateListingSchema,
        success: { status: 201, description: 'The created listing.', schema: PublicListingSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/my-listings',
        operationId: 'listMyExchangeListings',
        summary: 'The calling tenant’s own listings, with their inquiries',
        description:
            'The seller’s view: every listing this tenant owns, each with its inquiries nested. A BARE ARRAY, not an envelope, and not paginated — it is bounded by what one tenant created. ' +
            '\n\nThe nested inquiries OMIT their `listing` key, because the row carrying them is it.',
        tags: ['Exchange'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The tenant’s listings. Empty array when it has published none.',
            schema: z.array(MyListingSchema),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/listings/{listingId}',
        operationId: 'getExchangeListing',
        summary: 'One listing',
        tags: ['Exchange'],
        params: ListingParams,
        success: { status: 200, description: 'The listing.', schema: PublicListingSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/exchange/listings/{listingId}',
        operationId: 'updateExchangeListingStatus',
        summary: 'Withdraw or fulfil a listing',
        description:
            'Moves a listing the caller OWNS to WITHDRAWN or FULFILLED. Answers with the id and the new status only — the caller already holds the rest, and the transition is what changed.',
        tags: ['Exchange'],
        params: ListingParams,
        body: UpdateListingStatusSchema,
        success: { status: 200, description: 'The new status.', schema: StatusAckSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/inquiries',
        operationId: 'listMyExchangeInquiries',
        summary: 'The calling tenant’s outbox',
        description:
            'Inquiries this tenant has SENT, each with the listing it was sent about attached. A BARE ARRAY, not an envelope, and not paginated. ' +
            '\n\nThis is the view where `listing` IS present — the seller’s nest omits it.',
        tags: ['Exchange'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The buyer’s outbox. Empty array when it has sent none.',
            schema: z.array(PublicInquirySchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/exchange/inquiries',
        operationId: 'createExchangeInquiry',
        summary: 'Enquire about a listing',
        description:
            'Sends an inquiry to a listing’s seller. Answers with the id and status ONLY — not the inquiry projection — because the buyer’s contact has not been shared yet and the reveal gate lives in that projection. ' +
            '\n\nThe seller is notified; contact details are exchanged only if they ACCEPT.',
        tags: ['Exchange'],
        params: TenantParams,
        body: CreateInquirySchema,
        success: { status: 201, description: 'The created inquiry’s id and status.', schema: StatusAckSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/exchange/inquiries/{inquiryId}',
        operationId: 'respondToExchangeInquiry',
        summary: 'Accept or decline an inquiry',
        description:
            'The SELLER’s decision on an inquiry against their own listing. ACCEPTED completes the two-sided consent and is what populates `counterpartyContact` and `contactSharedAt` on both sides; DECLINED leaves both null permanently. ' +
            '\n\nAnswers with the id and new status only.',
        tags: ['Exchange'],
        params: InquiryParams,
        body: RespondToInquirySchema,
        success: { status: 200, description: 'The new status.', schema: StatusAckSchema },
    });
}
