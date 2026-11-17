/**
 * `/api/agro-benchmarks` and `/api/agro-thresholds` — published reference
 * figures about Bulgarian agriculture (agrent-ios#638, #636).
 *
 * The same family as `agro-calendar.paths.ts`: person-scoped, farm-free,
 * identical for every farm, with a citation per figure. Kept out of
 * `agro.paths.ts`, which documents the FARM's own agronomy.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const Localised = z.object({ bg: z.string(), en: z.string().optional() });

const Sources = z
    .record(
        z.string(),
        z.object({
            title: z.string(),
            publisher: z.string().openapi({ example: 'МЗХ' }),
            url: z.string(),
            published: z.string().optional(),
        }),
    )
    .openapi({ description: 'Every `cite.source` in this response is a key here; the server refuses to load a dataset where one is not.' });

const CompiledAt = z.string().openapi({ format: 'date', example: '2026-11-17' });

export function registerAgroReferencePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/agro-benchmarks',
        operationId: 'getAgroBenchmarks',
        summary: 'National average yields and coupled-support rates',
        description:
            'Bulgarian national average yields per crop (МЗХ Agrostatistics) and coupled-support rates per eligible hectare (the minister\'s order and the ДФЗ notice). **Every figure carries a citation.**' +
            '\n\n**Person-scoped and farm-free**, like `GET /api/agro-calendar`: no `tenantSlug`, identical for every farm. Not behind a feature flag.' +
            '\n\n**Figures are as printed and never converted.** Yields are kg/ha — divide by 10 for kg/дка, which is exact. Rates are integer minor units of the order\'s own `currency` (стотинки for BGN): `25474` is 254,74 лв/ha. A converted figure is a number no cited page supports.' +
            '\n\nAn unknown `commodity` is a **400, never an empty list** — an empty list would read as "covered, no figure".',
        tags: ['Agro'],
        query: z.object({
            commodity: z.string().optional().openapi({
                param: { name: 'commodity', in: 'query' },
                description:
                    'A commodity slug. Returns its yield and every support scheme whose `commodities` lists it.',
                example: 'wheat',
            }),
        }),
        success: {
            status: 200,
            description: 'Yields and support rates, filtered to one commodity when asked.',
            schema: z
                .object({
                    schemaVersion: z.number(),
                    compiledAt: CompiledAt,
                    conventions: z.array(z.string()),
                    sources: Sources,
                    yields: z.array(
                        z.object({
                            commodity: z.string().openapi({ example: 'wheat' }),
                            label: Localised,
                            harvest: z.number().int().openapi({ example: 2024 }),
                            kgPerHa: z.number().int().openapi({ example: 5731 }),
                            cite: z.object({
                                source: z.string(),
                                page: z.union([z.number(), z.string()]).optional(),
                                point: z.string().optional(),
                            }),
                            note: Localised.optional(),
                        }),
                    ),
                    supportRates: z.array(
                        z.object({
                            scheme: z.string().openapi({ example: 'protein' }),
                            label: Localised,
                            campaign: z.number().int().openapi({ example: 2024 }),
                            currency: z.enum(['BGN', 'EUR']),
                            perHaStotinki: z.number().int().openapi({
                                example: 25474,
                                description: 'Integer minor units of `currency` per eligible hectare.',
                            }),
                            perHaOver30Stotinki: z.number().int().optional().openapi({
                                description: 'The rate above the 30th eligible hectare, where the order sets one. Never higher than `perHaStotinki`.',
                            }),
                            commodities: z.array(z.string()).optional().openapi({
                                description: 'The commodity slugs the scheme covers, where it maps onto them.',
                            }),
                            cite: z.object({
                                source: z.string(),
                                page: z.union([z.number(), z.string()]).optional(),
                                point: z.string().optional().openapi({ example: 'I' }),
                            }),
                        }),
                    ),
                })
                .openapi('AgroBenchmarks'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/agro-thresholds',
        operationId: 'getAgroThresholds',
        summary: 'Pest and disease thresholds (ПИВ) per crop',
        description:
            'From МЗХ\'s integrated-production guide: for each pest or disease, the crops it attacks and, per growth stage, the level above which control is justified. **Every entry carries its guide page.**' +
            '\n\n**Person-scoped and farm-free**, like `GET /api/agro-calendar`. Not behind a feature flag.' +
            '\n\n`threshold` is the guide\'s own wording, not a number with a unit — the guide mixes counts, percentages and damage descriptions, and splitting them would invent a structure the page does not support.' +
            '\n\nAn unknown `crop` is a **400, never an empty list** — "no thresholds" for an uncovered crop is a different claim from "nothing to watch".',
        tags: ['Agro'],
        query: z.object({
            crop: z.string().optional().openapi({
                param: { name: 'crop', in: 'query' },
                description: 'A commodity slug. Returns every threshold whose `crops` lists it.',
                example: 'wheat',
            }),
        }),
        success: {
            status: 200,
            description: 'Thresholds, filtered to one crop when asked.',
            schema: z
                .object({
                    schemaVersion: z.number(),
                    compiledAt: CompiledAt,
                    conventions: z.array(z.string()),
                    sources: Sources,
                    thresholds: z.array(
                        z.object({
                            id: z.string().openapi({ example: 'powdery-mildew' }),
                            kind: z.enum(['disease', 'pest']),
                            name: Localised,
                            latin: z.string().openapi({ example: 'Blumeria graminis' }),
                            crops: z.array(z.string()),
                            levels: z.array(
                                z.object({
                                    stage: Localised.openapi({ description: 'The growth stage or season, as the guide words it.' }),
                                    threshold: Localised,
                                }),
                            ),
                            cite: z.object({
                                source: z.string(),
                                page: z.union([z.number(), z.string()]),
                            }),
                            note: Localised.optional(),
                        }),
                    ),
                })
                .openapi('AgroThresholds'),
        },
    });
}
