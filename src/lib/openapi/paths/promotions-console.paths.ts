/**
 * The promotions console — the five admin route families behind the platform
 * gate (#2727).
 *
 * Documented because the phone generates its client from this spec and could
 * not see these routes at all: all five sat on
 * `openapi-undocumented-baseline.json`, so a native admin screen had no
 * request bodies, no response shapes and no refusal codes to build against.
 * Owner directive 2026-11-02 put that screen on the phone (agrent-ios #529).
 *
 * `leaflet-scan` is documented separately in `promotions-admin.paths.ts`; it
 * was new when the describe-new-paths rule took effect, these predate it.
 *
 * ## Every operation here has TWO gates and the SECOND one 404s
 *
 * `requirePermission('admin.manage')` is necessary and NOT sufficient:
 * permissions resolve from Role, so every tenant's OWNER holds it.
 * `assertPlatformSupport(ctx)` restricts the surface to the designated
 * platform tenant — and it answers **404, not 403**, so the console does not
 * announce its existence to an unrelated farm whose admin happens to probe.
 *
 * A client should therefore decide whether to SHOW this screen from
 * `platformAdmin` on `/api/auth/me`, never by calling a route and reading the
 * 404: a 404 here is indistinguishable from a path that does not exist.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const PromotionIdParams = TenantParams.extend({
    id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});

const ISO_DATE_NOTE =
    'An ISO-8601 INSTANT today, unlike the farmer-facing feed, where `GET /offers` serves this same '
    + 'column as a `YYYY-MM-DD` day key in the farm timezone (#2725).\n\n'
    + '**This is changing to a day key, read AND write, in a follow-up** — agreed with the iOS '
    + 'session 2026-11-05, and their argument is the write side rather than the read. An instant '
    + 'on the wire makes every client produce "local midnight in the farm zone", which is exactly '
    + 'the conversion that put «2 Nov» on the 1st; a day key moves it to the server, where '
    + '`dayKeyInTz` already lives. It is a separate PR because it changes the web console that '
    + 'writes this field, and that does not belong in a documentation change. Build against day '
    + 'keys if you are starting now.';

const AdminPromotionSchema = z
    .object({
        id: z.string(),
        companyId: z.string(),
        companyName: z.string(),
        title: z.string(),
        body: z.string().nullable(),
        mediaUrl: z.string().nullable().openapi({
            description:
                'Root-relative `/api/promotions/{id}/image`, or null. Written ONLY by the image '
                + 'upload below — it is absent from both write schemas, so it cannot be set to an '
                + 'off-site URL.',
        }),
        category: z.string().openapi({
            description: 'One of `culture`, `fertilizer`, `seeds`, `products`, `service`.',
        }),
        ctaUrl: z.string().nullable(),
        pppRegistrationNo: z.string().nullable().openapi({
            description:
                'ЗЗР рег. № when this advertises a plant protection product, null when it does not '
                + '(#2664, settable since #2733).\n\n'
                + '**A compliance input, not a detail.** Reg. (EC) 1107/2009 Art 66 puts specific '
                + 'requirements on advertising a ПРЗ, and free text cannot tell a pesticide from a '
                + 'fertiliser. Set at REVIEW time by the person publishing, resolved against the '
                + 'БАБХ register — never proposed by the leaflet read, which has no slot for it at '
                + 'all, because a misread registration number would silently reclassify a '
                + 'pesticide as a fertiliser.\n\n'
                + 'An empty string is normalised to null on write, so `null` means exactly "not a '
                + 'ПРЗ" and never "nobody could record it".',
        }),
        publishedAt: z.string().datetime().nullable().openapi({
            description:
                'Null means DRAFT — nothing reaches a farm until it is set. Publishing IS the '
                + 'review act, which is what lets the Art 66 predicate read `publishedAt != null '
                + '&& pppRegistrationNo == null` as "reviewed, not a ПРЗ".\n\n'
                + '**An INSTANT, and not part of the day-key mismatch below.** This is a moment — '
                + 'when support published — not a campaign day, so there is nothing here to '
                + 'reconcile with the feed, which does not expose the field at all.',
        }),
        validFrom: z.string().datetime().nullable().openapi({ description: ISO_DATE_NOTE }),
        validTo: z.string().datetime().nullable().openapi({ description: ISO_DATE_NOTE }),
        status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'EXPIRED']).openapi({
            description:
                'DERIVED from `publishedAt` and the window together, so a client does not '
                + 'recompute the two gates and disagree with the server about which rows a farm '
                + 'can see.',
        }),
        leadCount: z.number().int().openapi({
            description:
                'Enquiries captured. It rides along because it is the number support works from, '
                + 'and because a non-zero count REFUSES deletion — see `DELETE` below.',
        }),
    })
    .openapi('AdminPromotion');

const AdminCompanySchema = z
    .object({
        id: z.string(),
        name: z.string(),
        eik: z.string().nullable(),
        websiteUrl: z.string().nullable(),
        contactName: z.string().nullable(),
        contactEmail: z.string().nullable(),
        contactPhone: z.string().nullable(),
        notes: z.string().nullable(),
        promotionCount: z.number().int(),
    })
    .openapi('AdminCompany');

const companyRef = {
    companyId: z.string().min(1).optional(),
    companyName: z.string().min(1).max(200).optional(),
};
const PPP = z.string().trim().max(120).nullable().optional();

const CreatePromotionBody = z
    .object({
        ...companyRef,
        title: z.string().min(1).max(300),
        body: z.string().max(4000).nullable().optional(),
        category: z.enum(['culture', 'fertilizer', 'seeds', 'products', 'service']).default('service'),
        ctaUrl: z.string().nullable().optional(),
        validFrom: z.string().nullable().optional(),
        validTo: z.string().nullable().optional(),
        pppRegistrationNo: PPP,
    })
    .openapi('CreatePromotionBody');

const UpdatePromotionBody = CreatePromotionBody.partial().openapi('UpdatePromotionBody');

const SetPublishedBody = z
    .object({ published: z.boolean() })
    .openapi('SetPromotionPublishedBody');

const UpdateCompanyBody = z
    .object({
        name: z.string().min(1).max(200).optional(),
        eik: z.string().max(40).nullable().optional(),
        websiteUrl: z.string().nullable().optional(),
        contactName: z.string().max(200).nullable().optional(),
        contactEmail: z.string().email().max(320).nullable().optional(),
        contactPhone: z.string().max(60).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
    })
    .openapi('UpdateCompanyBody');

const PLATFORM_404 = {
    404: {
        description:
            '`assertPlatformSupport` refused — this is not the platform-support tenant, or '
            + '`PLATFORM_TENANT_SLUG` is unset. **404 and not 403 deliberately**, so the console '
            + 'does not announce itself; it is therefore indistinguishable from a nonexistent '
            + 'path. Decide whether to show this screen from `platformAdmin` on `/api/auth/me`, '
            + 'not by probing.\n\n'
            + 'On the `{id}` routes this status ALSO carries `PROMOTION_NOT_FOUND` for an id '
            + 'naming nothing — a coded refusal, so the two are distinguishable by `code` even '
            + 'though they share the status.',
    },
    403: {
        description: 'The caller lacks `admin.manage`. A role refusal, audited as `AUTHZ_DENIED`.',
    },
};

export function registerPromotionsConsolePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/promotions',
        operationId: 'listAdminPromotions',
        summary: 'Every promotion in the global catalogue, drafts included',
        description:
            'The curation view: 500 newest by creation, drafts and expired rows included, each '
            + 'with its derived `status` and `leadCount`. Unlike `GET /offers`, which applies both '
            + 'visibility gates, this deliberately shows everything — a reviewer needs to see the '
            + 'draft they are about to publish.',
        tags: ['Promotions'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The catalogue.',
            schema: z.object({ promotions: z.array(AdminPromotionSchema) }).openapi('AdminPromotionsResponse'),
        },
        extraResponses: PLATFORM_404,
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/promotions',
        operationId: 'createAdminPromotion',
        summary: 'Create a promotion — always as a DRAFT',
        description:
            '`publishedAt` is written null unconditionally, so a half-finished ad typed from an '
            + 'email cannot reach a farm by accident. Publishing is a separate, deliberate call '
            + '(`PUT …/{id}`).\n\n'
            + 'Identify the supplier by EITHER `companyId` (picked from `GET /admin/companies`) OR '
            + '`companyName` (typed fresh, then find-or-created) — **exactly one**, because '
            + 'accepting both would let a create-if-missing path silently ignore a picked company.',
        tags: ['Promotions'],
        params: TenantParams,
        body: CreatePromotionBody,
        success: {
            status: 201,
            description: 'Created as a draft. Returns the id only; re-read the list for the row.',
            schema: z.object({ id: z.string() }).openapi('PromotionCreated'),
        },
        extraResponses: {
            ...PLATFORM_404,
            400: {
                description:
                    'Neither or both of `companyId`/`companyName`; an inverted campaign window '
                    + '(`validTo` before `validFrom`); or a field past its length cap.',
            },
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/admin/promotions/{id}',
        operationId: 'updateAdminPromotion',
        summary: 'Edit a promotion',
        description:
            'A PARTIAL edit: an omitted field is left alone, and that distinction is load-bearing '
            + 'for `pppRegistrationNo` — an explicit `null` RECLASSIFIES a promotion as not a ПРЗ, '
            + 'while omitting it preserves the classification. Writing null on omission would '
            + 'silently declassify a plant protection product whenever somebody fixed a typo in '
            + 'the title.\n\n'
            + 'The campaign window is re-checked against the STORED row, because a payload may '
            + 'carry only one end of the span.',
        tags: ['Promotions'],
        params: PromotionIdParams,
        body: UpdatePromotionBody,
        success: {
            status: 200,
            description: 'Updated.',
            schema: z.object({ id: z.string() }).openapi('PromotionUpdated'),
        },
        extraResponses: {
            ...PLATFORM_404,
            400: { description: 'No fields to update, both company refs, or an inverted window.' },
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/admin/promotions/{id}',
        operationId: 'setAdminPromotionPublished',
        summary: 'Publish or unpublish — the editorial gate',
        description:
            'The ONLY way a promotion becomes visible to farms. A separate verb from `PATCH` on '
            + 'purpose: publication is an editorial act with a different audit shape '
            + '(`status_change`, not a field diff), and collapsing it into the edit would make '
            + 'every title correction a potential publish.\n\n'
            + 'Re-publishing PRESERVES the original `publishedAt` rather than re-stamping it, so '
            + 'the first-published date survives an unpublish/republish cycle. Unpublishing clears '
            + 'it and does NOT touch the campaign window.',
        tags: ['Promotions'],
        params: PromotionIdParams,
        body: SetPublishedBody,
        success: {
            status: 200,
            description: 'The new state. `publishedAt` is null after unpublishing.',
            schema: z
                .object({ id: z.string(), publishedAt: z.string().datetime().nullable() })
                .openapi('PromotionPublishState'),
        },
        extraResponses: PLATFORM_404,
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/promotions/{id}',
        operationId: 'deleteAdminPromotion',
        summary: 'Delete a promotion that captured no enquiries',
        description:
            '**Refused with 400 when `leadCount > 0`**, naming the count and saying to unpublish '
            + 'instead. A farm’s enquiry is its record of having asked a supplier, and deleting '
            + 'the promotion would take it with them; unpublishing removes the ad and keeps the '
            + 'enquiries. So a client should offer unpublish — not delete — on any row whose '
            + '`leadCount` is non-zero, rather than surfacing the refusal.',
        tags: ['Promotions'],
        params: PromotionIdParams,
        success: { status: 204, description: 'Deleted.' },
        extraResponses: {
            ...PLATFORM_404,
            400: {
                description:
                    'The promotion has captured enquiries. Unpublish it instead — the message '
                    + 'names how many.',
            },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/promotions/{id}/image',
        operationId: 'uploadAdminPromotionImage',
        summary: 'Upload the promotion image',
        description:
            '`multipart/form-data` with one `file` field. The bytes are processed and stored, and '
            + 'the response carries the root-relative `mediaUrl` the feed will serve — the field '
            + 'cannot be set any other way.\n\n'
            + 'Record-LESS: there is no `FileRecord` and so no download gate to defer to, which is '
            + 'why the AV scan runs at INGEST and the write does not happen unless it passes.',
        tags: ['Promotions'],
        params: PromotionIdParams,
        bodyContentType: 'multipart/form-data',
        body: z.object({
            file: z.string().openapi({ format: 'binary', description: 'The image.' }),
        }),
        success: {
            status: 201,
            description: 'Stored. `mediaUrl` is root-relative.',
            schema: z.object({ mediaUrl: z.string() }).openapi('PromotionImageUploaded'),
        },
        extraResponses: {
            ...PLATFORM_404,
            400: {
                description:
                    'No `file` field, a `file` field sent as TEXT rather than a file, or an image '
                    + 'past the byte cap. The size is refused on the DECLARED size before the '
                    + 'bytes are buffered, so an oversized upload is not read into memory first — '
                    + 'the real check still runs on the buffer, because that header is '
                    + 'client-supplied.',
            },
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/promotions/{id}/image',
        operationId: 'deleteAdminPromotionImage',
        summary: 'Remove the promotion image',
        description: 'Clears `mediaUrl` and deletes the stored bytes. The promotion itself stays.',
        tags: ['Promotions'],
        params: PromotionIdParams,
        success: { status: 204, description: 'Removed.' },
        extraResponses: PLATFORM_404,
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/companies',
        operationId: 'listAdminCompanies',
        summary: 'The supplier directory',
        description:
            '500 suppliers by name, each with `promotionCount`. This is the picker behind a '
            + 'promotion’s `companyId`.\n\n'
            + '**Internal by the platform gate, not by its content.** It carries supplier contact '
            + 'details, so do not reuse this shape on a tenant-facing surface — '
            + '`listActivePromotions` deliberately exposes only the company NAME.',
        tags: ['Promotions'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The directory.',
            schema: z.object({ companies: z.array(AdminCompanySchema) }).openapi('AdminCompaniesResponse'),
        },
        extraResponses: PLATFORM_404,
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/admin/companies/{id}',
        operationId: 'updateAdminCompany',
        summary: 'Edit a supplier',
        description:
            'A partial edit. Renaming recomputes the normalised dedup key, so a rename onto an '
            + 'existing supplier’s name is refused rather than creating a second row that the '
            + 'picker shows twice.',
        tags: ['Promotions'],
        params: TenantParams.extend({
            id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
        }),
        body: UpdateCompanyBody,
        success: {
            status: 200,
            description: 'Updated.',
            schema: z.object({ id: z.string() }).openapi('CompanyUpdated'),
        },
        extraResponses: {
            ...PLATFORM_404,
            400: { description: 'No fields to update, or a field past its length cap.' },
            409: {
                description:
                    '`COMPANY_NAME_TAKEN` — another supplier already uses that name, compared on '
                    + 'the normalised key (lowercased, trimmed, internal whitespace collapsed). '
                    + '**NOT a stale-edit 409**: there is no version to re-read, the collision is '
                    + 'with a different row, and the remedy is a different name.',
            },
        },
    });
}
