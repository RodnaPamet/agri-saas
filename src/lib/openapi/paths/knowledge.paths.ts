/**
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
import { op } from './helpers';
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
}
