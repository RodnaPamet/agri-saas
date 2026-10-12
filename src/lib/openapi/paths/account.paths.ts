/**
 * Account — the per-user surfaces, which are NOT tenant-scoped.
 *
 * Every other module here documents `/api/t/{tenantSlug}/…`. These carry no
 * tenant in the path because what they store is a property of the PERSON: the
 * bottom-row arrangement is a list of route suffixes, and a suffix means the
 * same thing in every tenant the user belongs to; an avatar is the same face in
 * all of them.
 *
 * Operations are documented in PAIRS here, and that is the point of the module
 * — a value and the way to read it back:
 *
 *   - `bottomTabOrder`. The write endpoint has deliberately no GET: a client
 *     reads its arrangement from `/api/auth/me`, the request it already makes
 *     at launch. Describing only one half would leave a native client with a
 *     setter, no getter and no clue where the value lives. `/api/auth/me` came
 *     off the undocumented baseline in that change.
 *   - `avatarUrl` + `getUserAvatar` (#1299). Same shape, the other way round:
 *     the serve route was live and undescribed, so clients were reading it out
 *     of route code, and `/api/auth/me` did not say whether the caller HAD an
 *     avatar at all — so an OAuth photo the web rendered showed as initials on
 *     iOS (agrent-ios#149). The field tells you which URL to use; the operation
 *     is what one of the two shapes points at.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { MAX_BOTTOM_TABS } from '@/lib/account/bottom-tabs';
import { ApiErrorResponseSchema } from '@/lib/dto/common';
import { codedErrorResponses, op, rawErrorResponses } from './helpers';

/**
 * The caller's effective avatar URL, and the ONE hazard a client has to know
 * about (#1299).
 *
 * `.nullable()` is load-bearing: `null` is the real "no avatar, draw initials"
 * state, not a placeholder. `.optional()` is load-bearing for a DIFFERENT
 * reason — this field is new, and a client built against this contract can be
 * talking to a server that predates it, where the key is simply absent. Absent
 * and `null` mean the same thing to a reader; they are not a third state.
 */
const AvatarUrl = z
    .string()
    .nullable()
    .optional()
    .openapi({
        description:
            "The caller's EFFECTIVE avatar, or `null` for none (draw initials). ONE field for " +
            'both kinds of avatar: an uploaded photo and an OAuth provider photo both live in ' +
            '`User.image`, so there is no second endpoint to consult and no fallback chain to ' +
            'walk. Read from the database, so it is current the moment an upload lands — fresher ' +
            "than the `picture` claim in a session token, which is minted at sign-in.\n\n" +
            '**TWO SHAPES, RETURNED AS STORED — the server never absolutises one into the ' +
            'other.** Branch on whether the value starts with `/`:\n\n' +
            '- a ROOT-RELATIVE path, `/api/account/avatar/{userId}` — an avatar uploaded through ' +
            'this API. Resolve it against the API base and send your session cookie or bearer; ' +
            'it is `getUserAvatar`, and it 404s once the avatar is removed.\n' +
            '- an ABSOLUTE `https://` URL on a THIRD-PARTY host (e.g. ' +
            '`https://lh3.googleusercontent.com/...`) — a provider photo from an OAuth sign-in. ' +
            'Fetch it exactly as given and attach NO credentials.\n\n' +
            'Both halves of that are failure modes somebody will otherwise hit: resolving an ' +
            'absolute provider URL against the API base 404s, and attaching your bearer token to ' +
            "it leaks the token to that host. Confirmed with the native client (agrent-ios#149): " +
            'it handles both shapes, and leaving the value as stored is the deliberate choice, ' +
            'because an absolutised URL hides which host is about to be contacted.\n\n' +
            'May be ABSENT (not just null) from a server older than this field — treat absent as ' +
            '`null`, never as a third state.',
        example: '/api/account/avatar/clx8k2p9a0000qwer',
    });

/**
 * The stored arrangement, in both directions.
 *
 * `.nullable()` is load-bearing documentation, not defensive typing: `null`
 * and `[]` are DIFFERENT states on the wire. `null` means "never chosen, draw
 * the default bar"; `[]` means "deliberately cleared". A client that collapses
 * them makes a new user indistinguishable from one who emptied their bar.
 */
