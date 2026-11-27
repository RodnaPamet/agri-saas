/**
 * The knowledge base's READ-ONLY guides, plus `ask` (#3080).
 *
 * Three operations that share nothing with the article CMS in
 * `knowledge-articles.paths.ts`: «Почва» and the satellite guide are
 * published reference content with no lifecycle and nothing to author, and
 * `ask` answers a question rather than returning a row.
 *
 * `/api/t/{tenantSlug}/knowledge/soil-guide` — «Почва», the soil section of
 * the knowledge base (owner, 2026-11-26).
 *
 * Documented rather than baselined, for the reason `lunar.paths.ts` gives:
 * agrent-ios builds its «Почва» screen against this, and a contract with no
 * schema is one a phone has to infer from a sample response. The two id
 * enums are spread from the module, so a new topic or source widens the spec
 * the day it is added rather than leaving the phone to fail a decode.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { AskKnowledgeBaseSchema } from '@/lib/schemas';
import { codedErrorResponses, op } from './helpers';
import { SOIL_SECTION_IDS, SOIL_SOURCE_IDS } from '@/lib/knowledge/soil-guide';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const SoilSourceSchema = z
    .object({
        id: z.enum([...SOIL_SOURCE_IDS]).openapi({
            description: 'Stable id. Treat one you do not know as an ordinary source: the list grows.',
        }),
        title: z.string().openapi({ description: 'The document\'s own title, always Bulgarian.' }),
        publisher: z.string().openapi({ description: 'In the requested language.' }),
        year: z.number().int(),
        url: z.string().openapi({ description: 'Where the document can be read in full.' }),
        kind: z.enum(['official', 'free-guide']).openapi({
            description:
                '`official` is a Bulgarian normative act or ministry document; `free-guide` is a freely published guide. Every topic is written in Agrent\'s own words either way — this says what kind of document to go and check.',
        }),
    })
    .openapi('SoilSource');

const SoilSectionSchema = z
    .object({
        id: z.enum([...SOIL_SECTION_IDS]).openapi({
            description: 'Stable id, also the anchor on the web page. Show a topic you do not know rather than dropping it: the list grows.',
        }),
        title: z.string(),
        summary: z.string().openapi({ description: 'One or two sentences for the topic list.' }),
        points: z.array(z.string()).openapi({
            description: 'The topic, one self-contained point per entry, in display order. Plain text — no markup.',
        }),
        sources: z.array(SoilSourceSchema).openapi({ description: 'The documents this topic summarises. Never empty.' }),
    })
    .openapi('SoilSection');

export function registerKnowledgePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/knowledge/soil-guide',
        operationId: 'getSoilGuide',
        summary: 'The «Почва» soil guide',
        description:
            'Seven topics on fertilising rules, slopes and water, manure, soil analysis, erosion and cover, organic matter and rotation, and soil life — Agrent\'s summaries of Bulgarian official documents and two free guides, each naming its sources.' +
            '\n\nThe same for every farm: the tenant in the path authenticates the caller and selects nothing. The web page and the assistant\'s `soil_guide` tool read the same content, so the three cannot disagree.',
        tags: ['Knowledge'],
        params: TenantParams,
        query: z.object({
            lang: z
                .string()
                .optional()
                .openapi({
                    param: { name: 'lang', in: 'query', required: false },
                    description:
                        '`en` or `bg`. Omitted, the caller\'s own interface language is used; any other value is Bulgarian. `Accept-Language` is ignored.',
                    example: 'bg',
                }),
        }),
        success: {
            status: 200,
            description: 'Every topic, in display order.',
            schema: z.object({ sections: z.array(SoilSectionSchema) }).openapi('SoilGuide'),
        },
    });

    // ── The satellite-imagery guide ──

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/knowledge/satellite-guide',
        operationId: 'getSatelliteGuideArticles',
        summary: 'The satellite-imagery guide articles',
        description:
            'GLOBAL articles only — rows with a null `tenantId`, selected by category. A '
            + 'farm cannot add to this guide or shadow it with its own article, which is '
            + 'what makes it a documentation surface rather than part of the general '
            + 'article list.\n\n'
            + '`?lang=` narrows to one language. **An unrecognised or missing value falls '
            + 'back to `bg`, NOT to `en`** — `DEFAULT_LOCALE` is `en` and is reserved for '
            + 'unauthenticated pre-login pages, while this route is always authenticated '
            + 'tenant traffic whose readers are Bulgarian by default. Sending `?lang=de` '
            + 'therefore returns Bulgarian rather than refusing or returning nothing.',
        tags: ['Knowledge'],
        params: TenantParams,
        query: z.object({
            lang: z.string().optional().openapi({
                description:
                    'A supported locale. Anything else — including absent — is read as `bg`.',
                example: 'bg',
            }),
        }),
        success: {
            status: 200,
            description: 'The guide articles in the resolved language.',
            schema: z.array(
                z
                    .object({
                        id: z.string(),
                        slug: z.string(),
                        title: z.string(),
                        summary: z.string().nullable(),
                        language: z.string().nullable(),
                    })
                    .openapi('SatelliteGuideArticle'),
            ),
        },
    });

    // ── Ask ──

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/knowledge/ask',
        operationId: 'askKnowledgeBase',
        summary: 'Ask the knowledge base a question',
        description:
            'Answers ONLY from retrieved sources, and the thing to get right as a client '
            + 'is which outcomes are errors.\n\n'
            + '**"The knowledge base had nothing to say" is a 200, not a 4xx.** When '
            + 'retrieval finds nothing the usecase returns a fixed, calibrated answer with '
            + '`sources: []` and never calls the model — so this route cannot fall through '
            + 'to an ungrounded completion. A real 4xx or 5xx therefore means the REQUEST '
            + 'failed: bad input, permission, rate limit, or a genuine server error. Those '
            + 'two cases must stay apart in a client; folding an empty retrieval into an '
            + 'error, or an error into the answer body, both mislead.\n\n'
            + '`sources` is a deliberate PROJECTION of the retrieved chunks: id, the '
            + 'human-legible provenance label, type and language. The chunk TEXT and its '
            + 'ranking `score` are withheld — they are internal ranking detail, not '
            + 'citation material, and a client rendering a score would be presenting '
            + 'retrieval confidence as if it were answer confidence.\n\n'
            + 'Unlike the sibling article routes, which sit on the coarser usecase-layer '
            + 'read gate, this one carries the AUDITED `knowledge.view` permission check '
            + 'and a rate limit of **10 requests per minute** per IP-and-user. Each call '
            + 'is a model call the farm pays for, so the rate bound exists alongside the '
            + 'monthly AI budget: a monthly cap alone permits a loop spending it in a '
            + 'minute.',
        tags: ['Knowledge'],
        params: TenantParams,
        body: AskKnowledgeBaseSchema,
        success: {
            status: 200,
            description:
                'The grounded answer and its citations. Also the shape returned when '
                + 'retrieval found nothing — a fixed answer with an EMPTY `sources`.',
            schema: z
                .object({
                    answer: z.string().openapi({
                        description:
                            'Grounded in `sources`. When `sources` is empty this is the '
                            + 'fixed "not in my sources" answer rather than a model '
                            + 'completion.',
                    }),
                    sources: z
                        .array(
                            z
                                .object({
                                    id: z.string(),
                                    source: z.string().openapi({
                                        description:
                                            'A human-legible provenance label, e.g. '
                                            + '"Knowledge base: <article title>". Render '
                                            + 'this as the citation.',
                                    }),
                                    sourceType: z.string(),
                                    language: z.string().nullable(),
                                })
                                .openapi('KnowledgeAskSource'),
                        )
                        .openapi({
                            description:
                                'EMPTY means retrieval found nothing — which is a '
                                + 'successful request with no grounded answer, not a '
                                + 'failure.',
                        }),
                })
                .openapi('KnowledgeAskResult'),
        },
        extraResponses: codedErrorResponses({
            400: 'Missing, empty-after-trim, or over-500-character `query`; or a body that '
                + 'is not parseable JSON. Uncoded — the message is the schema\'s own.',
            403: 'The `knowledge.view` permission is required, and unlike the article '
                + 'routes the refusal here is audited.',
            429: 'Over 10 requests per minute for this IP and user.',
        }),
    });
}
