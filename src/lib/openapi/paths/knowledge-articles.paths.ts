/**
 * The knowledge base's ARTICLE surface (#3080) — browse, author, version,
 * publish, archive, and the worker read-receipt.
 *
 * Eight paths, ten operations. Separate from `knowledge.paths.ts`, which
 * documents «Почва» — a static, published reference guide served from source,
 * with no lifecycle and nothing to author. This module is the CMS: rows a
 * farm writes, versions it accumulates, and a publish step that decides what
 * its workers see.
 *
 * Four things here are contract rather than formatting.
 *
 * ── An article can belong to NO farm ──
 *
 * `KnowledgeArticle.tenantId` is NULLABLE: alongside a farm's own SOPs the
 * base carries GLOBAL, seeded content (CC0 growing guides, for instance), and
 * a tenant-scoped read returns both. So a client cannot assume every article
 * it sees is editable by the farm it is looking at.
 *
 * ── An EMPTY `cropTags` means EVERY crop, not none ──
 *
 * Same for `regions`. The arrays are a NARROWING filter, so the absence of
 * entries is the widest possible applicability — the opposite of the natural
 * reading, and the kind of inversion that makes a client hide the articles
 * that apply most broadly.
 *
 * ── Content is VERSIONED, so editing text is not editing the article ──
 *
 * `PATCH /{id}` carries no `content` at all. Text arrives as a new immutable
 * version, and a version is invisible to a farm until `publish` points the
 * article at it. Three separate acts, deliberately: write, version, release.
 *
 * ── BBCH is a RANGE, not a set ──
 *
 * `bbchStageMin`/`Max` bound a span on the 00-99 ordinal growth-stage scale
 * because an SOP applies across a phase (30-39, stem elongation), not to a
 * discrete list of stages. Both null means not stage-specific.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    CreateKnowledgeArticleSchema,
    UpdateKnowledgeArticleSchema,
    PublishKnowledgeArticleSchema,
    CreateKnowledgeVersionSchema,
} from '@/lib/schemas';
import { codedErrorResponses, op } from './helpers';

const TAGS = ['Knowledge'];

const ARTICLE_404 =
    'No such article on this farm. An id belonging to a DIFFERENT tenant '
    + 'answers identically, so the base cannot be enumerated one id at a time.';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose knowledge base this is.' }),
});

const ArticleParams = TenantParams.extend({
    id: z.string().openapi({ description: 'The article id.' }),
});

// ─── Query ───

const ListQuery = z.object({
    status: z.string().optional().openapi({
        description:
            'Comma-separated `KnowledgeArticleStatus`: `DRAFT`, `PUBLISHED`, `ARCHIVED`. '
            + 'Validated per member, so one unknown value refuses the request with a 400 '
            + 'rather than being dropped.',
        example: 'DRAFT,PUBLISHED',
    }),
    category: z.string().optional().openapi({
        description:
            'Comma-separated, and FREE TEXT rather than an enum — `GET '
            + '/knowledge/categories` returns the values actually in use. An unrecognised '
            + 'category is therefore not an error; it simply matches nothing.',
    }),
    crop: z.string().optional().openapi({
        description:
            'Comma-separated crop slugs. Note an article with an EMPTY `cropTags` applies '
            + 'to every crop — see the module note — so filtering by crop is a question '
            + 'about the tag, not about applicability.',
    }),
    region: z.string().optional().openapi({
        description: 'Comma-separated region names. Same empty-means-all caveat as `crop`.',
    }),
});

// ─── Shapes ───

const ArticleSchema = z
    .object({
        id: z.string(),
        tenantId: z.string().nullable().openapi({
            description:
                'NULL for a GLOBAL article — seeded content that belongs to no farm and is '
                + 'returned by every tenant\'s read. A client that assumes this matches the '
                + 'farm in the path will be wrong for exactly those rows.',
        }),
        slug: z.string().openapi({
            description:
                'Unique per farm, and used in readable URLs. Uniqueness among GLOBAL rows '
                + 'is held by a hand-written partial index rather than by the Prisma '
                + 'constraint, because Postgres treats NULLs as distinct.',
        }),
        title: z.string(),
        summary: z.string().nullable(),
        category: z.string().nullable(),
        status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).openapi({
            description:
                'ARCHIVED is reached from either of the others and reversed by `unarchive`. '
                + 'It is NOT deletion — an archived article keeps its versions and its '
                + 'acknowledgements.',
        }),
        currentVersionId: z.string().nullable().openapi({
            description:
                'The version a farm actually SEES, set by `publish`. Null on an article '
                + 'that has never been published — including one with versions, since '
                + 'writing a version does not release it.',
        }),
        ownerUserId: z.string().nullable(),
        language: z.string().nullable().openapi({ description: 'Defaults to `en`.' }),
        source: z.string().nullable().openapi({
            description:
                'Provenance for seeded content — `"OpenFarm"` for the CC0 growing guides, '
                + 'for instance. Null for a farm\'s own authoring, and settable only at '
                + 'create: it is absent from the update body because provenance is not '
                + 'something an editor revises.',
        }),
        cropTags: z.array(z.string()).openapi({
            description:
                'Crops this applies to. **EMPTY means EVERY crop**, not none — the array '
                + 'NARROWS, so no entries is the widest applicability. Free-text slugs in '
                + 'an array rather than a join table, deliberately.',
        }),
        regions: z.array(z.string()).openapi({
            description: 'Regions this applies to. EMPTY means every region. See `cropTags`.',
        }),
        bbchStageMin: z.number().int().nullable(),
        bbchStageMax: z.number().int().nullable().openapi({
            description:
                'With `bbchStageMin`, a RANGE on the 00-99 BBCH scale — an SOP applies '
                + 'across a phase, not to a discrete set of stages. Both null means not '
                + 'stage-specific.',
        }),
        lifecycleVersion: z.number().int().openapi({
            description:
                'Starts at 1 and increments on each PUBLISH — so it counts releases, not '
                + 'edits. A farm on `lifecycleVersion` 3 has been shown three different '
                + 'texts, however many versions were written between them.',
        }),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
    })
    .openapi('KnowledgeArticle');

const VersionSchema = z
    .object({
        id: z.string(),
        articleId: z.string(),
        versionNumber: z.number().int().openapi({
            description: 'Increments per version. Monotonic within one article.',
        }),
        contentType: z.enum(['HTML', 'MARKDOWN']).openapi({
            description:
                'HTML is the editor\'s default; MARKDOWN exists for plain-text imports '
                + 'such as the CC0 guides.',
        }),
        contentText: z.string(),
        changeSummary: z.string().nullable(),
        createdAt: z.string().datetime(),
        createdByUserId: z.string().nullable(),
    })
    .openapi('KnowledgeArticleVersion', {
        description:
            'An IMMUTABLE content snapshot. Editing text means adding one of these, never '
            + 'changing an existing one — which is what makes `publish` a meaningful act '
            + 'and what lets an acknowledgement refer to a fixed text.',
    });

const AcknowledgementSchema = z
    .object({
        created: z.boolean().openapi({
            description:
                'TRUE when this call recorded a new receipt, FALSE when one already '
                + 'existed. The STATUS says the same thing — 201 or 200 — so a client can '
                + 'branch on either.',
        }),
        articleId: z.string(),
        versionId: z.string().nullable().openapi({
            description:
                'The version acknowledged — the article\'s CURRENT one at the moment of '
                + 'the call. A later publish does not carry the receipt forward, which is '
                + 'the point: a worker has read a specific text, not an article.',
        }),
    })
    .openapi('KnowledgeAcknowledgement');

export function registerKnowledgeArticlePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/knowledge',
        operationId: 'listKnowledgeArticles',
        summary: 'Browse the knowledge base',
        description:
            'Returns the farm\'s own articles AND the GLOBAL seeded ones — rows whose '
            + '`tenantId` is null, which belong to no farm. There is no parameter to '
            + 'separate them; read `tenantId` on each row.\n\n'
            + 'All four facets are comma-joined multi-value (`?status=DRAFT,PUBLISHED`). '
            + '`status` is enum-validated so a bad member is a clean 400; the other three '
            + 'are free text and go through the structural CSV parser instead, so an '
            + 'unknown value matches nothing rather than erroring.',
        tags: TAGS,
        params: TenantParams,
        query: ListQuery,
        success: {
            status: 200,
            description: 'Matching articles, farm-owned and global alike.',
            schema: z.array(ArticleSchema),
        },
        extraResponses: codedErrorResponses({
            400: 'A `status` member outside the enum.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge',
        operationId: 'createKnowledgeArticle',
        summary: 'Author an article',
        description:
            'Only `title` is required.\n\n'
            + '**Supplying `content` creates the article AND its first version in one '
            + 'call.** Omitting it leaves an article with no version, which cannot be '
            + 'published until `POST /{id}/versions` gives it one — so a draft with no '
            + 'text is a legitimate state rather than an error.\n\n'
            + 'Either way the article starts `DRAFT` with `currentVersionId` null: '
            + 'creating text is not releasing it.',
        tags: TAGS,
        params: TenantParams,
        body: CreateKnowledgeArticleSchema,
        success: {
            status: 201,
            description: 'The created article.',
            schema: ArticleSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'Missing `title`, a field over its length cap, or a BBCH pair that is '
                + 'half-given or inverted — both-or-neither and `min <= max` are checked '
                + 'at the usecase, so those arrive as a 400 from there.',
            403: 'Read-only on this farm.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/knowledge/categories',
        operationId: 'listKnowledgeCategories',
        summary: 'The categories actually in use',
        description:
            'Distinct `category` values across the readable base, for the browse filter. '
            + 'DERIVED from the rows rather than a fixed list, which is why `category` is '
            + 'free text everywhere else: a new category comes into existence by somebody '
            + 'typing it on an article.\n\n'
            + 'So this list shrinks when the last article in a category is deleted or '
            + 'retagged, and a filter value that returns nothing is not an error.',
        tags: TAGS,
        params: TenantParams,
        success: {
            status: 200,
            description: 'The distinct categories in use.',
            schema: z.array(z.string()),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/knowledge/{id}',
        operationId: 'getKnowledgeArticle',
        summary: 'Read one article',
        description:
            'A GLOBAL article (null `tenantId`) is readable here through any farm\'s path '
            + '— which is how seeded content is served — so a 200 does not mean the farm '
            + 'owns it.',
        tags: TAGS,
        params: ArticleParams,
        success: { status: 200, description: 'The article.', schema: ArticleSchema },
        extraResponses: codedErrorResponses({ 404: ARTICLE_404 }),
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/knowledge/{id}',
        operationId: 'updateKnowledgeArticle',
        summary: 'Update article METADATA',
        description:
            '**Metadata only — this body carries no `content` and no `contentType`.** '
            + 'Article text is versioned, so changing it means `POST /{id}/versions`, not '
            + 'a field on this request. `source` is absent too: provenance is recorded at '
            + 'create and is not something an editor revises.\n\n'
            + 'Partial: only the fields present are written. A nullable field cleared by '
            + 'sending `null`; omitted leaves it alone.',
        tags: TAGS,
        params: ArticleParams,
        body: UpdateKnowledgeArticleSchema,
        success: { status: 200, description: 'The updated article.', schema: ArticleSchema },
        extraResponses: codedErrorResponses({
            400: 'A field over its cap, or a BBCH pair half-given or inverted.',
            403: 'Read-only on this farm.',
            404: ARTICLE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge/{id}/versions',
        operationId: 'createKnowledgeArticleVersion',
        summary: 'Add a content version',
        description:
            'Writes an IMMUTABLE snapshot and returns it. **It does not publish.** The '
            + 'article\'s `currentVersionId` is untouched, so a farm sees nothing new '
            + 'until `POST /{id}/publish` names this version.\n\n'
            + 'That separation is what lets an acknowledgement mean something: a worker\'s '
            + 'read-receipt points at a fixed text, and an author revising a draft cannot '
            + 'retroactively change what somebody confirmed reading.\n\n'
            + '`contentType` defaults to `HTML`.',
        tags: TAGS,
        params: ArticleParams,
        body: CreateKnowledgeVersionSchema,
        success: {
            status: 201,
            description: 'The created version. Not yet visible to the farm.',
            schema: VersionSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'Empty `contentText`, or over the 100,000-character cap.',
            403: 'Read-only on this farm.',
            404: ARTICLE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge/{id}/publish',
        operationId: 'publishKnowledgeArticle',
        summary: 'Release a specific version to the farm',
        description:
            'ADMIN, unlike authoring and versioning, which need only write — publishing is '
            + 'what makes text visible to a farm\'s workers.\n\n'
            + '**`versionId` is REQUIRED and deliberately not defaulted to the latest.** '
            + 'The caller names the text it is releasing, so an unreviewed draft written '
            + 'after approval cannot be published by a request that merely said "publish '
            + 'this article".\n\n'
            + 'Sets `status` to `PUBLISHED`, points `currentVersionId` at the named '
            + 'version, and increments `lifecycleVersion` — so that counter counts '
            + 'RELEASES, not edits. Publishing an older version again is a legitimate '
            + 'rollback and still increments it.',
        tags: TAGS,
        params: ArticleParams,
        body: PublishKnowledgeArticleSchema,
        success: {
            status: 200,
            description: 'The published article, with its new current version.',
            schema: ArticleSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'Missing `versionId`.',
            403: 'Not an administrator of this farm.',
            404: 'No such article on this farm, or no such version ON THAT ARTICLE.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge/{id}/archive',
        operationId: 'archiveKnowledgeArticle',
        summary: 'Archive an article',
        description:
            'ADMIN. Sets `status` to `ARCHIVED`. **Not deletion**: versions and '
            + 'acknowledgements survive, the article stays readable, and the list returns '
            + 'it under `?status=ARCHIVED`.\n\n'
            + 'Reachable from `DRAFT` or `PUBLISHED`, and reversed by `unarchive` — which '
            + 'is why archiving is a status rather than the separate boolean the evidence '
            + 'register uses for the same word.',
        tags: TAGS,
        params: ArticleParams,
        success: { status: 200, description: 'The archived article.', schema: ArticleSchema },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: ARTICLE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge/{id}/unarchive',
        operationId: 'unarchiveKnowledgeArticle',
        summary: 'Return an article from the archive',
        description:
            'ADMIN. Clears `ARCHIVED`.\n\n'
            + 'Note what it does NOT restore: the status it returns to, and whether a farm '
            + 'sees text again, depend on `currentVersionId` — an article archived while '
            + 'published still has one, and an archived draft still has none.',
        tags: TAGS,
        params: ArticleParams,
        success: { status: 200, description: 'The unarchived article.', schema: ArticleSchema },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: ARTICLE_404,
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge/{id}/acknowledge',
        operationId: 'acknowledgeKnowledgeArticle',
        summary: 'Record that the caller has read the current version',
        description:
            'A worker read-receipt, and the one write here that needs only READ — '
            + 'confirming you have read an SOP is not an editorial act.\n\n'
            + '**The STATUS distinguishes a first receipt from a repeat: 201 when one was '
            + 'created, 200 when it already existed.** `created` in the body says the same '
            + 'thing, so a client may branch on either, and a repeat call is safe.\n\n'
            + 'The receipt points at the article\'s CURRENT version at the moment of the '
            + 'call. A later publish does not carry it forward — which is the point: a '
            + 'worker has read a specific text, so releasing a new one leaves them '
            + 'un-acknowledged again rather than silently credited with reading something '
            + 'they have not seen.',
        tags: TAGS,
        params: ArticleParams,
        success: {
            status: 201,
            description:
                'A receipt was recorded. An existing receipt answers **200** with the same '
                + 'body and `created: false`.',
            schema: AcknowledgementSchema,
        },
        extraResponses: codedErrorResponses({ 404: ARTICLE_404 }),
    });
}