const BottomTabOrder = z
    .array(z.string())
    .max(MAX_BOTTOM_TABS)
    .nullable()
    .openapi('BottomTabOrder', {
        description:
            'Ordered tenant-relative route suffixes — `/dashboard`, `/farm-tasks`, ' +
            '`/grain/costs`. Validated for SHAPE only: up to ' +
            `${MAX_BOTTOM_TABS} unique non-empty strings, never against a list of known ` +
            'tabs, so a tab shipped by a newer client saves against an older server. ' +
            'It is a PREFERENCE, not a grant — resolve it against the surfaces the ' +
            'member may actually reach on EVERY render, because a role can change ' +
            'after the write. `null` and `[]` are different states (see schema).',
        example: ['/dashboard', '/farm-tasks', '/locations', '/journal', '/exchange'],
    });

/**
 * `POST /api/auth/accept-terms`'s 400 — a bare body that carries ONE extra field.
 *
 * The route answers two 400s and they are not the same shape:
 *
 *     { error: 'terms_not_accepted' }
 *     { error: 'terms_version_stale', currentVersion: '2026-10-07-draft' }
 *
 * `currentVersion` was already described in prose, on this operation and on
 * its 400, and prose is read by a person while the SCHEMA is read by a
 * generator — the same gap this spec had on `format: date-time` (#1391) and on
 * `?view=invites`. A client generated from `RawErrorResponse` got `{ error }`
 * and no field to read the server's version out of.
 *
 * Optional rather than a `oneOf` of two near-identical objects: the union is
 * harder for a hand-written client to consume than one optional field with a
 * note, and hand-written is what agrent-ios is doing today.
 *
 * It is NOT a replay of the accepted version. agrent-ios deliberately does not
 * consume it — on `terms_version_stale` their screen re-fetches
 * `GET /api/auth/terms` and asks again, because accepting the version the
 * server names would record consent to text the person never saw. A client
 * must treat this as "your copy is stale, go and read the current one", never
 * as something to echo back.
 */
const AcceptTermsErrorResponse = z
    .object({
        error: z.string().openapi({ example: 'terms_version_stale' }),
        currentVersion: z
            .string()
            .optional()
            .openapi({
                example: '2026-10-07-draft',
                description:
                    'The terms version the server is serving. Present ONLY on ' +
                    '`terms_version_stale`, absent on `terms_not_accepted`. Re-fetch ' +
                    '`GET /api/auth/terms` and present the terms again — do not submit this ' +
                    'value back, which would record consent to text the person has not read.',
            }),
    })
    .openapi('AcceptTermsErrorResponse');

/**
 * The export's shapes, spelled out rather than left as a free-form object.
 *
 * `openapi-schema-documents-something` refused the first version, which had
 * `account: z.record(...)` and a `catchall` — and its reasoning is the point:
 * *"a documented operation with an empty schema looks COMPLETE to a client —
 * worse than being on the undocumented baseline, where the gap is at least
 * visible."* `UpdateFarmProfileRequest` shipped that way with thirteen
 * enforced fields described as none, and the iOS client had to model from
 * observed wire data.
 */
function exportCollection<T extends z.ZodTypeAny>(rows: T, what: string) {
    return z.object({
        rows: z.array(rows),
        truncated: z.boolean().openapi({
            description:
                'True when the 1000-row cap was reached, so rows may be missing. Said '
                + 'rather than silently returning a prefix.',
        }),
    }).openapi({ description: what });
}

const ExportedAccountSchema = z
    .object({
        id: z.string(),
        email: z.string().nullable(),
        name: z.string().nullable(),
        uiLanguage: z.string(),
        emailVerified: z.string().datetime({ offset: true }).nullable(),
        acceptedTermsAt: z.string().datetime({ offset: true }).nullable(),
        suspendedAt: z.string().datetime({ offset: true }).nullable().openapi({
            description:
                'Set when platform moderation has withheld access (P5.9). Included because '
                + 'a person is entitled to know their account is suspended.',
        }),
        createdAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
    })
    .openapi('ExportedAccount', {
        description:
            'The caller\u2019s own `User` row, decrypted. `emailHash` is deliberately ABSENT: it '
            + 'is a lookup derivation rather than information about the person, and publishing '
            + 'it would hand out the input to a correlation attack against any other system '
            + 'using the same HMAC.',
    });

