/**
 * Every column that HIDES a listing is honoured at every read that serves one
 * (#2865).
 *
 * There are two such columns now and there was one before:
 * `suppressedForDeletionAt` (#1655 — the seller asked to delete their account)
 * and `removedByModerationAt` (#2865 — a moderator removed it). Each was added
 * with a sweep of the read paths, and #1655's sweep found FOUR that needed it
 * including one — `openExchangeThread` — that filtered on `id` alone, so a
 * saved link could start a conversation against a listing the feed had already
 * stopped showing.
 *
 * Nothing held that sweep. A third cause to hide a listing would be a third
 * manual sweep of a population nobody printed, and the failure is silent in
 * the worst direction: the hiding still looks implemented, because the feed —
 * the path anybody would check — is the one that gets filtered first.
 *
 * ## The population is DERIVED
 *
 * Every `exchangeListing.find*` / `.count` call under `src/`, keyed by file and
 * the symbol that encloses it. A new read path is in the population the moment
 * it exists, rather than when somebody remembers to list it. Each call either
 * mentions every hiding column, or sits in `MAY_SEE_HIDDEN` with a written
 * reason — and several legitimately may: a plan-limit count, an expiry sweep,
 * the Art 15 export, the moderation snapshot, and the seller's own management
 * view, which #1655 settled deliberately ("hiding their listings from
 * themselves would read as 'already deleted' at the exact moment they are
 * deciding whether to recover").
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

/**
 * The columns whose presence means "do not show this listing to other farms".
 *
 * Listed here rather than derived from the schema, because what makes a column
 * a HIDING column is its meaning and not its type — `expiresAt` and
 * `status` are also nullable timestamps and enums on this model and neither is
 * one of these. The schema docblock on each is the authority; this is the
 * guard's copy of the decision, and §0 asserts both still exist.
 */
const HIDING_COLUMNS: readonly { readonly column: string; readonly why: string }[] = [
    {
        column: 'suppressedForDeletionAt',
        why: '#1655 — the seller asked to delete their account, so the listing is withheld for the 30-day grace period and restored verbatim if they cancel.',
    },
    {
        column: 'removedByModerationAt',
        why: '#2865 — a moderator removed it on a notice, and the Art 17 statement of reasons says so. Reversible on appeal, which is why it is a nullable column and not a delete.',
    },
];

/**
 * Reads that MAY serve a hidden listing, keyed `file::symbol`.
 *
 * Each is a decision, not an oversight. A new read with no entry fails, which
 * is the point.
 */
const MAY_SEE_HIDDEN: Record<string, string> = {
    'lib/billing/entitlements.ts::getCurrentCount':
        'A plan-limit COUNT, not a read that serves content. A hidden listing still occupies the seller\'s allowance — excluding it would silently raise their cap the moment a moderator removed something, which is a reward for a violation.',
    'app-layer/jobs/market-prices-pull.ts::pullListings':
        'Price aggregation. A removed listing\'s PRICE is still a real offer that was made, and excluding it would let a moderation decision move a published market statistic — a worse outcome than including it, since nothing here identifies the listing or its seller.',
    'app-layer/jobs/exchange-expiry-sweep.ts::runExchangeExpirySweep':
        'Expires stale listings. A hidden listing must still expire, or it comes back from a restore as an ACTIVE row months out of date.',
    'app-layer/repositories/exchange.ts::getListing':
        'Reads one row with NO `select`, so it returns every column including both hiding ones, and its callers decide. `getListing` in the usecase is where the filtering happens, and it is in the population below.',
    'app-layer/repositories/exchange.ts::listListingsBySeller':
        'The seller\'s OWN management view. #1655 settled this deliberately: hiding their listings from themselves would read as "already deleted" at the exact moment they are deciding whether to cancel — and for #2865 they additionally need to see what was removed in order to appeal it.',
    'app-layer/usecases/trust-safety.ts::captureSnapshot':
        'Captures the EVIDENCE for a notice. It must read a listing a moderator has already removed, or acting on a second notice about the same listing would find nothing to capture.',
    'app-layer/usecases/statement-queue.ts::resolveContentRecipient':
        'Resolves the Art 17 recipient from the listing a notice named. It runs AFTER the removal by construction, so filtering here would make a statement unqueueable for exactly the decisions that require one.',
    'app-layer/usecases/personal-data-export.ts::exportPersonalData':
        'Art 15. A listing we removed is still the person\'s own data and they are entitled to a copy of it — withholding it would make the export quieter precisely where the person has most reason to ask.',
};

