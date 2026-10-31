/**
 * Борса — the listings exchange and the inquiry flow.
 *
 * `exchange-messaging.paths.ts` documented the THREAD side and stopped there,
 * so the exchange tag described how two parties talk without describing what
 * they talk about. These five routes are the exchange itself, and Борса is
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
    UpdateListingStatusSchema, UpdateListingSchema } from '@/app-layer/schemas/exchange.schemas';
import { ApiErrorResponseSchema } from '@/lib/dto/common';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { codedErrorResponses, op } from './helpers';

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
        /**
         * The seller's public name.
         *
         * Two sources, and a client cannot tell them apart from this field
         * alone — which is deliberate, because it should render them the same.
         * Either the free text the seller typed, or — when `farmHandle` is
         * non-null — the VERIFIED name of their published farm, resolved from
         * the farm's own profile on this read rather than copied onto the
         * listing when it was posted.
         *
         * Null when the seller typed nothing and is not attributed; render
         * your own "anonymous farm" string.
         */
        sellerDisplayName: z.string().nullable(),
        /**
         * The seller's public farm address when this listing is attributed to
         * a published farm, else `null` — P6.7.
         *
         * A HANDLE, not a url: build `/f/{handle}`. When it is non-null,
         * `sellerDisplayName` is that farm's verified name and may be rendered
         * as a link to the page.
         *
         * **It can change without the listing changing.** The attribution is
         * resolved live, so a farm that renames its address or withdraws its
         * public page alters this field on every listing it had attributed, in
         * the same moment and with no write to the listing. `null` therefore
         * covers both "never attributed" and "the farm has since withdrawn",
         * and a client does not need to distinguish them: in both cases there
         * is no page to link to.
         */
        farmHandle: z.string().nullable(),
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

/**
 * The seller's own editable values, derived from the PUT's request body so the
 * two cannot drift: "send `edit` back unchanged" is a complete instruction
 * rather than a convention a client has to be told.
 *
 * TWO fields are narrowed, and only in this direction. `boundedDecimal` is
 * `z.union([z.number(), z.string()])` because a request may legitimately carry
 * a JSON number — but `toListingEdit` serialises both decimals with
 * `.toString()` unconditionally, so the RESPONSE is always a string. Left
 * shared, the spec would tell a client to decode `number | string` for a field
 * that is never a number, which is #1391's complaint exactly: a client that
 * guessed `number` would crash on every listing. The round-trip still holds in
 * the direction that matters, because the request's union ACCEPTS the
 * response's string.
 *
 * The remaining nullable fields stay as the generator renders them — `anyOf:
 * [{string}, {null}]` decodes as an optional string with no ambiguity about
 * which arrives, so there is nothing for a client to guess. A UNION OF TWO
 * PRIMITIVES is the case worth spending a narrowing on.
 */
const ListingEditSchema = UpdateListingSchema.extend({
    quantityTonnes: z.string(),
    pricePerTonne: z.string().nullable(),
}).openapi('ExchangeListingEdit', {
    description:
        "The listing's editable values AS STORED, and the exact body `PUT` accepts. `sellerDisplayName` here is the seller's TYPED alias — NOT the resolved attribution the sibling field carries, which is the farm's verified name when `publishAsFarm` is set. Echoing the resolved value into a full replacement would write a verified farm name into the alias column as literal text. `updatedAt` is a precondition, not a value: `PUT` refuses with LISTING_MODIFIED when it no longer matches.",
});