const PersonalDataExportSchema = z
    .object({
        exportedAt: z.string().datetime({ offset: true }),
        notIncluded: z.array(z.string()).openapi({
            description:
                'Categories deliberately absent, in plain language, because Art 15 is a right '
                + 'to know what is held and a silent omission is a worse answer than a named '
                + 'one.',
        }),
        account: ExportedAccountSchema,
        contentReports: exportCollection(
            z.object({
                id: z.string(),
                subjectKind: z.string(),
                subjectId: z.string(),
                reasonCode: z.string(),
                status: z.string(),
                detail: z.string().nullable(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'DSA Art 16 notices this person filed. RETAINED through erasure under Art '
            + '17(3)(b), which is what makes erasure incomplete \u2014 and why they are shown.',
        ),
        statementsOfReasons: exportCollection(
            z.object({
                id: z.string(),
                locale: z.string(),
                bodyRendered: z.string(),
                deliveredAt: z.string().datetime({ offset: true }).nullable(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Art 17 statements addressed to this person. `actionId` is omitted, so nothing '
            + 'here reaches another party\u2019s moderation record.',
        ),
        blocksIMade: exportCollection(
            z.object({
                id: z.string(),
                blockedUserId: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Social blocks this person MADE. Blocks against them are absent \u2014 a social '
            + 'block is silent in both directions by design.',
        ),
        exchangeBlocksAgainstMe: exportCollection(
            z.object({
                id: z.string(),
                sellerTenantId: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Commercial blocks against this person. The OPPOSITE of a social block and '
            + 'included, because the exchange already discloses these to them live.',
        ),
        exchangeListings: exportCollection(
            z.object({
                id: z.string(),
                sellerTenantId: z.string(),
                commodity: z.string(),
                side: z.string(),
                kind: z.string(),
                description: z.string().nullable(),
                status: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Listings this person created. The listing belongs to the farm; only the '
            + 'authorship column names them.',
        ),
        exchangeThreads: exportCollection(
            z.object({
                id: z.string(),
                listingId: z.string(),
                closedAt: z.string().datetime({ offset: true }).nullable(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Conversations this person opened.',
        ),
        exchangeInquiries: exportCollection(
            z.object({
                id: z.string(),
                listingId: z.string(),
                message: z.string().nullable(),
                quantityTonnes: z.number().nullable(),
                status: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Enquiries this person made, including their own words.',
        ),
        exchangeMessages: exportCollection(
            z.object({
                id: z.string(),
                threadId: z.string(),
                body: z.string().nullable(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Messages this person SENT. A counterparty\u2019s replies are somebody else\u2019s '
            + 'words and are absent.',
        ),
        insuranceLeads: exportCollection(
            z.object({
                id: z.string(),
                message: z.string().nullable(),
                riskJson: z.unknown().nullable(),
                quoteJson: z.unknown().nullable(),
                status: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Insurance quotes this person requested: the figures they supplied, and the '
            + 'premium they were quoted.',
        ),
        promotionLeads: exportCollection(
            z.object({
                id: z.string(),
                promotionId: z.string(),
                requestMessage: z.string().nullable(),
                consentedAt: z.string().datetime({ offset: true }).nullable(),
                status: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Promotion enquiries this person made.',
        ),
        organisationMemberships: exportCollection(
            z.object({
                id: z.string(),
                organizationId: z.string(),
                role: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Organisations this person belongs to.',
        ),
        featureCohorts: exportCollection(
            z.object({
                id: z.string(),
                cohortKey: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
            'Dark-launch cohorts this person is in.',
        ),
    })
    .openapi('PersonalDataExport', {
        description:
            'Every collection is `{ rows, truncated }` and bounded at 1000. The collections '
            + 'present here are derived from one registry the ERASURE also reads, so a column '
            + 'exported but not erased \u2014 or erased but never shown \u2014 is not reachable.',
    });

export function registerAccountPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/auth/me',
        extraResponses: {
            ...codedErrorResponses({
                403:
                    'Carries `ACCOUNT_SUSPENDED` in `error.code` — the SAME shape and the ' +
                    'same code as every other suspension refusal in this API, because it ' +
                    'is the same throw. The account is suspended, so no body fields are ' +
                    'returned: no `user`, no `tenant`, no `featureFlags` and no ' +
                    '`deletion`.\n\n' +
                    '**`error.params.erasesAt` is the ONE exception, and it is ' +
                    'conditional** (#1671). It is present only when the caller has a ' +
                    'pending erasure THEY requested, and it is the ISO instant that erasure ' +
                    'runs. Its presence is the signal that `DELETE /api/account/deletion` ' +
                    'will be honoured for them: that route refuses a suspended account ' +
                    'except for a self-requested deletion, so a client may offer a ' +
                    '"stop the deletion" action if and only if this field is here.\n\n' +
                    'It is ABSENT when a moderator TERMINATED the account — which also ' +
                    'suspends it and starts the erasure — because the cancel is refused ' +
                    'with `ACCOUNT_TERMINATED` in that case. Offering a date and an ' +
                    'implied cancel to somebody the server will refuse is the defect this ' +
                    'route\'s own check was added to fix (#1652), so do NOT infer a ' +
                    'cancellable deletion from the 403 alone.\n\n' +
                    'Otherwise treat it as FINAL — re-authenticating succeeds and is ' +
                    'refused again, so a client that retries loops. Show the suspension and ' +
                    'offer sign-out.',
            }),
        },
        operationId: 'getCurrentUser',
        summary: 'The signed-in user, their primary tenant, and their preferences',
        description:
            'The launch request. Returns the caller plus their OLDEST ACTIVE membership as ' +
            '`tenant` — one membership, not the list, so a user who belongs to several ' +
            'tenants cannot pick between them here. `role` and `tenant` are BOTH `null` ' +
            'when there is no active membership, and they always agree: `role` is never ' +
            'a fallback value, so it is also not proof of access on its own. ' +
            'Carries `bottomTabOrder`, which is why a client needs no second round-trip ' +
            'before drawing its tab bar, and `avatarUrl`, which is why it needs no probe to ' +
            'find out whether the caller has a photo. Answers a BEARER token as well as a cookie.',
        tags: ['Account'],
        success: {
            status: 200,
            description:
                'The caller. `role` AND `tenant` are both null when they have no active ' +
                'membership — the two never disagree.',
            schema: z
                .object({
                    user: z.object({
                        id: z.string(),
                        email: z.string().nullable(),
                        name: z.string().nullable(),
                        // `.nullable()` is load-bearing documentation, like
                        // `BottomTabOrder` above: `null` means "no active
                        // membership", the same state the sibling `tenant: null`
                        // reports. There is deliberately no fallback role —
                        // READER grants real reads, so inventing one would answer
                        // "who am I" with view access for a principal who has
                        // none. A generated client must therefore decode a
                        // missing role rather than assume a string is present.
                        role: z.string().nullable(),
                        bottomTabOrder: BottomTabOrder,
                        avatarUrl: AvatarUrl,
                        deletion: z
                            .object({
                                // `.datetime()`, not a bare string: #1391's
                                // guard requires every response-side timestamp
                                // to declare a `format`, so a generated client
                                // gets a date rather than an opaque string. It
                                // is free — `format` is none of the six classes
                                // the breaking-change scorer reads, and these
                                // schemas are registration-only, so nothing
                                // starts validating.
                                requestedAt: z.string().datetime(),
                                erasesAt: z.string().datetime(),
                            })
                            .nullable()
                            .openapi({
                                description:
                                    'A pending account deletion, or `null`. An ABSENT key means the same as `null` — pinned deliberately, so an older server cannot strand a client in a recovery screen it cannot leave. `erasesAt` is `requestedAt` plus the 30-day grace period, derived from the SAME constant the erasure sweep reads, so the date shown and the date the data goes cannot disagree; render it, do not recompute it. Both are ISO instants (`…Z`). Cancel with `DELETE /api/account/deletion` — signing in does NOT cancel, because a background session refresh would then undo a deliberate request. A SUSPENDED caller never sees this field: the route answers 403 first.',
                                example: null,
                            }),
                    }),
                    tenant: z
                        .object({ id: z.string(), name: z.string(), slug: z.string() })
                        .nullable(),
                    featureFlags: z
                        .record(z.string(), z.boolean())
                        .openapi({
                            description:
                                'Runtime feature flags, ALREADY RESOLVED for this caller — cohort-gated flags are narrowed server-side, so a client never sees one enabled only for someone else. An ABSENT key means OFF; never treat a missing key as default-on. An EMPTY OBJECT is a legitimate state meaning everything is off, and is what the global kill switch returns. Flags are DB-backed and read at request time, never NEXT_PUBLIC_* (baked in at build time); the server caches the table for 30s, which is the propagation bound for a flip. Re-read rather than caching across sessions.',
                            example: { 'social.profiles': false },
                        }),})
                .openapi('CurrentUser'),
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/account/bottom-tabs',
        operationId: 'setBottomTabOrder',
        summary: "Set the caller's own bottom-row arrangement",
        description:
            'Acts ONLY on the authenticated user — there is no userId parameter, so one ' +
            'user can never rearrange another\'s bar. Send `{ "order": [...] }` to set it, ' +
            '`{ "order": null }` to restore the default, `{ "order": [] }` for a ' +
            'deliberately empty bar. The key is REQUIRED: a missing `order` is rejected ' +
            'rather than guessed at, because null and [] mean opposite things. ' +
            'Last-write-wins — no `If-Match`, matching the other account preferences. ' +
            'Read the value back from `getCurrentUser`; there is no GET here.',
        tags: ['Account'],
        body: z.object({ order: BottomTabOrder }).openapi('SetBottomTabOrderRequest'),
        success: {
            status: 200,
            description: 'The stored arrangement, as persisted.',
            schema: z.object({ bottomTabOrder: BottomTabOrder }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/accept-terms',
        extraResponses: {
            ...rawErrorResponses({
                401:
                    '`unauthenticated` — a BARE body, not the envelope.',
            }),
            // Overridden rather than taken from `rawErrorResponses`, because
            // this 400 carries `currentVersion` and `RawErrorResponse` declares
            // `error` alone. Spread first so this wins.
            400: {
                description:
                    '`terms_not_accepted` or `terms_version_stale` — a BARE body, not the envelope. The latter carries `currentVersion`, DECLARED here rather than only described, so a generated client has a field to read it from.',
                content: { 'application/json': { schema: AcceptTermsErrorResponse } },
            },
        },
        operationId: 'acceptTerms',
        summary: 'Record that the signed-in user accepts the current terms',
        description:
            'The way OUT of the consent gate (P3.1). A signed-in session whose ' +
            '`acceptedTermsAt` is null is held at `/accept-terms` by middleware, and every ' +
            'tenant- and person-scoped surface answers `403 Terms acceptance required` until ' +
            'this succeeds.\n\n' +
            'It exists because the two ways into the product do not agree: ' +
            '`POST /api/auth/register/start` captures acceptance inline, while a first-time ' +
            'Google sign-in creates its user row inside NextAuth and records nothing. ' +
            'Stamping consent on that callback would file an agreement nobody gave, so the ' +
            'product asks instead.\n\n' +
            '`acceptedTerms` must be literally `true` — checked for identity, not truthiness, ' +
            'so a client that renders no consent control cannot satisfy it with any non-empty ' +
            'value. `termsVersion` must equal the version the server is serving; a mismatch is ' +
            '`400 terms_version_stale` carrying `currentVersion`, which exists so a client can ' +
            'say "reload and read the new terms" rather than showing a generic failure. ' +
            'Render `/terms` to read the current version.\n\n' +
            'IDEMPOTENT, and it does not re-stamp: a replay by a user who already accepted ' +
            'returns 200 and leaves the stored timestamp alone. That timestamp is the artifact ' +
            'the column exists for, so moving it on every replay would destroy the only thing ' +
            'it is good for.\n\n' +
            'The session must be refreshed before navigating: `termsPending` is a JWT claim, ' +
            'so a client that writes and redirects without re-minting bounces straight back ' +
            'to the gate.',
        tags: ['Account'],
        body: z
            .object({
                acceptedTerms: z.literal(true).openapi({
                    description: 'Must be literally true. Absent or false is 400 terms_not_accepted.',
                }),
                termsVersion: z.string().min(1).max(64).openapi({
                    example: '2026-10-07-draft',
                    description:
                        'The version the client DISPLAYED. Compared for equality with the one ' +
                        'being served, so a page left open across a terms change cannot file a ' +
                        'consent to a document nobody read.',
                }),
            })
            .openapi('AcceptTermsRequest'),
        success: {
            status: 200,
            description:
                'Accepted, or already accepted — both answer this. `version` is what was ' +
                'recorded.',
            schema: z
                .object({ ok: z.literal(true), version: z.string() })
                .openapi('AcceptTermsResult'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/account/avatar/{userId}',
        operationId: 'getUserAvatar',
        summary: "A user's uploaded avatar, as webp bytes",
        description:
            'BINARY, not JSON — `image/webp`, `Cache-Control: private, max-age=300`. This is ' +
            'where a ROOT-RELATIVE `avatarUrl` from `getCurrentUser` points; an ABSOLUTE ' +
            '`avatarUrl` is a third-party provider photo and this route knows nothing about it ' +
            '(see the `avatarUrl` description — the two shapes are fetched differently).\n\n' +
            'Live since the avatar roadmap P3 and UNDESCRIBED until #1299, so clients were ' +
            'reading its shape out of route code.\n\n' +
            'ANY authenticated user may fetch ANY user id, deliberately: avatars are rendered ' +
            'across tenant member lists and people-pickers, so a per-viewer check here would ' +
            'break the surfaces the route exists for. Nothing else is exposed — the response is ' +
            'image bytes, and a non-existent user id is indistinguishable from a user with no ' +
            'avatar. Answers a BEARER token as well as a cookie.\n\n' +
            'The 404 is the ORDINARY case, not an error to log: it is what a user with no ' +
            'uploaded avatar returns, and `<InitialsAvatar>` falls back to initials on it. The ' +
            'bytes are written only through `POST /api/account/avatar`, which accepts the ' +
            "caller's OWN avatar only, validates the webp magic number and AV-scans before the " +
            'write — so what streams here has passed that gate.',
        tags: ['Account'],
        params: z.object({
            userId: z
                .string()
                .openapi({
                    param: { name: 'userId', in: 'path' },
                    description:
                        'The user whose avatar to serve. Any user id, not just the caller — see above.',
                }),
        }),
        success: {
            status: 200,
            description:
                'The stored avatar. `Content-Type: image/webp`; `Cache-Control: private, ' +
                'max-age=300`, so a changed avatar propagates within five minutes.',
            content: { 'image/webp': z.string().openapi({ format: 'binary' }) },
        },
        extraResponses: {
            404: {
                description:
                    'This user has no UPLOADED avatar — the expected answer for most users, ' +
                    'including every user whose photo came from an OAuth provider. Render ' +
                    'initials. It is also the answer for a user id that does not exist, and the ' +
                    'two are deliberately indistinguishable.',
                content: { 'application/json': { schema: ApiErrorResponseSchema } },
            },
        },
    });
    op(registry, {
        method: 'get',
        path: '/api/account/export',
        operationId: 'exportMyPersonalData',
        summary: 'Account — export everything we hold about you',
        description:
            'A GDPR Art 15 / Art 20 export of the caller\u2019s own personal data, as JSON with '
            + '`Content-Disposition: attachment`. Machine-readable is what Art 20 asks for and JSON '
            + 'is that; there is no generated archive, because a streamed zip would add a build '
            + 'step and a temp file for no gain at this volume.'
            + '\n\n**The subject is always the caller.** There is no query parameter and no body: a '
            + 'route that could name a different person would be an arbitrary personal-data read '
            + 'behind somebody\u2019s own session.'
            + '\n\n**What it includes** is derived from one registry that the erasure also reads '
            + '(`@/lib/privacy/personal-data-registry`), because a column exported but not erased '
            + 'is a promise broken one way, and a column erased but not exported is data destroyed '
            + 'without ever being shown. A guard derives that registry\u2019s population from the '
            + 'Prisma DMMF, so a new table carrying a person id cannot slip past unclassified.'
            + '\n\n**What it does NOT include is listed in the response itself**, under '
            + '`notIncluded`, because Art 15 is a right to know what is held and an export that '
            + 'silently omitted categories would be a worse answer than one that names them. Three '
            + 'omissions are deliberate: FARM RECORDS the caller authored (a journal entry belongs '
            + 'to the farm, which has its own \u0411\u0410\u0411\u0425 retention duty); CREDENTIALS and sessions (a live '
            + 'refresh token in a downloadable file is a risk to the person and answers nothing '
            + 'they asked); and BLOCKS MADE AGAINST THEM, since a social block is silent in both '
            + 'directions by design.'
            + '\n\nStatements of reasons ARE included, which is a deliberate change of posture '
            + 'from P5.1: that phase gave a recipient no READ POLICY, because a row-level arm would '
            + 'expose `actionId` and through it another party\u2019s moderation rationale. An export is '
            + 'not a policy arm \u2014 it runs privileged, for one named person, over their own rows, '
            + 'and the text was emailed to them already. `actionId` is omitted.'
            + '\n\nEach collection is bounded at 1000 rows and says `truncated` when it hit that, '
            + 'rather than silently returning a prefix. Rate-limited hourly: exercising a '
            + 'data-subject right in bulk is not a thing anyone needs to do.',
        tags: ['Account'],
        success: {
            status: 200,
            description: 'The export. `Cache-Control: no-store`.',
            schema: PersonalDataExportSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/account/deletion',
        operationId: 'requestAccountDeletion',
        summary: 'Account — ask for your account to be deleted',
        description:
            'Starts a 30-day grace period and FREEZES the account: every live session is '
            + 'revoked immediately. Owner ruling \u2014 frozen rather than visible, because a person '
            + 'who asked to be deleted should stop appearing to other farms at once rather than '
            + 'keep showing up in live negotiations for a month. The 30 days protects THEM, from '
            + 'an impulse or a compromised account.'
            + '\n\nIdempotent, and asking twice does NOT restart the clock \u2014 otherwise a person '
            + 'could never actually be deleted. `erasesAt` is returned so a client can state the '
            + 'date rather than recompute it: two places deriving one deadline is two places to '
            + 'get it wrong.'
            + '\n\n**What happens at the end is pseudonymisation, not deletion, and erasure is '
            + 'INCOMPLETE by design.** The basis is GDPR Art 17(3)(b), legal obligation: the DSA '
            + 'audit trail survives, so a notice this person filed stays linkable to them and the '
            + '`User` row is kept but emptied \u2014 the email becomes a tombstone at an unroutable '
            + 'domain and the name is removed, which also frees the original address for '
            + 're-registration. Credentials, sessions, social blocks and cohort memberships are '
            + 'DELETED; listings, conversations, messages and enquiries survive with the '
            + 'authorship column overwritten by a random pseudonym, because those rows are also '
            + 'a farm\u2019s or a counterparty\u2019s record. The hash-chained audit logs are untouched: '
            + 'rewriting a row inside one breaks verification for every entry after it.'
            + '\n\n404 `ACCOUNT_ALREADY_ERASED` when there is nothing left to request.',
        tags: ['Account'],
        success: {
            status: 200,
            description: 'The request is recorded and the account is frozen.',
            schema: z
                .object({
                    requested: z.boolean(),
                    alreadyRequested: z.boolean().openapi({
                        description: 'True when a request was already outstanding; the original date stands.',
                    }),
                    erasesAt: z.string().datetime({ offset: true }).nullable(),
                    graceDays: z.number().int(),
                    sessionsRevoked: z.number().int(),
                })
                .openapi('AccountDeletionRequested', {
                    description: 'The recorded request, with the date the erasure will run.',
                }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/account/deletion',
        operationId: 'cancelAccountDeletion',
        summary: 'Account — cancel a pending deletion',
        description:
            'Clears the freeze. This is the DSA-adjacent recovery path for a decision somebody '
            + 'may regret, and it is why the grace period exists at all.'
            + '\n\nAn EXPLICIT act, not a side effect of signing in. Signing in is how a person '
            + 'reaches this \u2014 their sessions were revoked when they asked \u2014 but a silent '
            + 'cancellation on session refresh would let a background request undo a deliberate '
            + 'decision.'
            + '\n\nRevoked sessions are NOT restored: reinstatement returns the ability to sign '
            + 'in, not credentials that may since have been shared. Same one-way rule as lifting '
            + 'a suspension.'
            + '\n\n404 `ACCOUNT_ALREADY_ERASED` once pseudonymisation has run \u2014 past that point '
            + 'there is nothing to cancel, and saying so beats pretending it worked.',
        tags: ['Account'],
        success: {
            status: 200,
            description: 'The pending deletion is cancelled.',
            schema: z
                .object({
                    requested: z.boolean(),
                    wasRequested: z.boolean().openapi({
                        description: 'False when nothing was pending \u2014 the call is idempotent rather than an error.',
                    }),
                })
                .openapi('AccountDeletionCancelled', {
                    description: 'The cleared state.',
                }),
        },
    });

}
