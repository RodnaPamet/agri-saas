/**
 * Watch the documents the agro calendar CITES, and flag one that changed
 * (#3146, first slice of the server half of agrent-ios#639).
 *
 * In `jobs/` and not `usecases/` for `mzh-prices-pull`'s reason: there is no
 * `RequestContext`, no tenant and no policy check to make, because a cited
 * publication is a global artefact with no farm. `no-direct-prisma` would
 * refuse this file in `usecases/` and would be right to.
 *
 * ## The signal is a CHANGE, not a discovery
 *
 * agrent-ios#639 asks for five МЗХ series to be watched for new documents.
 * This slice does the half that is a correctness problem rather than a
 * feature: the 13 documents `citedSourceUrls()` returns are the pages that
 * SUPPORT published agronomic figures, and if one of them is revised, a
 * calendar window may no longer say what its citation says. Nothing in this
 * product would ever notice. Discovery of NEW documents needs a listing page
 * per series and is the second slice — see #3146, which records that URL
 * construction demonstrably does not work for this publisher.
 *
 * ## The series comes from the CITATION KEY, never the URL
 *
 * Measured over all 13 today, and this is the one design decision worth not
 * re-deriving. The filenames are МЗХ's CMS output and are not consistent:
 * of the four technology cards exactly ONE is named `tk_vineni_lozia.pdf`,
 * while the other three are `kanventsionalno_otglezhdane_…` /
 * `konventsionalno_…` — МЗХ's own typo, two spellings across three sibling
 * documents. A filename classifier would place 1 of 4. The dataset's own
 * `mzh-tk-*` slug places 4 of 4, because it is a curated fact rather than a
 * CMS artefact. Two bulletins additionally carry a random suffix
 * (`…_Nd73T7O.pdf`), which is what #3136 measured when it rejected building
 * these URLs rather than reading them off a page.
 *
 * An unrecognised prefix classifies as `null`. Guessing is the thing #3136
 * established does not work here, and a wrong series label is worse than an
 * absent one: it would put a document in a series whose reader expects a
 * different shape.
 *
 * ## The verdict is five-valued, and the denominator is reported beside it
 *
 * `0 changed` is ambiguous between "every citation still holds" and "nothing
 * could be read", and the two want opposite responses — so `partial` and
 * `unreachable` are separate from `clean`. `no-citations` exists because a
 * count of zero over an EMPTY population satisfies "nothing changed"
 * vacuously, which is the trap P8.9's ciphertext check records: a zero needs
 * its denominator next to it.
 */
import { citedSourceUrls } from '@/lib/agro/calendar/load';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { measureDocument, type DocumentFetchOptions } from '@/lib/sources/document-fetch';

/**
 * Series slugs, keyed by the citation-key PREFIX that identifies them.
 *
 * Only the three series that are actually cited today appear here.
 * agrent-ios#639 names five; the coupled-support orders and the annual
 * «Аграрен доклад» are cited by nothing yet, so there is no observed prefix
 * to map and inventing one would be a label nothing produces.
 */
export const SERIES_BY_CITATION_PREFIX: ReadonlyArray<readonly [string, string]> = [
    ['mzh-oa-', 'operativen-analiz'],
    ['mzh-tk-', 'technology-card'],
    ['mzh-ip-', 'integrated-production'],
];

/** The series a citation belongs to, or null when its prefix is unrecognised. */
export function seriesForCitation(citation: string): string | null {
    for (const [prefix, series] of SERIES_BY_CITATION_PREFIX) {
        if (citation.startsWith(prefix)) return series;
    }
    return null;
}

/**
 * A bound on the baseline read, so the `findMany` is not `take:`-less.
 *
 * The real bound is the dataset: `citedSourceUrls()` returns one entry per
 * distinct citation in the committed calendar, 13 today. 500 is slack of
 * ~38x against a file a human edits, and it is here so the query has a
 * ceiling that does not depend on reading the dataset to know it.
 */
export const WATCH_READ_CAP = 500;

export type WatchVerdict =
    /** Every citation was read and still hashes to its baseline. */
    | 'clean'
    /** At least one document changed since it was last accepted. */
    | 'changed'
    /** Some documents could not be read; the rest were fine. */
    | 'partial'
    /** NONE could be read — the publisher is down, or we are. */
    | 'unreachable'
    /** The calendar cites nothing, so `0 changed` would be vacuous. */
    | 'no-citations';

export interface WatchFailure {
    citation: string;
    failure: string;
    detail: string;
}

export interface SourceDocumentWatchResult {
    verdict: WatchVerdict;
    /** The DENOMINATOR: how many citations the calendar offered this run. */
    watched: number;
    /** Rows minted this run — a citation seen for the first time. */
    firstSeen: number;
    /** Read and identical to the stored baseline. */
    unchanged: number;
    /** NEWLY flagged this run. The headline number. */
    changed: number;
    /**
     * Read, different from the baseline, and ALREADY flagged with these same
     * bytes. Counted apart from `changed` so a standing flag does not read as
     * a fresh incident every day.
     */
    alreadyFlagged: number;
    /** Could not be read. Named, because which one matters. */
    failures: WatchFailure[];
    /** Citations whose series prefix is unrecognised — never guessed. */
    unclassified: string[];
    /** Total rows carrying an un-promoted flag, including older ones. */
    flaggedTotal: number;
}

/**
 * Check every cited document once.
 *
 * Sequential on purpose. Thirteen parallel requests at a government CMS is
 * not a load we have any reason to apply, and nothing waits on this job —
 * it runs once a day and its output is a log line.
 */
