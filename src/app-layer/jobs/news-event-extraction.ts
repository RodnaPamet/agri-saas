/**
 * news-event-extraction — daily job (calendar roadmap PR 3) that turns
 * already-ingested, policy-category `MarketNewsItem` headlines into
 * PROPOSED `NewsDerivedEvent` rows via Claude Haiku.
 *
 * Feeds ONLY `MarketNewsItem` rows with `category: 'policy'` AND
 * `publishedAt` within the lookback window — see
 * `src/app-layer/ai/news-event-extractor.ts` for the extraction +
 * anti-hallucination logic. Every row this job writes lands as
 * PROPOSED; nothing here ever promotes a row to APPROVED — that is
 * exclusively a platform-admin action (see
 * `src/app-layer/usecases/news-derived-events.ts`).
 *
 * "lastRunAt" is a ROLLING LOOKBACK WINDOW, not a persisted cursor:
 * there is no per-job execution ledger in this codebase to hang a true
 * "last run" timestamp off, and the daily cadence + idempotent
 * unique-key write make a fixed window both simpler and safe — a
 * missed run is caught up as long as the gap is under
 * `DEFAULT_LOOKBACK_HOURS`. See the design tradeoff in
 * docs/implementation-notes/2026-08-06-ai-news-calendar-events.md (an
 * outage longer than the window silently drops the oldest policy items
 * from consideration — acceptable for an ADVISORY, human-approved
 * feature, not a compliance-critical one).
 *
 * Idempotency: `NewsDerivedEvent`'s `@@unique([sourceNewsItemId, kind])`
 * is the claim key. Writes go through `createMany({ skipDuplicates:
 * true })` (the `AgroSignal` claim pattern in `agro-signals.ts`) so a
 * daily re-run over an overlapping window never duplicates.
 * Re-extracting an already-processed article on the next run is a
 * deliberate, accepted cost rather than tracking "already considered,
 * zero output" in a second table — at a handful of policy
 * headlines/day on Haiku this is sub-cent.
 *
 * There is no `AiUsageEvent` ledger available here — that table
 * requires a non-null `tenantId` and this is a GLOBAL job — so
 * token/cost accounting is an explicit `logger.info` line instead.
 *
 * @module jobs/news-event-extraction
 */
import type { PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { estimateCostMicros } from '../ai/cost';
import {
    extractNewsEvents,
    isNewsEventExtractionConfigured,
    type NewsPolicyItemInput,
} from '../ai/news-event-extractor';
import type { NewsEventExtractionPayload } from './types';

const COMPONENT = 'news-event-extraction';
const EXTRACTION_MODEL = 'claude-haiku-4-5';
/** Daily schedule (see schedules.ts) with overlap so a brief outage
 *  doesn't drop items that never got a chance to run. */
const DEFAULT_LOOKBACK_HOURS = 36;
/** Defensive cap. The policy slice is "a handful" per feed/day in
 *  practice, but never trust upstream volume unconditionally. */
const MAX_ITEMS_PER_RUN = 60;

/** The two Prisma delegates this job touches (both GLOBAL cache tables). */
type NewsDbClient = Pick<PrismaClient, 'marketNewsItem' | 'newsDerivedEvent'>;

/** Injectable seams so tests drive the job without a real Anthropic call or DB. */
export interface NewsEventExtractionDeps {
    db?: NewsDbClient;
    extractImpl?: typeof extractNewsEvents;
    /** Clock injection for a deterministic lookback cutoff in tests. */
    now?: () => Date;
}

export interface NewsEventExtractionResult {
    /** Policy items considered this run. */
    scanned: number;
    /** Events the extractor returned after its own backstops. */
    extracted: number;
    /** Rows actually inserted (post-dedup). */
    created: number;
    /** Extracted events that collided with an existing row this run. */
    skipped: number;
}

const EMPTY_RESULT: NewsEventExtractionResult = { scanned: 0, extracted: 0, created: 0, skipped: 0 };

export async function runNewsEventExtraction(
    payload: NewsEventExtractionPayload = {},
    deps: NewsEventExtractionDeps = {},
): Promise<NewsEventExtractionResult> {
    const db = (deps.db ?? prisma) as NewsDbClient;
    const doExtract = deps.extractImpl ?? extractNewsEvents;
    const now = (deps.now ?? (() => new Date()))();

    // Defensive — the schedule itself only registers when the key is set
    // (see schedules.ts), but ad-hoc/manual/API-triggered runs can reach
    // this executor regardless. A key-less environment must still no-op
    // cleanly rather than throw.
    if (!isNewsEventExtractionConfigured()) {
        logger.info('news-event-extraction: skipped — ANTHROPIC_API_KEY not configured', {
            component: COMPONENT,
        });
        return EMPTY_RESULT;
    }

    const lookbackHours = payload.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

    const policyItems = await db.marketNewsItem.findMany({
        where: {
            category: 'policy',
            publishedAt: { gt: cutoff },
        },
        select: { id: true, title: true, summary: true, url: true, publishedAt: true },
        orderBy: { publishedAt: 'desc' },
        take: MAX_ITEMS_PER_RUN,
    });

    if (policyItems.length === 0) {
        logger.info('news-event-extraction: no policy items in the lookback window', {
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

    const { events, usage } = await doExtract(input, { now });

    if (usage) {
        const costMicros = estimateCostMicros(EXTRACTION_MODEL, {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
        });
        logger.info('news-event-extraction: ai usage', {
            component: COMPONENT,
            model: EXTRACTION_MODEL,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            costMicros,
        });
    }

    if (events.length === 0) {
        return { scanned: policyItems.length, extracted: 0, created: 0, skipped: 0 };
    }

    const itemsById = new Map(policyItems.map((it) => [it.id, it]));
    const rows = events
        .map((ev) => {
            // Defensive only — the extractor's own backstops already drop
            // any event whose sourceNewsItemId isn't in the supplied set.
            const source = itemsById.get(ev.sourceNewsItemId);
            if (!source) return null;
            return {
                title: ev.title,
                kind: ev.kind,
                eventDate: new Date(`${ev.eventDate}T00:00:00.000Z`),
                confidence: ev.confidence,
                sourceExcerpt: ev.sourceExcerpt,
                sourceNewsItemId: ev.sourceNewsItemId,
                sourceUrl: source.url,
                sourceTitle: source.title,
            };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

    // Idempotent claim — mirrors AgroSignal's createMany({ skipDuplicates })
    // pattern (agro-signals.ts). A re-run over an overlapping lookback
    // window never duplicates a (sourceNewsItemId, kind) row.
    const { count: created } = await db.newsDerivedEvent.createMany({
        data: rows,
        skipDuplicates: true,
    });

    logger.info('news-event-extraction: complete', {
        component: COMPONENT,
        scanned: policyItems.length,
        extracted: events.length,
        created,
        skipped: events.length - created,
    });

    return {
        scanned: policyItems.length,
        extracted: events.length,
        created,
        skipped: events.length - created,
    };
}
