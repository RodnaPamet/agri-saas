/**
 * Reading a newly published МЗХ document and suggesting what Agrent could do
 * with it — owner, 2026-11-26: "automatically analyze the content and ping me
 * with suggested integrations". It rides the daily discovery email (#3146):
 * each new document gets a short summary and concrete suggestions under it.
 *
 * ## Suggestions, never actions
 *
 * Nothing here changes the product. Every reference dataset in Agrent cites a
 * page, and the owner corrects it afterwards ("publish with sources, I will
 * correct it"); a model writing figures straight into those datasets would be
 * the opposite of that. So the output is advice to a person: what is new, and
 * where in the app it would belong. The person decides and someone builds it.
 *
 * ## Grounded in what Agrent already reads
 *
 * A suggestion is only useful if it knows what exists. The system prompt
 * lists, per МЗХ series, what the app already takes from it — so "the weekly
 * bulletin's grain prices" is recognised as already read, and the model is
 * asked for what is NOT yet used.
 *
 * Under the platform AI budget (#1423) like every platform job, recorded
 * whether or not the answer parses. A failure returns null and the email
 * goes out without the analysis: telling the owner a document appeared is the
 * part that must not depend on a model.
 */
import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

import { isPlatformAiSpendAllowed, recordPlatformAiUsage } from './platform-budget';

export const MZH_ANALYSIS_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
/** Characters of document text sent — the first ~25 pages of a dense PDF. */
export const MAX_DOCUMENT_CHARS = 60_000;

export const INTEGRATION_AREAS = ['calendar', 'benchmarks', 'thresholds', 'prices', 'progress', 'support', 'other'] as const;
export type IntegrationArea = (typeof INTEGRATION_AREAS)[number];

const SYSTEM_PROMPT = [
    'You read a document just published by the Bulgarian Ministry of Agriculture and Food (МЗХ)',
    'and tell the owner of Agrent, a farm-management app for Bulgarian farmers, what is in it',
    'and how the app could use it. Write in plain modern Bulgarian: short sentences, everyday words.',
    '',
    'What Agrent ALREADY takes from МЗХ, so you do not suggest it again:',
    '- «Оперативен анализ» (weekly bulletin): national average PURCHASE prices in EUR/t for bread',
    '  wheat, barley, maize, sunflower and rapeseed (shown in «Тенденции»), and the harvest and',
    '  sowing progress tables (harvested share, sown hectares vs last year), shown on «Табло».',
    '  NOT used: the fruit and vegetable wholesale prices, feed wheat, foreign trade, the text.',
    '- Technology cards («технологични карти»): sowing, fieldwork and harvest windows per crop in the',
    '  agronomic calendar, each cited to a page; costs per decare only from the wine-grape card.',
    '- The integrated-production guide: sowing windows, rates and depths for cereals and sunflower;',
    '  pest and disease economic thresholds per crop (shown on the crop page and «Риск»).',
    '- Coupled-support orders: the rate per hectare per scheme (fruit, vegetables, protein crops),',
    '  shown in «Подпомагане», the calculator and the calendar.',
    '- Agrostatistics: national average yields per crop.',
    '',
    'For this document say: what it is, what is NEW or changed compared with what Agrent uses,',
    'and 0 to 4 concrete suggestions, each naming where in the app it belongs and which figures or',
    'pages to take. Prefer a suggestion that updates something Agrent already shows (a newer',
    'campaign, a corrected window, a new crop card) over a new feature. If nothing in the document',
    'is useful to a farmer in the app, say so and give no suggestions. Never invent a figure:',
    'quote only what the document says, with its page when you can tell it.',
].join('\n');

