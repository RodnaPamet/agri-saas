/**
 * support-scheme-extraction — WEEKLY job turning already-ingested,
 * policy-category `MarketNewsItem` headlines into PROPOSED `SupportScheme`
 * rows via Claude Haiku.
 *
 * Sibling of `news-event-extraction`, deliberately: same input, same safety
 * helpers, same PROPOSED-until-approved model, different output shape. See
 * `src/app-layer/ai/support-scheme-extractor.ts` for why this is one pipeline
 * with two typed consumers rather than two pipelines.
 *
 * WEEKLY, not daily. A support scheme's application window is announced weeks
 * or months ahead — the thing this job is looking for does not change between
 * Tuesday and Wednesday, and the news-event job already runs daily over the
 * same corpus for the date-points that do. The lookback window widens to match
 * (8 days, with overlap so a missed run is caught up).
 *
 * Nothing here ever promotes a row to APPROVED. That is exclusively a
 * platform-admin action, and it is the backstop the whole design rests on: a
 * farmer who misses a real ДФЗ window because an extracted date was three days
 * off suffers direct financial harm, so no AI-derived row reaches a tenant
 * without a human having looked at it.
 *
 * Idempotency: `SupportScheme`'s `@@unique([sourceNewsItemId, measureCode])`
 * is the claim key, written through `createMany({ skipDuplicates: true })` —
 * the AgroSignal claim pattern. A re-run over an overlapping window never
 * duplicates.
 *
 * There is no `AiUsageEvent` ledger available here (that table requires a
 * non-null `tenantId` and this is a GLOBAL job), so token/cost accounting is
 * an explicit `logger.info` line.
 *
 * @module jobs/support-scheme-extraction
 */
import type { PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { estimateCostMicros } from '../ai/cost';
import {
    extractSupportSchemes,
    isSupportSchemeExtractionConfigured,
    type NewsPolicyItemInput,
} from '../ai/support-scheme-extractor';
import type { SupportSchemeExtractionPayload } from './types';

const COMPONENT = 'support-scheme-extraction';
const EXTRACTION_MODEL = 'claude-haiku-4-5';

/** Weekly schedule with a day of overlap, so a single missed run is caught up. */
const DEFAULT_LOOKBACK_HOURS = 8 * 24;

/** Defensive cap. Never trust upstream volume unconditionally. */
const MAX_ITEMS_PER_RUN = 120;

/** The two Prisma delegates this job touches (both GLOBAL tables). */
type SupportSchemeDbClient = Pick<PrismaClient, 'marketNewsItem' | 'supportScheme'>;

/** Injectable seams so tests drive the job without a real Anthropic call or DB. */
export interface SupportSchemeExtractionDeps {
    db?: SupportSchemeDbClient;
    extractImpl?: typeof extractSupportSchemes;
    /** Clock injection for a deterministic lookback cutoff in tests. */
    now?: () => Date;
}

export interface SupportSchemeExtractionResult {
    /** Policy items considered this run. */
    scanned: number;
    /** Schemes the extractor returned after its own backstops. */
    extracted: number;
    /** Rows actually inserted (post-dedup). */
    created: number;
    /** Extracted schemes that collided with an existing row. */
    skipped: number;
}

const EMPTY_RESULT: SupportSchemeExtractionResult = {
    scanned: 0,
    extracted: 0,
    created: 0,
    skipped: 0,
};

export async function runSupportSchemeExtraction(
    payload: SupportSchemeExtractionPayload = {},
    deps: SupportSchemeExtractionDeps = {},
): Promise<SupportSchemeExtractionResult> {
    const db = (deps.db ?? prisma) as SupportSchemeDbClient;
    const doExtract = deps.extractImpl ?? extractSupportSchemes;
    const now = (deps.now ?? (() => new Date()))();

    // Defensive. The schedule only registers when the key is set (see
    // schedules.ts), but ad-hoc / manual / API-triggered runs reach this
    // executor regardless, and a key-less environment must no-op cleanly
    // rather than throw.
    if (!isSupportSchemeExtractionConfigured()) {
        logger.info('support-scheme-extraction: skipped — ANTHROPIC_API_KEY not configured', {
            component: COMPONENT,
        });
        return EMPTY_RESULT;
    }

    const lookbackHours = payload.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    const cutoff = new Date(now.getTime() - lookbackHours * 3_600_000);

    // `category: 'policy'` is set by lib/news/categorize.ts, which tags the
    // Bulgarian stems субсиди / дфз / фонд земедели / плащан / регламент with
    // the documented rationale "CAP deadlines, subsidy windows, regulation
    // changes". That is exactly this job's subject, so the filter is reused
    // rather than re-derived.
    const policyItems = await db.marketNewsItem.findMany({
        where: { category: 'policy', publishedAt: { gt: cutoff } },
        select: { id: true, title: true, summary: true, url: true, publishedAt: true },
        orderBy: { publishedAt: 'desc' },
        take: MAX_ITEMS_PER_RUN,
    });

    if (policyItems.length === 0) {
        logger.info('support-scheme-extraction: no policy items in the lookback window', {
            component: COMPONENT,
            lookbackHours,
        });
        return EMPTY_RESULT;
    }

    const input: NewsPolicyItemInput[] = policyItems.map((it) => ({
        id: it.id,
        title: it.title,
        summary: it.summary,
        url: it.url,
        publishedAt: it.publishedAt.toISOString(),
    }));

    const { schemes, usage } = await doExtract(input, { now });

    if (usage) {
        const costMicros = estimateCostMicros(EXTRACTION_MODEL, {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
        });
        logger.info('support-scheme-extraction: ai usage', {
            component: COMPONENT,
            model: EXTRACTION_MODEL,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            costMicros,
        });
    }

    if (schemes.length === 0) {
        return { scanned: policyItems.length, extracted: 0, created: 0, skipped: 0 };
    }

    const itemsById = new Map(policyItems.map((it) => [it.id, it]));
    const rows = schemes
        .map((s) => {
            // Defensive only — the extractor's backstops already drop any
            // scheme citing an id outside the supplied set.
            const source = itemsById.get(s.sourceNewsItemId);
            if (!source) return null;
            return {
                title: s.title,
                summary: s.eligibilitySummary ?? null,
                authority: s.authority,
                measureCode: s.measureCode ?? null,
                status: s.status,
                applicationOpensAt: s.applicationOpensAt
                    ? new Date(`${s.applicationOpensAt}T00:00:00.000Z`)
                    : null,
                applicationClosesAt: s.applicationClosesAt
                    ? new Date(`${s.applicationClosesAt}T00:00:00.000Z`)
                    : null,
                eligibilitySummary: s.eligibilitySummary ?? null,
                sourceUrl: source.url,
                // The provenance that keeps an AI reading distinguishable from
                // an official announcement, on screen and in the database.
                source: 'ai-news',
                sourceNewsItemId: s.sourceNewsItemId,
                sourceTitle: source.title,
                confidence: s.confidence,
                sourceExcerpt: s.sourceExcerpt,
                extractedAt: now,
                // PROPOSED. Never anything else from this job.
            };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

    const { count: created } = await db.supportScheme.createMany({
        data: rows,
        skipDuplicates: true,
    });

    logger.info('support-scheme-extraction: complete', {
        component: COMPONENT,
        scanned: policyItems.length,
        extracted: schemes.length,
        created,
        skipped: schemes.length - created,
    });

    return {
        scanned: policyItems.length,
        extracted: schemes.length,
        created,
        skipped: schemes.length - created,
    };
}
