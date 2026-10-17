/**
 * `/api/t/{tenantSlug}/farm-brand/publication` — making a farm public, and
 * taking it back (P6.1, #1810).
 *
 * Its own module rather than appended to `farm-profile.paths.ts`. That file
 * documents `FarmProfile`, the PRIVATE farm identity holding ЕГН, ЕИК and the
 * address — the one model whose fields must never reach a public page. Putting
 * the publish operation inside it would file the public surface under the
 * private one, and the two being easy to confuse is precisely the risk this
 * phase is managing.
 *
 * The body schema is IMPORTED from `@/app-layer/schemas/farm-brand.schemas`,
 * not redeclared: `tests/guards/request-body-declared-once.test.ts` caps a
 * second declaration at zero, because a route and a spec each with their own
 * Zod for one body are two schemas nothing compares.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    ClaimFarmBrandHandleSchema,
    RecordFarmBrandConsentSchema,
    SetFarmBrandPublicationSchema,
    UpdateFarmBrandSchema,
} from '@/app-layer/schemas/farm-brand.schemas';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose public profile this is.' }),
});

const ProjectionResultSchema = z
    .object({
        handle: z.string().nullable().openapi({
            description:
                'The public address the farm is now served at, as `/f/{handle}` — or `null` when it is not published. A client can use the null to decide whether to show a "view your page" link without re-reading anything.',
        }),
        withdrawn: z.boolean().openapi({
            description:
                'True only when THIS call removed a previously public profile. False on a repeat withdrawal, because there was nothing left to remove — so it reports what happened rather than what the state is.',
        }),
        removedHandle: z.string().nullable().openapi({
            description:
                'The address that stopped answering, when a withdrawal or a RENAME removed one. A rename returns both: `handle` is the new address and this is the old one, which matters because the old one may be printed on paper (P6.7).',
        }),
    })
    .openapi('FarmBrandProjectionResult');

const HandleClaimResultSchema = z
    .object({
        handle: z.string().openapi({
            description:
                'The address the farm now holds, NORMALISED — lower-cased and transliterated from Cyrillic. This is what `/f/{handle}` will serve, and it is often not what was submitted: `Победа` is stored and served as `pobeda`. Show it back to the owner rather than echoing their input, or they will discover the difference from a link that does not work.',
        }),
        normalised: z.boolean().openapi({
            description:
                'True when the stored address differs from the submitted one. Exists so a client can say "your page will be at /f/pobeda" at the moment of choosing instead of after publishing.',
        }),
        reprojected: z.boolean().openapi({
            description:
                'True when the farm was already published and the public page moved as part of this call. The OLD address stops answering immediately — which matters because it may be printed on paper (P6.7) or shared in a chat that cannot be edited.',
        }),
    })
    .openapi('FarmBrandHandleClaimResult');

const SaveResultSchema = z
    .object({
        created: z.boolean().openapi({
            description:
                'True when this call CREATED the draft rather than editing one. A client can use it to decide between "saved" and "your public profile has been started" — and it is true exactly once per farm.',
        }),
        reprojected: z.boolean().openapi({
            description:
                'True when the farm was already published and the public page was refreshed as part of this save. False for a draft, because there is no page yet. If this were false on a published farm, the edit would have changed nothing a visitor can see.',
        }),
    })
    .openapi('FarmBrandSaveResult');

const ConsentResultSchema = z
    .object({
        consentedAt: z.string().datetime({ offset: true }).openapi({
            description:
                'When consent was recorded. Moves on each call, because the record that matters is the most recent agreement to the CURRENT wording.',
        }),
        textVersion: z.string().openapi({
            description: 'The version of the consent text that was agreed to, as sent.',
        }),
    })
    .openapi('FarmBrandConsentResult');

const DraftSchema = z
    .object({
        handle: z.string().nullable(),
        displayName: z.string().nullable(),
        tagline: z.string().nullable(),
        about: z.string().nullable(),
        oblast: z.string().nullable(),
        crops: z.array(z.string()),
        published: z.boolean(),
        publishedAt: z.string().datetime({ offset: true }).nullable(),
        consentedAt: z.string().datetime({ offset: true }).nullable(),
        consentTextVersion: z.string().nullable(),
        indexable: z.boolean(),
        hideTagline: z.boolean().openapi({
            description:
                'True when the tagline is WITHHELD from `/f/{handle}` — P6.6. The text is still stored and still returned here; only the public page omits it. Hiding is not deleting: turning the flag off restores the field with nothing retyped.',
        }),
        hideAbout: z.boolean(),
        hideOblast: z.boolean(),
        hideCrops: z.boolean(),
    })
    .nullable()
    .openapi('FarmBrandDraft');

export function registerFarmBrandPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/farm-brand/publication',
        operationId: 'setFarmBrandPublication',
        summary: 'Publish the farm’s public profile, or withdraw it',
        description:
            '`PUT` because the body IS the desired state: sending the same value twice leaves the same result, which is what makes it safe to retry on a flaky connection. `published` has no default — a client that omits it is refused rather than publishing a farm by accident, because publication is the direction that is hard to take back.\n\n'
            + 'Withdrawing DELETES the public row rather than flagging it, so `/f/{handle}` stops answering outright. A rename is handled in the same call: the profile appears at the new address and the old row is removed, which is why `removedHandle` comes back alongside `handle`.\n\n'
            + '**This operation does not make a farm findable by search engines.** The projection carries an `indexable` flag which is always `false` today and is deliberately left alone by a refresh, so a republish cannot change it. The control belongs to the editor (P6.6, #1815), because "publish my page" and "let search engines index it" are different decisions.\n\n'
            + '**Refusal codes.**\n'
            + '- `FARM_BRAND_NOT_FOUND` (404) — this farm has no brand record to publish. A farm that has never opened the editor is in this state, so a client should offer to create one rather than reporting an error.\n'
            + '- `FARM_BRAND_HANDLE_REQUIRED` — no public address has been chosen. `/f/{handle}` has no other key, so there is nowhere to serve the page from.\n'
            + '- `FARM_BRAND_DISPLAY_NAME_REQUIRED` — no public name. Structural rather than editorial: the projection’s `displayName` is NOT NULL, so a farm without one cannot be represented at all.\n'
            + '- `FARM_BRAND_CONSENT_REQUIRED` — no consent has been recorded. Publishing identifiable information about a real farm without a record that somebody agreed is refused, and the consent sheet that records it is P6.6’s.\n\n'
            + 'All three publication refusals are fail-closed and apply only to `published: true`. A withdrawal never fails on them — a farm must always be able to take its page down, including one whose brand record has since become incomplete.',
        tags: ['Farm profile'],
        params: TenantParams,
        body: SetFarmBrandPublicationSchema,
        success: {
            status: 200,
            description: 'The resulting projection state.',
            schema: ProjectionResultSchema,
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/farm-brand/handle',
        operationId: 'claimFarmBrandHandle',
        summary: 'Claim the farm’s public address',
        description:
            'The address in `/f/{handle}`, reserved in a namespace shared with EVERY other tenant — so this is the one brand field that can be refused for a reason about somebody else.\n\n'
            + '`PUT` because the body is the desired state: submitting the address you already hold is a success, not a collision with yourself, which makes a retry on a dropped connection safe.\n\n'
            + '**The address is normalised, and the result tells you how.** Input is transliterated from Cyrillic and lower-cased, so `Победа` is stored as `pobeda`. The `@unique` index is case-sensitive while the public reader lower-cases, so without this normalisation `Pobeda` and `pobeda` would be two reservations collapsing onto one page — the second farm to publish would take over the first one\u2019s. Render `handle` from the response, never the submitted string.\n\n'
            + '**A rename moves a published page immediately.** When the farm is already public, `reprojected` is true and the OLD address stops answering in the same call. Worth surfacing before the owner confirms: the old address may be printed on a card or sitting in a chat message nobody can edit.\n\n'
            + '**Refusal codes.**\n'
            + '- `FARM_BRAND_NOT_FOUND` (404) — this farm has no brand record yet. Offer to create one rather than reporting an error.\n'
            + '- `FARM_HANDLE_TAKEN` — another farm holds it. `details.suggestions` carries up to three alternatives DERIVED from this farm (its oblast and public name, e.g. `pobeda-dobrich`), because a farmer can act on that where `pobeda-2` only tells them they were second. The list may be EMPTY when nothing is derivable, and an empty list is a real answer: refuse plainly rather than inventing a counter. The suggestions are advisory — two owners can be told the same name is free in the same second, and the unique index is what actually decides.\n'
            + '- `FARM_HANDLE_RESERVED` — reserved against platform impersonation (`support`, `admin`, `agrent`…). Checked on the TRANSLITERATED form, so the Cyrillic spelling of a reserved word is refused too.\n'
            + '- `FARM_HANDLE_TOO_SHORT` — under three characters after normalisation. Note it is the normalised length: `я` is one character that becomes `ya`, and is still refused.\n'
            + '- `FARM_HANDLE_TOO_LONG` — over forty characters after normalisation. Refused rather than truncated, so nobody is handed a silently cut-off address.\n'
            + '- `FARM_HANDLE_UNUSABLE` — nothing usable survives normalisation, e.g. punctuation only.\n\n'
            + 'This operation does NOT publish the farm. `PUT .../farm-brand/publication` does, and it refuses with `FARM_BRAND_HANDLE_REQUIRED` until this call has succeeded.',
        tags: ['Farm profile'],
        params: TenantParams,
        body: ClaimFarmBrandHandleSchema,
        success: {
            status: 200,
            description: 'The address the farm now holds.',
            schema: HandleClaimResultSchema,
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/farm-brand',
        operationId: 'updateFarmBrand',
        summary: 'Save the farm’s public content',
        description:
            'The farm\u2019s own public text — name, tagline, description, oblast and crops. CREATES the draft when there is none, which is what makes the rest of this surface reachable: before this operation existed nothing in the product could write a `FarmBrand`, so `/f/{handle}` served nobody and both sibling routes refused `FARM_BRAND_NOT_FOUND` on every call (#1867).\n\n'
            + '**A field left out is untouched; an explicit `null` clears it.** That distinction is what an autosaving editor needs — without it, saving a tagline would wipe the description the owner wrote yesterday and never opened today. `crops` has no null form: an empty array IS the cleared state for a list.\n\n'
            + '**Publication preconditions are NOT enforced here.** A draft may be incomplete, and `displayName` is nullable even though the public page\u2019s column is NOT NULL — refusing a nameless draft would stop an owner saving a tagline before deciding what to call the farm. `PUT .../publication` is where the three refusals bite.\n\n'
            + '**Editing a PUBLISHED farm refreshes its page in the same call**, reported as `reprojected`. An edit that did not would succeed while changing nothing a visitor sees.\n\n'
            + '**Per-field visibility (P6.6).** `hideTagline`, `hideAbout`, `hideOblast` and `hideCrops` withhold a field from `/f/{handle}` WITHOUT clearing it. They follow the same omitted-means-untouched rule as the content fields, which is what lets an autosaving editor send one flag without disturbing another — or the text it hides.\n\n'
            + 'There is deliberately no flag for `handle` or `displayName`: both are publication preconditions, so a published farm cannot withhold them. The public projection omits a hidden field entirely, and a visitor cannot distinguish a hidden field from an unset one — which is intentional, because revealing that something is withheld is the thing hiding it is meant to avoid.\n\n'
            + '**Media.** `logoMediaHash` and `photoMediaHashes` carry CONTENT HASHES returned by `POST /farm-brand/media`, never file ids or URLs. Array order is display order, and removing a hash is how a photograph is withdrawn — there is no visibility flag for images, because the bytes live in storage under an address that does not depend on this field, so clearing it withholds nothing it cannot restore.\n\n'
            + '**Refusal codes.**\n'
            + '- `FARM_MEDIA_NOT_PUBLISHABLE` — a hash this farm may not publish. ONE code for every reason: not this tenant\u2019s file, not uploaded through `POST /farm-brand/media` (the `farm-media` storage domain), deleted, or never finished storing. They are deliberately indistinguishable, because telling them apart would say whether a hash exists elsewhere in the system. Re-upload the image.\n'
            + '- `FARM_MEDIA_TOO_MANY` — more photographs than a profile may show. The limit is on the wire as `maxPhotos` rather than only in the sentence, so a translated message can name the figure.\n\n'
            + 'Otherwise none of its own \u2014 the bounds are schema validation, and the admin check is the usual tenant-role refusal.',
        tags: ['Farm profile'],
        params: TenantParams,
        body: UpdateFarmBrandSchema,
        success: {
            status: 200,
            description: 'Whether the draft was created, and whether the public page moved with it.',
            schema: SaveResultSchema,
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/farm-brand/consent',
        operationId: 'recordFarmBrandConsent',
        summary: 'Record consent to publish the farm’s public profile',
        description:
            'Records that somebody was shown a specific consent text and agreed to it. `PUT .../publication` refuses `FARM_BRAND_CONSENT_REQUIRED` until this has been called, so this is the operation that unblocks publishing.\n\n'
            + '**Its own operation rather than a field on the content save, deliberately.** Consent is a legal artefact, not editor state. The content route is autosaved, and an autosave that recorded consent would be claiming somebody read something they never saw — the one thing a consent record must not be able to say.\n\n'
            + '`textVersion` is what makes the record checkable. "They consented" is unfalsifiable once the wording changes; "they consented to v2" can be held against the v2 text. Send the version of the text the sheet actually displayed, not the newest one you know of.\n\n'
            + '**Re-consenting MOVES the timestamp.** A first-consent-wins rule would leave a farm published against a text nobody alive agreed to.\n\n'
            + '**Refusal codes.**\n'
            + '- `FARM_BRAND_NOT_FOUND` (404) — there is no draft to consent to. Consent to publish a farm with no public profile is consent to nothing, so save content first.',
        tags: ['Farm profile'],
        params: TenantParams,
        body: RecordFarmBrandConsentSchema,
        success: {
            status: 200,
            description: 'The recorded consent.',
            schema: ConsentResultSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/farm-brand/share-card',
        operationId: 'getFarmShareCard',
        summary: 'The farm’s A6 share card, as a PDF',
        description:
            'A 105 × 148 mm (A6) card carrying the farm’s public name, its address as text, and a QR code that resolves to `/f/{handle}`. Intended to be printed and handed out — at a market stall, pinned to a gate.\n\n'
            + '**A PDF rather than a print stylesheet, and that is a constraint rather than a preference.** `@page` is a document-level CSS rule with no element scope, and the application’s global stylesheet already declares the only one it has (`size: A4 landscape`, inside `@media print`). A second `@page` for A6 would either lose to that rule or re-size every other print surface in the application, depending on nothing more than stylesheet order. Serving bytes also means the Cyrillic face is EMBEDDED, so the farm’s name does not depend on the fonts installed wherever the sheet is printed.\n\n'
            + '**No image.** Text and the QR only, per the owner’s ruling that the public farm page carries no avatar — a card is the same surface one step further from anyone who could correct it.\n\n'
            + '`Cache-Control: no-store`. The card embeds the farm’s current public name, and a cached copy would hand out a sheet naming what the farm used to be called.\n\n'
            + '**Refusal codes.** All three are fail-closed, and stricter than the editor’s on purpose: paper outlives state. A card printed from an incomplete draft points at a dead address for as long as the sheet exists, and there is no equivalent of withdrawing it.\n'
            + '- `FARM_BRAND_NOT_FOUND` (404) — this farm has no public profile yet.\n'
            + '- `FARM_BRAND_HANDLE_REQUIRED` — no public address has been chosen, so there is nothing for the QR to encode.\n'
            + '- `FARM_BRAND_DISPLAY_NAME_REQUIRED` — no public name, so the card would be a QR code and nothing else.\n'
            + '- `FARM_BRAND_NOT_PUBLISHED` — the profile exists but is not public, so `/f/{handle}` does not answer. This is the first operation in the product that requires an ALREADY-published farm; every other write on this model is what gets it there. Call `PUT .../farm-brand/publication` first.',
        tags: ['Farm profile'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'The card. `Content-Disposition: attachment` with the farm’s own name carried in RFC 5987 `filename*`, so a Bulgarian name survives the download rather than being transliterated or dropped.',
            content: {
                'application/pdf': z.string().openapi({ format: 'binary' }),
            },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/farm-brand/media',
        operationId: 'uploadFarmBrandMedia',
        summary: 'Upload an image for the public profile',
        description:
            'Stores an image and answers its CONTENT HASH. It does NOT publish anything — putting the hash on `logoMediaHash` or `photoMediaHashes` via `PATCH /farm-brand` is what decides whether an image appears, where, and as what.\n\n'
            + 'Two steps on purpose. An upload that also published would make dropping a file onto the page a publication decision, and there would be no way to upload four photographs and then choose two. It also makes a retry safe: the same bytes give the same hash, so a dropped connection does not produce a second gallery entry.\n\n'
            + '**EXIF, XMP and GPS are stripped** before the bytes are stored (#1812), by re-encoding. On this surface that is the point rather than a precaution: a farmer photographs a field FROM the field, so the GPS tag in that photo is the parcel\u2019s location. Format is preserved and the pixels are unchanged; orientation is baked in first, so a portrait phone photo is stored upright rather than relying on a tag that is about to be removed.\n\n'
            + 'JPEG, PNG and WebP only \u2014 narrower than the shared upload allowlist, because only formats the strip pipeline re-encodes may be published. The bytes are AV-scanned before the decode, so a malformed container reaches a scanner before it reaches an image decoder.\n\n'
            + 'The hash is NOT a capability. Holding one does not make an image public: `GET /api/public/media/{hash}` serves it only once a PUBLISHED profile references it, and only this tenant can put it there.\n\n'
            + '**Refusal codes.**\n'
            + '- `INVALID_FILE` \u2014 no `file` part in the form data, or it was not a file.\n'
            + '- `IMAGE_UNREADABLE` \u2014 the magic number said image and the decoder disagreed. A different photo, not the same one re-exported.\n'
            + '- `FILE_TYPE_NOT_ALLOWED` \u2014 not a JPEG, PNG or WebP, checked on the bytes rather than the declared type.\n'
            + '- `FILE_TOO_LARGE`, `FILE_EMPTY` \u2014 the shared upload bounds.',
        tags: ['Farm profile'],
        params: TenantParams,
        bodyContentType: 'multipart/form-data',
        body: z.object({
            file: z.string().openapi({ format: 'binary' }),
        }),
        success: {
            status: 201,
            description:
                'The stored image. `hash` is what `PATCH /farm-brand` accepts and what the public media route resolves.',
            schema: z.object({
                hash: z.string().openapi({
                    description: 'sha256 of the STORED bytes, 64 lower-case hex characters.',
                }),
                mimeType: z.string(),
                sizeBytes: z.number(),
                fileRecordId: z.string(),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/farm-brand',
        operationId: 'readFarmBrandDraft',
        summary: 'The farm’s public-profile draft',
        description:
            'What the editor renders. Deliberately WIDER than the public page: it carries `published`, `consentedAt`, `consentTextVersion` and `indexable`, which no reader of `/f/{handle}` ever sees but the form has to show.\n\n'
            + '**`200` with a `null` body when there is no draft**, not `404`. A farm that has never opened the editor is in a normal state and the form should show itself empty rather than an error — the operations that genuinely need a draft (claiming a handle, recording consent) refuse with `FARM_BRAND_NOT_FOUND` on their own.\n\n'
            + 'Admin-gated, like every write on this model: the public face of a farm is an owner concern, and a read looser than the write would let a member see a draft they cannot edit.\n\n'
            + '`projectedHandle` is NOT returned. It is the projection writer\u2019s bookkeeping — which public row to remove on a rename — and means nothing to an editor.',
        tags: ['Farm profile'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The draft, or `null` when the farm has none yet.',
            schema: DraftSchema,
        },
    });
}