const TOOL_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string', description: 'One or two sentences: what the document is.' },
        whatsNew: {
            type: 'string',
            description: 'What is new or different compared with what Agrent already uses. Empty if nothing.',
        },
        suggestions: {
            type: 'array',
            maxItems: 4,
            items: {
                type: 'object',
                properties: {
                    area: { type: 'string', enum: [...INTEGRATION_AREAS] },
                    title: { type: 'string', description: 'A few words.' },
                    detail: { type: 'string', description: 'What to take from the document and where it goes. One to three sentences.' },
                },
                required: ['area', 'title', 'detail'],
            },
        },
    },
    required: ['summary', 'whatsNew', 'suggestions'],
} as const;

export interface MzhDocumentToAnalyse {
    readonly series: string;
    readonly title: string | null;
    readonly url: string;
    readonly text: string;
}

export interface IntegrationSuggestion {
    readonly area: IntegrationArea;
    readonly title: string;
    readonly detail: string;
}

export interface MzhDocumentAnalysis {
    readonly summary: string;
    readonly whatsNew: string;
    readonly suggestions: readonly IntegrationSuggestion[];
    readonly model: string;
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The tool's answer, validated; null when it cannot be used. */
export function parseAnalysis(raw: unknown): Omit<MzhDocumentAnalysis, 'model'> | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as { summary?: unknown; whatsNew?: unknown; suggestions?: unknown };
    const summary = clean(r.summary, 600);
    if (!summary) return null;
    const suggestions: IntegrationSuggestion[] = [];
    for (const s of Array.isArray(r.suggestions) ? r.suggestions.slice(0, 4) : []) {
        const o = (s ?? {}) as { area?: unknown; title?: unknown; detail?: unknown };
        const area = (INTEGRATION_AREAS as readonly string[]).includes(o.area as string) ? (o.area as IntegrationArea) : 'other';
        const title = clean(o.title, 120);
        const detail = clean(o.detail, 600);
        if (title && detail) suggestions.push({ area, title, detail });
    }
    return { summary, whatsNew: clean(r.whatsNew, 800), suggestions };
}

export function isMzhAnalysisConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
}

export async function analyseMzhDocument(doc: MzhDocumentToAnalyse): Promise<MzhDocumentAnalysis | null> {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey || doc.text.trim().length === 0) return null;
    if (!(await isPlatformAiSpendAllowed('mzh-document-analysis'))) {
        logger.warn('mzh-analysis skipped: the platform AI budget is exhausted', { component: 'ai', model: MZH_ANALYSIS_MODEL });
        return null;
    }

    try {
        const client = new Anthropic({ apiKey, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
        const response = await client.messages.create({
            model: MZH_ANALYSIS_MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: [
                    `Series: ${doc.series}`,
                    `Title: ${doc.title ?? '(none on the listing page)'}`,
                    `URL: ${doc.url}`,
                    '',
                    'Document text (may be cut short):',
                    doc.text.slice(0, MAX_DOCUMENT_CHARS),
                ].join('\n'),
            }],
            tools: [{
                name: 'mzh_document_analysis',
                description: 'Return the summary and the integration suggestions as structured data.',
                input_schema: TOOL_INPUT_SCHEMA as unknown as Anthropic.Messages.Tool.InputSchema,
            }],
            tool_choice: { type: 'tool', name: 'mzh_document_analysis' },
        });

        // Charged before parsing, unconditionally — the field-briefing rule.
        await recordPlatformAiUsage({
            job: 'mzh-document-analysis',
            model: MZH_ANALYSIS_MODEL,
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
        });

        const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'mzh_document_analysis');
        const parsed = block && block.type === 'tool_use' ? parseAnalysis(block.input) : null;
        if (!parsed) {
            logger.warn('mzh-analysis output failed validation', { component: 'ai', model: MZH_ANALYSIS_MODEL, url: doc.url });
            return null;
        }
        return { ...parsed, model: MZH_ANALYSIS_MODEL };
    } catch (err) {
        logger.warn('mzh-analysis call failed', {
            component: 'ai',
            model: MZH_ANALYSIS_MODEL,
            url: doc.url,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
