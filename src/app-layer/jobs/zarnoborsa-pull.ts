/**
 * Read the ZarnoBorsa handoff file and ingest it (#3081).
 *
 * ## The half of the pair that has Prisma
 *
 * The fetch runs in a Playwright container and writes one JSON document,
 * because Playwright may not be in this product's image. This job runs in the
 * worker, where Prisma is, and does the database work. That split is the whole
 * reason there is a file between them.
 *
 * ## It reports `unaudited` for a MISSING file, which is the point
 *
 * A missing file and a file saying "I saw nothing" are different findings, and
 * both are `unaudited` rather than `clean` — the fetch container may not be
 * running, the login may be unset, or the schedule may have drifted. A run
 * that found no file and reported success is how a dead feed reads as a quiet
 * market, and with the owner's full-precedence ruling these figures drive the
 * grain calculator.
 *
 * ## And it refuses a STALE file
 *
 * The handoff is a file, so yesterday's document is still there when today's
 * fetch fails. Re-ingesting it would be harmless to the DATA — points are
 * keyed on their own row dates and upserted — but it would report `clean`
 * about a fetch that never happened, which is the one thing the verdict exists
 * to prevent. So a document older than the window is `unaudited`.
 */
import { readFileSync, existsSync, statSync } from 'fs';

import { logger } from '@/lib/observability/logger';
import { ZarnoBorsaRow } from '@/lib/market/zarnoborsa-parse';

import { ingestZarnoBorsaRows, ZarnoBorsaIngestResult } from './zarnoborsa-ingest';

/** Where the fetch container writes, matching the compose mount. */
export const ZARNOBORSA_HANDOFF = '/var/lib/agrent/zarnoborsa/latest.json';

/**
 * How old a handoff may be and still count as this run's.
 *
 * Nine hours, against reads at 08:00 / 13:00 / 18:00: the widest gap between
 * consecutive reads is five hours (18:00 → 08:00 is fourteen, but that gap
 * spans a night during which no read is expected to be fresh anyway), so nine
 * accepts the most recent read and refuses one that is a whole cycle old.
 * Tighten it when the update pattern is known and the schedule narrows.
 */
export const ZARNOBORSA_MAX_AGE_HOURS = 9;

export interface ZarnoBorsaPullResult extends ZarnoBorsaIngestResult {
    /** Why a run wrote nothing, when it wrote nothing. */
    reason: 'ok' | 'no-file' | 'stale' | 'unreadable';
    handoffAgeMinutes: number | null;
}

interface HandoffDoc {
    fetchedAt?: string;
    locked?: boolean;
    rows?: ZarnoBorsaRow[];
    skipped?: number;
}

export async function runZarnoBorsaPull(
    now: Date = new Date(),
    path: string = ZARNOBORSA_HANDOFF,
): Promise<ZarnoBorsaPullResult> {
    const blank = (reason: ZarnoBorsaPullResult['reason'], age: number | null): ZarnoBorsaPullResult => ({
        verdict: 'unaudited',
        received: 0, kept: 0, mapped: 0,
        seriesTouched: 0, pointsWritten: 0, unmappedProducts: [],
        reason, handoffAgeMinutes: age,
    });

    if (!existsSync(path)) {
        const out = blank('no-file', null);
        logger.warn('zarnoborsa_pull.reading', { component: 'zarnoborsa-pull', ...out });
        return out;
    }

    let doc: HandoffDoc;
    let ageMinutes: number;
    try {
        const stat = statSync(path);
        ageMinutes = Math.round((now.getTime() - stat.mtimeMs) / 60_000);
        doc = JSON.parse(readFileSync(path, 'utf8')) as HandoffDoc;
    } catch {
        // A truncated write — the fetch container killed mid-`writeFileSync` —
        // is UNREADABLE, not empty. Reporting it as zero rows would be a
        // claim about the market rather than about the file.
        const out = blank('unreadable', null);
        logger.error('zarnoborsa_pull.reading', { component: 'zarnoborsa-pull', ...out });
        return out;
    }

    if (ageMinutes > ZARNOBORSA_MAX_AGE_HOURS * 60) {
        const out = blank('stale', ageMinutes);
        logger.warn('zarnoborsa_pull.reading', { component: 'zarnoborsa-pull', ...out });
        return out;
    }

    /*
     * `Boolean(...)` and NOT `=== true`, which a mutation corrected.
     *
     * The two agree on an ABSENT flag — both read it as not locked, which is
     * what an older fetch bundle predating the field means by saying nothing,
     * and discarding its rows would be wrong.
     *
     * They differ on a TRUTHY NON-TRUE value, and there `=== true` fails in
     * the UNSAFE direction: a paywalled read whose flag serialised as
     * `"false"` or `1` would be treated as unlocked and its August prices
     * ingested. With `Boolean`, anything truthy locks the read — so a
     * malformed flag costs one missed cycle instead of corrupting the figures
     * the grain calculator uses.
     *
     * The mutation that found this swapped the two and left every test green,
     * because the suite only exercised absence. Failing toward "refuse" is the
     * cheap direction, and it is now the one taken.
     */
    const result = await ingestZarnoBorsaRows(doc.rows ?? [], { locked: Boolean(doc.locked) });
    const out: ZarnoBorsaPullResult = {
        ...result,
        reason: 'ok',
        handoffAgeMinutes: ageMinutes,
    };

    // The READING. Every denominator the ingest produced, plus the file's age
    // and the fetch's own skip count — so `pointsWritten: 0` always comes with
    // enough beside it to say WHY, and never a price.
    const line = {
        component: 'zarnoborsa-pull',
        fetchedAt: doc.fetchedAt ?? null,
        fetchSkipped: doc.skipped ?? null,
        ...out,
    };
    if (out.verdict === 'clean') logger.info('zarnoborsa_pull.reading', line);
    else logger.warn('zarnoborsa_pull.reading', line);

    return out;
}
