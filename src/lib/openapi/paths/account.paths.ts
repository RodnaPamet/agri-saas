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
import { op } from './helpers';

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

export function registerAccountPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/auth/me',
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
}