export async function runSourceDocumentWatch(
    opts: DocumentFetchOptions = {},
): Promise<SourceDocumentWatchResult> {
    const cited = citedSourceUrls();

    const result: SourceDocumentWatchResult = {
        verdict: 'no-citations',
        watched: cited.length,
        firstSeen: 0,
        unchanged: 0,
        changed: 0,
        alreadyFlagged: 0,
        failures: [],
        unclassified: [],
        flaggedTotal: 0,
    };

    if (cited.length === 0) {
        // Not a success. The calendar citing nothing is either a dataset
        // regression or an extraction that stopped matching, and either way
        // reporting `clean` over an empty set is the lie this verdict exists
        // to refuse.
        logger.warn('source_document_watch.no_citations', {
            component: 'source-document-watch',
            watched: 0,
            verdict: 'no-citations',
        });
        return result;
    }

    // ONE read for every baseline, then an in-memory map — a read per
    // document inside the loop below is the D1 N+1 the query-shape guardrail
    // refuses, and it would be 13 round trips for one indexed lookup.
    const existing = await prisma.sourceDocumentWatch.findMany({
        where: { url: { in: cited.map((c) => c.url) } },
        take: WATCH_READ_CAP,
    });
    const byUrl = new Map(existing.map((row) => [row.url, row]));

    for (const source of cited) {
        const series = seriesForCitation(source.key);
        if (series === null) result.unclassified.push(source.key);

        const measured = await measureDocument(source.url, opts);
        const row = byUrl.get(source.url);

        if (!measured.ok) {
            result.failures.push({
                citation: source.key,
                failure: measured.failure,
                detail: measured.detail,
            });
            // A row that exists records the attempt, so `lastCheckedAt` means
            // "last asked" rather than "last succeeded". A row that does NOT
            // exist is deliberately not minted from a failure: a baseline has
            // to be bytes we actually read, and inventing one with an empty
            // hash would make the next successful run look like a change.
            if (row) {
                await prisma.sourceDocumentWatch.update({
                    where: { id: row.id },
                    data: { lastCheckedAt: new Date(), lastStatus: measured.failure },
                });
            }
            continue;
        }

        if (!row) {
            await prisma.sourceDocumentWatch.create({
                data: {
                    url: source.url,
                    citation: source.key,
                    publisher: source.publisher,
                    series,
                    sha256: measured.sha256,
                    bytes: measured.bytes,
                    contentType: measured.contentType,
                    lastCheckedAt: new Date(),
                    lastStatus: 'ok',
                },
            });
            result.firstSeen += 1;
            continue;
        }

        if (measured.sha256 === row.sha256) {
            // Matches the accepted baseline. If a flag was standing, the
            // document has been REVERTED to the bytes we checked against, so
            // the flag is cleared — the citation holds again, and leaving it
            // set would report an incident that no longer exists.
            await prisma.sourceDocumentWatch.update({
                where: { id: row.id },
                data: {
                    lastCheckedAt: new Date(),
                    lastStatus: 'unchanged',
                    changedAt: null,
                    changedSha256: null,
                    changedBytes: null,
                },
            });
            result.unchanged += 1;
            continue;
        }

        if (row.changedSha256 === measured.sha256) {
            // Same change we already flagged. Touch the check time and
            // nothing else: re-stamping `changedAt` every day would make a
            // single revision look like a daily recurrence, and the date a
            // reviewer needs is when it FIRST changed.
            await prisma.sourceDocumentWatch.update({
                where: { id: row.id },
                data: { lastCheckedAt: new Date(), lastStatus: 'changed' },
            });
            result.alreadyFlagged += 1;
            continue;
        }

        // Different from the baseline AND from any standing flag. `sha256` is
        // deliberately untouched — see the model docblock.
        await prisma.sourceDocumentWatch.update({
            where: { id: row.id },
            data: {
                lastCheckedAt: new Date(),
                lastStatus: 'changed',
                changedAt: new Date(),
                changedSha256: measured.sha256,
                changedBytes: measured.bytes,
            },
        });
        result.changed += 1;
    }

    const read = result.firstSeen + result.unchanged + result.changed + result.alreadyFlagged;
    result.verdict =
        result.changed > 0
            ? 'changed'
            : read === 0
              ? 'unreachable'
              : result.failures.length > 0
                ? 'partial'
                : 'clean';

    // A bounded COUNT, not a findMany: the question is "how many flags stand",
    // and `take: 2` could not answer it.
    result.flaggedTotal = await prisma.sourceDocumentWatch.count({
        where: { changedAt: { not: null } },
    });

    // The reading goes in the log FIELDS, not through the `[tag]` console
    // convention: that reporter collects from a JEST run, so a scheduled
    // job's tagged line is collected by nothing while breaching the
    // no-console-in-server-code rule. Same reasoning as P9.3d's
    // `channel_auto_hide.reading`.
    const level = result.changed > 0 || result.verdict === 'unreachable' ? 'warn' : 'info';
    logger[level]('source_document_watch.reading', {
        component: 'source-document-watch',
        verdict: result.verdict,
        // The denominator beside every figure. `0 changed` over an empty
        // population is not the same answer as `0 changed` over thirteen.
        watched: result.watched,
        firstSeen: result.firstSeen,
        unchanged: result.unchanged,
        changed: result.changed,
        alreadyFlagged: result.alreadyFlagged,
        failed: result.failures.length,
        failures: result.failures,
        unclassified: result.unclassified,
        flaggedTotal: result.flaggedTotal,
    });

    return result;
}