/** The nearest declaration above an offset, which is what a reader recognises. */
function enclosingSymbol(code: string, offset: number): string {
    const before = code.slice(0, offset);
    const patterns = [
        /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /static\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
        /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    ];
    let best = -1;
    let name = '(top level)';
    for (const re of patterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(before)) !== null) {
            if (m.index > best) {
                best = m.index;
                name = m[1];
            }
        }
    }
    return name;
}

interface Site {
    readonly key: string;
    readonly file: string;
    readonly code: string;
    readonly at: number;
}

function listingReads(): Site[] {
    const sites: Site[] = [];
    // The SHARED collector, which refuses an empty result — a hand-rolled
    // walk can be gutted to return `[]` with every assertion built on it
    // still green, measured at 81% of the guards an automated sweep could
    // audit (`file-collection-is-not-silently-empty`, which named this file).
    // ABSOLUTE paths — the collector returns `full`, not a repo-relative one.
    for (const file of collectSourceFiles({ roots: ['src'] })) {
        const raw = readFileSync(file, 'utf8');
        if (!raw.includes('exchangeListing.')) continue;
        // Comments blanked: a read named in a docblock is not a read, and a
        // commented-out filter is not a filter (#1774).
        const code = blankNonCode(raw, { strings: true });
        const call = /exchangeListing\.(?:findMany|findUnique|findUniqueOrThrow|findFirst|count|aggregate)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = call.exec(code)) !== null) {
            // Keyed relative to `src/`, which is what the exemption map spells
            // and what a reader recognises.
            const key = relative(join(process.cwd(), 'src'), file)
                .split('\\').join('/');
            sites.push({
                key: `${key}::${enclosingSymbol(code, m.index)}`,
                file: key,
                code,
                at: m.index,
            });
        }
    }
    return sites;
}

describe('every listing-hiding column is filtered at every read (#2865)', () => {
    const sites = listingReads();

    it('§0 the hiding columns still exist on the model', () => {
        const schema = readFileSync(
            join(process.cwd(), 'prisma/schema/exchange.prisma'),
            'utf8',
        );
        // A renamed or dropped column would make every "is it filtered?" check
        // below pass over a column nothing has — the shape
        // `a-number-that-does-not-move` warns about.
        for (const { column } of HIDING_COLUMNS) {
            expect(schema).toContain(`${column} `);
        }
        expect(HIDING_COLUMNS.length).toBeGreaterThanOrEqual(2);
    });

    it('§1 reports its denominator', () => {
        const exempt = sites.filter((s) => s.key in MAY_SEE_HIDDEN).length;
        console.log(
            `[listing-hiding-columns] ${sites.length} listing read(s) across `
            + `${new Set(sites.map((s) => s.file)).size} file(s): `
            + `${sites.length - exempt} must filter, ${exempt} may see hidden; `
            + `${HIDING_COLUMNS.length} hiding column(s)`,
        );
        // A floor, so an extraction that stops matching fails instead of
        // passing over nothing.
        expect(sites.length).toBeGreaterThanOrEqual(8);
    });

    it('§2 every non-exempt read honours every hiding column', () => {
        const problems: string[] = [];
        for (const site of sites) {
            if (site.key in MAY_SEE_HIDDEN) continue;
            // The whole FILE is searched rather than the call's own `where`:
            // several of these read the column into a `select` and branch on it
            // a few lines later (`getListing`, `openExchangeThread`), which is
            // filtering just as much as a `where` clause is.
            for (const { column } of HIDING_COLUMNS) {
                if (!site.code.includes(column)) {
                    problems.push(`${site.key} does not mention ${column}`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('§3 every read is accounted for — a NEW one fails until it is', () => {
        const unaccounted = sites.filter((s) => {
            if (s.key in MAY_SEE_HIDDEN) return false;
            return HIDING_COLUMNS.some(({ column }) => !s.code.includes(column));
        });
        expect(unaccounted.map((s) => s.key)).toEqual([]);
    });

    it('§4 no stale exemption — an entry names a read that still exists', () => {
        const keys = new Set(sites.map((s) => s.key));
        const stale = Object.keys(MAY_SEE_HIDDEN).filter((k) => !keys.has(k));
        // An exemption is COVER. One naming a renamed or deleted read keeps
        // that cover alive for whatever is written at the same name next
        // (#1285).
        expect(stale).toEqual([]);
        for (const [key, why] of Object.entries(MAY_SEE_HIDDEN)) {
            expect(why.length).toBeGreaterThan(80);
            expect(key).toMatch(/^[\w./-]+\.tsx?::[\w$()\s]+$/);
        }
    });

    it('§5 each hiding column carries a written reason', () => {
        for (const { why } of HIDING_COLUMNS) {
            expect(why.length).toBeGreaterThan(60);
        }
    });
});