const MyListingSchema = PublicListingSchema.extend({
    /** The seller's own inbox for this listing, nested. Never paginated. */
    inquiries: z.array(PublicInquirySchema),
    /** The editable values as stored — see `ExchangeListingEdit`. */
    edit: ListingEditSchema,
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

const InquiryAlreadySentError = ApiErrorResponseSchema.openapi(
    'InquiryAlreadySentError',
    {
        description:
            'A 409 `LISTING_INTEREST_ALREADY_SENT`. One inquiry per tenant per listing — the ' +
            '`@@unique` index is the guarantee, and a P2002 from it is what raises this. ' +
            'Distinct from `STALE_DATA`: there is no version to re-read and no edit to merge, ' +
            'so a client treating every 409 as a stale edit tells the operator the wrong thing ' +
            '(#1391).',
    },
);

export function registerExchangeListingPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/listings',
        operationId: 'listExchangeListings',
        summary: 'Борса — browse active listings',
        description:
            'The active Борса feed, keyset-paginated. Page size defaults to 50 and is capped at 100; pass `cursor` back VERBATIM from `nextCursor` and stop when it is null. ' +
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
            q: z
                .string()
                .optional()
                .openapi({
                    description:
                        'Free text, matched against the commodity AND the oblast, in Bulgarian or English. ' +
                        'One field; the server decides which axis a term belongs to.' +
                        '\n\n**Prefixes work in both languages.** «пше» and `whea` both find wheat, as ' +
                        '«пшеница» and `wheat` do. The two halves get there by different routes, which is ' +
                        'worth knowing if a result ever looks asymmetric: the column stores the ENGLISH ' +
                        'slug, so an English prefix matches the stored value directly, while a Bulgarian ' +
                        'prefix is resolved against the alias vocabulary first and then matched exactly. ' +
                        'Before this, «пшеница» worked and «пше» did not.' +
                        '\n\n**Two folded characters minimum** for the prefix resolution. A single letter ' +
                        'is a keystroke on the way to a word rather than a query — «с» alone starts both ' +
                        'слънчоглед and соя — so one character resolves no commodity. Folding removes case, ' +
                        'spaces, dots and hyphens, so `Sun-Flo` is the same query as `sunflo`.' +
                        '\n\n**An ambiguous prefix returns everything it matches**, which is the answer ' +
                        'rather than an error: `so` finds both soybean and wheat (via `softwheat`). Do not ' +
                        'treat several results as a failed lookup.' +
                        '\n\n**Oblast names match on any substring**, Bulgarian or English, so «Пле» finds ' +
                        'Плевен. That axis never had the exact-match floor the commodity axis had.' +
                        '\n\nInputs the farm BUYS are deliberately unresolvable: «диз» finds nothing, ' +
                        'because the exchange does not trade diesel.',
                    example: 'пше',
                }),
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
        summary: 'Борса — publish a listing',
        description:
            'Publishes a listing for the calling tenant. Requires the EXCHANGE module — 403 `module_disabled: EXCHANGE` otherwise. Rate-limited separately from ordinary writes.\n\n'
            + '**`publishAsFarm`** attributes the listing to the seller\u2019s published farm (P6.7): the response\u2019s `sellerDisplayName` becomes that farm\u2019s verified name and `farmHandle` carries its public address. It is accepted whatever the farm\u2019s publication state and is NOT refused when the farm has no public page — the attribution is resolved on every read, so a seller who ticks it first and publishes later has every listing they already posted attributed, with nothing to back-fill. Until then the listing reads as anonymous, or as whatever `sellerDisplayName` they typed.\n\n'
            + 'The inverse holds too, and is the reason nothing is copied onto the row: withdrawing the farm\u2019s public page returns every listing it had attributed to anonymous on the next read, so no listing is left naming an address that no longer answers.',
        tags: ['Exchange'],
        params: TenantParams,
        body: CreateListingSchema,
        success: { status: 201, description: 'The created listing.', schema: PublicListingSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/my-listings',
        operationId: 'listMyExchangeListings',
        summary: 'Борса — the calling tenant’s own listings, with their inquiries',
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
        summary: 'Борса — one listing',
        tags: ['Exchange'],
        params: ListingParams,
        success: { status: 200, description: 'The listing.', schema: PublicListingSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/exchange/listings/{listingId}',
        operationId: 'updateExchangeListingStatus',
        summary: 'Борса — withdraw or fulfil a listing',
        description:
            'Moves a listing the caller OWNS to WITHDRAWN or FULFILLED. Answers with the id and the new status only — the caller already holds the rest, and the transition is what changed.\n\nRefusals carry a distinct `code`: LISTING_NOT_FOUND; LISTING_NOT_OWNED when the listing belongs to another tenant; LISTING_TERMINAL when it is already withdrawn or fulfilled, both of which are terminal; and LISTING_FULFIL_REQUIRES_ACTIVE when an EXPIRED listing is marked FULFILLED — withdraw it instead, because fulfilling asserts a transaction the marketplace has no evidence for and feeds the sold statistics. That refusal was LISTING_NOT_ACTIVE until #2564 split it: the same code also answered a buyer enquiring and a seller accepting, and one catalogue sentence cannot carry three different remedies. These were passed as the MESSAGE field until #2541, so `code` read BAD_REQUEST for both and a client could not tell them apart.',
        tags: ['Exchange'],
        params: ListingParams,
        body: UpdateListingStatusSchema,
        success: { status: 200, description: 'The new status.', schema: StatusAckSchema },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/exchange/listings/{listingId}',
        operationId: 'replaceExchangeListing',
        summary: 'Борса — edit your own listing',
        description:
            "Replaces EVERY editable field on a listing the caller owns. Owner ruling 2026-10-31: every field is editable, including side, kind and commodity.\n\nA full replacement rather than a partial patch, and the reason is the nullable fields: under a patch, \"leave the description alone\" and \"clear the description\" are the same JSON. The seller's own read carries `edit`, which is this body verbatim.\n\nA later `expiresAt` REACTIVATES an EXPIRED listing (EXPIRED → ACTIVE), keeping its conversations. `null` counts as later, because no expiry is later than any date. The plan's ACTIVE-listing limit is checked only on that transition, since an ordinary edit cannot change the count.\n\nUnlike withdraw, this REQUIRES the EXCHANGE module: that exemption exists because the toggle governs participation in the marketplace rather than custody of rows you already posted, and editing changes what is being offered.\n\nRefusals, each a distinct `code`: LISTING_NOT_FOUND; LISTING_NOT_OWNED when the listing belongs to another tenant; LISTING_TERMINAL for a withdrawn or fulfilled listing, which cannot be edited; LISTING_MODIFIED when `updatedAt` no longer matches, so a concurrent edit is refused rather than silently overwritten; LISTING_REGION_UNKNOWN for an unrecognised `regionCode`. LISTING_EXPIRES_AT_IN_PAST when a CHANGED `expiresAt` is not in the future — an UNCHANGED one is always accepted, whatever the clock says, because `edit` round-trips the date as a string and a client that does not touch it sends it back verbatim. Refusing that would reject an edit to a listing on its last day for a field nobody changed.\n\nAnswers with the listing AND its new `edit` object, so a client can render the result and repopulate the form without a second read.",
        tags: ['Exchange'],
        params: ListingParams,
        body: UpdateListingSchema,
        success: { status: 200, description: 'The updated listing.', schema: MyListingSchema },
        extraResponses: codedErrorResponses({
            409:
                'An optimistic-lock refusal, and the one status a reader of the prose above ' +
                'would not otherwise expect here.\n\n' +
                '- `LISTING_MODIFIED` — the `updatedAt` you sent no longer matches the stored ' +
                'row, so somebody edited this listing after you opened it. Re-read, re-apply ' +
                'the change and send again; it IS a stale edit, which makes it the opposite of ' +
                'this API\u2019s other exchange 409 (`LISTING_INTEREST_ALREADY_SENT`, where ' +
                're-reading cannot clear the condition).\n\n' +
                'Deliberately NOT `STALE_DATA`, the code the farm-profile, journal and ' +
                'field-operation locks use. Those carry `details.currentVersion` / ' +
                '`expectedVersion` off a version counter and are resolved by merging; this ' +
                'precondition is a TIMESTAMP, carries no `details`, and the edit is a full ' +
                'replacement, so the only remedy is to reload the form. A client keying on ' +
                '`STALE_DATA` will not match it, which is intended — the two want different ' +
                'sentences.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/exchange/inquiries',
        operationId: 'listMyExchangeInquiries',
        summary: 'Борса — the calling tenant’s outbox',
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
        summary: 'Борса — enquire about a listing',
        description:
            'Sends an inquiry to a listing’s seller. Answers with the id and status ONLY — not the inquiry projection — because the buyer’s contact has not been shared yet and the reveal gate lives in that projection. \n\nRefusals, each a distinct `code`: LISTING_NOT_FOUND; LISTING_NOT_ACTIVE when the listing has left ACTIVE; LISTING_EXPIRED when its `expiresAt` has passed, which the browse feed already filters on; LISTING_IS_YOUR_OWN when the listing belongs to the calling tenant; and INQUIRY_ALREADY_SENT. Four of these were passed as the MESSAGE field until #2543 — LISTING_IS_YOUR_OWN was correct usage but reported the generic FORBIDDEN, so no client could name it either.' +
            '\n\nThe seller is notified; contact details are exchanged only if they ACCEPT.',
        tags: ['Exchange'],
        params: TenantParams,
        body: CreateInquirySchema,
        success: { status: 201, description: 'The created inquiry’s id and status.', schema: StatusAckSchema },
        extraResponses: {
            409: {
                description:
                    '`LISTING_INTEREST_ALREADY_SENT` — this tenant has already enquired about ' +
                    'this listing. One inquiry per tenant per listing, on a unique index, so it ' +
                    'is NOT a stale edit and re-reading will not clear it: the inquiry already ' +
                    'exists and the seller already has it. Show the existing thread rather than ' +
                    'offering to send again.',
                content: { 'application/json': { schema: InquiryAlreadySentError } },
            },
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/exchange/inquiries/{inquiryId}',
        operationId: 'respondToExchangeInquiry',
        summary: 'Борса — accept or decline an inquiry',
        description:
            'The SELLER’s decision on an inquiry against their own listing. ACCEPTED completes the two-sided consent and is what populates `counterpartyContact` and `contactSharedAt` on both sides; DECLINED leaves both null permanently. \n\nRefusals carry a distinct `code`: INQUIRY_NOT_FOUND; INQUIRY_NOT_PENDING when it has already been answered; and INQUIRY_ACCEPT_REQUIRES_ACTIVE_LISTING when ACCEPT is attempted on a listing that has left ACTIVE — accepting would reveal contact details for a deal that can no longer happen, and DECLINE still works, which is the part the sentence has to carry. It was LISTING_NOT_ACTIVE until #2564.' +
            '\n\nAnswers with the id and new status only.' +
            '\n\nRefusal code: `INQUIRY_NOT_FOUND` (404). ONE oracle for “not yours” and “not there”: a caller who is not the seller gets the same 404 as for a missing inquiry, so an outsider cannot confirm another tenant’s private buyer↔seller conversation by enumerating ids. Do not branch on it as “missing”.',
        tags: ['Exchange'],
        params: InquiryParams,
        body: RespondToInquirySchema,
        success: { status: 200, description: 'The new status.', schema: StatusAckSchema },
    });
}
