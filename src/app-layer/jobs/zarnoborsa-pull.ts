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
import { readFileSync, openSync, fstatSync, closeSync } from 'fs';

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

    /*
     * NO `existsSync` BEFORE THE READ, and CodeQL was right to call the first
     * version a high-severity TOCTOU: it checked existence, then separately
     * stat'ed and read, so the file could change in between.
     *
     * The window is not theoretical here — the fetch container writes into
     * this volume on its own schedule, so "the file appeared, vanished or was
     * being rewritten between the check and the read" is exactly the race a
     * second process creates.
     *
     * So the existence question is answered by ATTEMPTING the read and
     * reading the error CODE: `ENOENT` is no-file, anything else is
     * unreadable. One decision from one set of syscalls, and strictly more
     * informative than the check it replaces — a permissions failure now
     * reports `unreadable` instead of being mistaken for a present file that
     * failed to parse.
     */
    let doc: HandoffDoc;
    let ageMinutes: number;
    try {
        /*
         * ONE DESCRIPTOR for both the age and the contents.
         *
         * Dropping `existsSync` was not enough, and CodeQL said so again:
         * `statSync(path)` followed by `readFileSync(path)` is still two
         * operations resolving the same name, so the file can change between
         * them — and then the age belongs to one document and the bytes to
         * another. For a reader whose entire job is deciding whether a
         * document is too old to trust, that is the wrong pair to get wrong.
         *
         * `openSync` once, `fstatSync` and `readFileSync` on the DESCRIPTOR:
         * both answers come from the same file, whatever happens to the path
         * afterwards. `openSync` is also what raises `ENOENT`, so the
         * no-file verdict still comes from the attempt rather than a check.
         */
        const fd = openSync(path, 'r');
        try {
            ageMinutes = Math.round((now.getTime() - fstatSync(fd).mtimeMs) / 60_000);
            doc = JSON.parse(readFileSync(fd, 'utf8')) as HandoffDoc;
        } finally {
            closeSync(fd);
        }
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT') {
            const out = blank('no-file', null);
            logger.warn('zarnoborsa_pull.reading', { component: 'zarnoborsa-pull', ...out });
            return out;
        }
        // A truncated write, a permissions failure, or malformed JSON is
        // UNREADABLE — not empty. Reporting it as zero rows would be a claim
        // about the market rather than about the file.
        const out = blank('unreadable', null);
        logger.error('zarnoborsa_pull.reading', {
            component: 'zarnoborsa-pull', code: code ?? 'parse', ...out,
        });
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
