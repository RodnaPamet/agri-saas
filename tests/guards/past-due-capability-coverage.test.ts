/**
 * Every capability the PAST_DUE ruling withholds has a gate, and every
 * exchange / trends surface has a DECISION recorded (#1325).
 *
 * ## Why a derived population rather than a list of files
 *
 * The owner's ruling closes the exchange and trends surfaces. A guard that
 * named today's routes would say nothing about tomorrow's: a new
 * `/api/t/[slug]/exchange/search` would be ungated and this file would stay
 * green, which is the shape that let #1403 ship. So the population comes
 * from the FILESYSTEM, and a path that is neither gated nor listed as
 * deliberately-open fails until somebody decides which it is.
 *
 * ## The open list is the interesting half
 *
 * Most exchange paths are deliberately NOT gated, and that is the owner's
 * decision rather than an oversight — "their existing listings stay visible
 * and contactable for other farms, and inbound messages keep arriving". A
 * tenant that cannot read the thread somebody wrote them has not had messages
 * "arrive" in any sense that matters. Each entry carries the reason, and a
 * "no stale entries" test removes the cover as soon as the path goes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESTRICTED_CAPABILITIES } from '@/lib/billing/past-due';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = join(__dirname, '..', '..');

// The shared collector, not a hand-rolled walk: it throws on an empty result
// and on a renamed root. A hand-rolled one can be gutted to return [] with
// every assertion below still green, which is the defect
// `file-collection-is-not-silently-empty` exists to stop.
const ALL = collectSourceFiles({ roots: ['src'] });
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

/** Files that call either gate, with the capability they name. */
const GATED = new Map<string, Set<string>>();
for (const f of ALL) {
    const src = readFileSync(f, 'utf8');
    const hits = [
        ...src.matchAll(/assert(?:Tenant)?NotPastDueRestricted\([^,]+,\s*'([^']+)'/g),
    ].map((m) => m[1]);
    if (hits.length) GATED.set(rel(f), new Set(hits));
}

/**
 * Exchange / trends paths that are deliberately NOT gated, each with the
 * reason. Keyed by the path as `rel()` prints it.
 */
const DELIBERATELY_OPEN: Readonly<Record<string, string>> = {
    // ── Messaging: the owner's ruling turns on this staying open ──
    'src/app-layer/usecases/exchange-messaging.ts':
        'Inbound messages keep arriving and must be readable and answerable. A thread the tenant cannot open has not "arrived", and gating it would strand a PAYING buyer mid-negotiation — a third party who did nothing wrong.',
    // ── Tenant-INDEPENDENT, so gated at its routes instead ──
    'src/app-layer/usecases/trends.ts':
        'getPriceTrends / getMarketNews take no RequestContext and their payload is Redis-cached across every tenant. A gate here has no tenant to test, and one that did would be bypassed by the next cache hit, so the three trends ROUTES carry it — each is in GATED below.',
    'src/app-layer/usecases/metric-trends.ts':
        'Internal metric series for the dashboard, not the market Trends surface the owner named. Shares only the word: no commodity prices, no market news, nothing a farmer navigates to as «Тенденции».',
};

/**
 * The population is the USECASE layer plus the routes whose usecase is
 * tenant-independent.
 *
 * Deliberately NOT every exchange route. This codebase puts authorization and
 * entitlement decisions in usecases, and a route that delegates to a gated
 * usecase is already covered — requiring a second gate at the route would be
 * two copies of one policy, which is how two answers diverge. Trends is the
 * exception and is handled by the entry above.
 *
 * So a new `exchange/search/route.ts` is covered the moment its usecase is,
 * and a new `exchange-something.ts` USECASE forces a decision here.
 */
const WATCHED = [/(^|\/)exchange(\/|-|\.|$)/, /(^|\/)trends(\/|-|\.|$)/];

const TENANT_INDEPENDENT_ROUTES = [
    'src/app/api/t/[tenantSlug]/trends/prices/route.ts',
    'src/app/api/t/[tenantSlug]/trends/news/route.ts',
    'src/app/api/t/[tenantSlug]/dashboard/trends/route.ts',
];

const POPULATION = ALL.map(rel).filter(
    (p) =>
        (p.startsWith('src/app-layer/usecases/') && WATCHED.some((re) => re.test(p))) ||
        TENANT_INDEPENDENT_ROUTES.includes(p),
);

describe('§1 the population this covers', () => {
    it('prints the denominator', () => {
        console.log(
            `[past-due] watched=${POPULATION.length} gated-files=${GATED.size} ` +
                `open=${Object.keys(DELIBERATELY_OPEN).length}\n  ` +
                POPULATION.join('\n  '),
        );
        expect(POPULATION.length).toBeGreaterThan(0);
        expect(GATED.size).toBeGreaterThan(0);
    });
});

describe('§2 every withheld capability actually has a gate somewhere', () => {
    it.each(RESTRICTED_CAPABILITIES)('%s is gated', (capability) => {
        // A capability in the list with no call site is the "wired is not
        // delivered" trap: the predicate answers true and nothing asks it.
        const sites = [...GATED.entries()].filter(([, caps]) => caps.has(capability));
        expect(sites.length).toBeGreaterThan(0);
    });
});

describe('§3 and no exchange / trends surface is undecided', () => {
    it.each(POPULATION)('%s is gated or listed as deliberately open', (path) => {
        const isGated = GATED.has(path);
        const isOpen = path in DELIBERATELY_OPEN;
        if (!isGated && !isOpen) {
            throw new Error(
                `${path} touches the exchange or trends surface and neither calls a ` +
                    `PAST_DUE gate nor appears in DELIBERATELY_OPEN. Decide which it is: ` +
                    `add the gate, or add an entry with the reason it must stay open.`,
            );
        }
        // Not both — an entry claiming a file is deliberately open while the
        // file gates anyway is a stale reason nobody will re-read.
        expect(isGated && isOpen).toBe(false);
    });
});

describe('§4 the open list has no stale entries', () => {
    it.each(Object.keys(DELIBERATELY_OPEN))('%s still exists', (path) => {
        expect(ALL.map(rel)).toContain(path);
    });

    it('every entry carries a real reason, not a placeholder', () => {
        for (const [path, reason] of Object.entries(DELIBERATELY_OPEN)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).not.toMatch(/TODO|TBD|FIXME/i);
            expect(path).toBeTruthy();
        }
    });
});

/**
 * ── §5 — every path that STORES UPLOAD BYTES carries the `upload` gate ──
 *
 * §2 above asks whether each withheld capability has a gate *somewhere*, and
 * `upload` satisfied it with a single call inside `ingestUploadedFile`. That
 * is exactly the hole #2030 measured: one call site, and four other paths
 * writing bytes past it.
 *
 * CLAUDE.md (~1221), `entitlements.ts` and `ingest.ts` each assert that
 * `ingestUploadedFile` is "the choke point every record-backed upload
 * reaches". Measured 2026-10-23 it was reached by two of six. The prose
 * generalised a claim no guard ranged over — §1-§4's population is exchange
 * and trends by design, so it could never have failed for `evidence.ts`
 * however long that stayed ungated.
 *
 * So this population is derived from the thing the convention is ABOUT: who
 * calls `FileRepository.markStored`, which is what turns stored bytes into a
 * `FileRecord`. A name regex cannot notice a new upload surface; this does.
 *
 * Comments are blanked before matching. `route.ts` carries the words
 * `assertTenantNotPastDueRestricted` and `ingestUploadedFile` in a docblock
 * explaining why the gate is there, and a guard that counted prose would pass
 * on the explanation rather than the code.
 */
const UPLOAD_WRITER_EXEMPT: Record<string, string> = {
    'src/app-layer/repositories/FileRepository.ts':
        'Defines `markStored`; it is the write primitive rather than an upload surface. Gating here would gate every caller including the gated ones, and would fire on internal re-stamps that are not uploads.',
};

const UPLOAD_WRITERS = ALL.map(rel).filter((p) => {
    if (UPLOAD_WRITER_EXEMPT[p]) return false;
    const code = blankNonCode(readFileSync(join(ROOT, p), 'utf8'));
    return /FileRepository\.markStored\s*\(/.test(code);
});

describe('§5 every upload-byte path carries the `upload` gate (#2030)', () => {
    it('finds upload writers at all — not vacuously passing', () => {
        console.log(
            `[past-due] upload-writers=${UPLOAD_WRITERS.length}\n  ` +
                UPLOAD_WRITERS.join('\n  '),
        );
        // Six at the time of writing. A floor rather than equality so a new
        // surface does not have to edit this number, but high enough that a
        // collector returning [] or one file fails instead of passing.
        expect(UPLOAD_WRITERS.length).toBeGreaterThanOrEqual(5);
    });

    it.each(UPLOAD_WRITERS)('%s gates the upload', (path) => {
        const code = blankNonCode(readFileSync(join(ROOT, path), 'utf8'));
        const gatesDirectly = /assert(?:Tenant)?NotPastDueRestricted\s*\([^)]*'upload'/.test(code);
        // `ingestUploadedFile` gates internally, so a path that delegates to
        // it is covered — that is the convention working, not a bypass.
        const delegates = /ingestUploadedFile\s*\(/.test(code);
        expect(
            gatesDirectly || delegates
                ? 'gated'
                : `${path} stores upload bytes with no 'upload' gate and no ingestUploadedFile`,
        ).toBe('gated');
    });

    it('the exempt list has no stale entries', () => {
        // Same discipline as §4: cover that outlives its path is cover that
        // protects nothing.
        const present = new Set(ALL.map(rel));
        for (const p of Object.keys(UPLOAD_WRITER_EXEMPT)) {
            expect(present.has(p)).toBe(true);
        }

        // ...and say which SIDE of the ban each entry sits on — #2414.
        //
        // Existence is half the question. `FileRepository.ts` does NOT match
        // `/FileRepository\.markStored\s*\(/`: it DEFINES `markStored`, and
        // the scan looks for CALLS through the class. So the exemption excuses
        // nothing today, which its own reason explains ("Defines `markStored`;
        // it is the write primitive rather than an upload surface").
        //
        // Kept rather than deleted, because it is DEFENSIVE in the sense
        // `no-secrets`' lockfile entries are: a future re-entrant
        // `FileRepository.markStored(` inside this file would make it
        // load-bearing immediately, and the reason records a design decision
        // worth keeping. What was missing is this assertion — the entry's state
        // is now PINNED, so it becoming load-bearing is a visible diff rather
        // than a silent change of meaning.
        for (const [p, reason] of Object.entries(UPLOAD_WRITER_EXEMPT)) {
            const code = blankNonCode(readFileSync(join(ROOT, p), 'utf8'));
            const calls = /FileRepository\.markStored\s*\(/.test(code);
            expect({ p, calls, defensive: reason.length > 40 })
                .toEqual({ p, calls: false, defensive: true });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
// §6 — the trends gate, derived from the CALLERS (#2626)
// ─────────────────────────────────────────────────────────────────────────

/**
 * §1–§4's population is PATH-derived: a file counts if it sits under
 * `src/app-layer/usecases/` and its path contains `exchange` or `trends`.
 * That is right for the exchange surface, where the gate lives in the
 * usecase — but it leaves the trends exemption resting on a premise nothing
 * checks.
 *
 * `usecases/trends.ts` is deliberately open, and its recorded reason ends
 * "so the three trends ROUTES carry it". The gate therefore lives at the CALL
 * SITES, and the exemption is only sound while the call sites are those
 * routes. Nothing asserted that. A caller elsewhere — `src/app-layer/ai/`,
 * a job, a server page — is invisible to a population keyed on the word
 * "trends" appearing in its own path.
 *
 * Measured with the real regexes before writing this:
 *
 *     OUT  src/app-layer/ai/assistant/tools.ts
 *     IN   src/app-layer/usecases/exchange.ts
 *     IN   src/app/api/t/[tenantSlug]/trends/prices/route.ts
 *
 * The assistant (#2578) is the live case: four of its six data sources are
 * still unbuilt and one of them is `prices`. A tool calling `getPriceTrends`
 * would assert NO policy — the usecase takes no `RequestContext` to assert
 * on — and would answer a PAST_DUE tenant whose trends surface is closed.
 *
 * So this section derives its population from the IMPORT, the way §5 derives
 * upload writers from who calls `FileRepository.markStored`. A new caller
 * fails until somebody decides.
 */
const TENANT_INDEPENDENT_TRENDS_EXPORTS = [
    'getPriceTrends',
    'getMarketNews',
    'getMarketReferences',
] as const;

/**
 * Callers that legitimately carry no `trends` gate, each with the reason.
 *
 * Both entries existed BEFORE this section and were outside §1–§4's
 * population, so nobody was ever asked. They are recorded rather than gated:
 * the owner's ruling was "read what you have, add nothing new, and the two
 * market surfaces close", and a reference price attached to grain the farm
 * already holds, or to a contract it already signed, is reading what it has.
 * Gating them would withhold a farm's OWN records over a payment problem,
 * which is the thing the ruling deliberately did not do.
 */
const TRENDS_CALLER_EXEMPT: Readonly<Record<string, string>> = {
    'src/app-layer/usecases/grain-net-worth.ts':
        'getMarketReferences values grain the farm ALREADY HOLDS — its own net worth, not the market surface. "Read what you have" is explicitly preserved by the ruling, and the figure is one column of a report about the farm itself.',
    'src/app-layer/usecases/contract.ts':
        'getMarketReferences decorates contracts the farm ALREADY SIGNED, so the same reasoning applies. Withholding it would blank a column of the tenant\'s own contract list rather than close a market surface.',
};

/** Files importing one of the tenant-independent trends exports. */
function trendsCallers(): string[] {
    const found: string[] = [];
    for (const f of ALL) {
        const relPath = rel(f);
        if (relPath === 'src/app-layer/usecases/trends.ts') continue; // defines them
        // Comments and strings blanked FIRST. A grep for the bare name finds
        // the docblock that EXPLAINS it far more often than a call: measured
        // over `src/`, 2 of 8 name-level hits were prose with no import at
        // all, and `dashboard/trends/route.ts` names two of these functions
        // in a comment while importing `getMetricTrends` instead.
        const code = blankNonCode(readFileSync(f, 'utf8'), { strings: false });
        for (const m of code.matchAll(
            /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
        )) {
            const spec = m[2];
            // `@/app-layer/usecases/trends`, or `./trends` from a sibling
            // usecase. NOT `metric-trends`, which is a different surface and
            // is exempted on its own terms in DELIBERATELY_OPEN.
            const isTrendsModule =
                /(^|\/)trends$/.test(spec)
                && (spec.includes('usecases/') || relPath.startsWith('src/app-layer/usecases/'));
            if (!isTrendsModule) continue;
            const names = m[1]
                .split(',')
                .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
                .filter(Boolean);
            if (names.some((n) => (TENANT_INDEPENDENT_TRENDS_EXPORTS as readonly string[]).includes(n))) {
                found.push(relPath);
                break;
            }
        }
    }
    return [...new Set(found)].sort();
}

describe('§6 every caller of the tenant-independent trends usecases has a decision (#2626)', () => {
    it('finds callers at all, INCLUDING the gated ones', () => {
        const callers = trendsCallers();
        console.log(
            `[past-due-trends] ${callers.length} caller(s) of `
                + `${TENANT_INDEPENDENT_TRENDS_EXPORTS.join('/')}:\n  `
                + callers.map((c) => `${GATED.get(c)?.has('trends') ? 'GATED  ' : 'exempt '}${c}`).join('\n  '),
        );
        expect(callers.length).toBeGreaterThanOrEqual(4);

        // The control that matters. If the import matcher broke and selected
        // ONLY the two exempt usecases, every assertion below would pass over
        // a population with no gated member — green while blind. So require
        // the two routes the exemption's own reason names.
        const gatedCallers = callers.filter((c) => GATED.get(c)?.has('trends'));
        expect(gatedCallers).toEqual(
            expect.arrayContaining([
                'src/app/api/t/[tenantSlug]/trends/prices/route.ts',
                'src/app/api/t/[tenantSlug]/trends/news/route.ts',
            ]),
        );
    });

    it.each(trendsCallers())('%s gates on `trends` or is exempt in writing', (path) => {
        const isGated = GATED.get(path)?.has('trends') === true;
        const isExempt = path in TRENDS_CALLER_EXEMPT;
        if (!isGated && !isExempt) {
            throw new Error(
                `${path} imports a tenant-INDEPENDENT trends usecase, which asserts no `
                    + `policy and no entitlement of its own, and neither calls `
                    + `assertNotPastDueRestricted(ctx, 'trends') nor appears in `
                    + `TRENDS_CALLER_EXEMPT. Decide which it is: add the gate, or add an `
                    + `entry saying why this caller may read the market without one. See #2626.`,
            );
        }
        expect(isGated && isExempt).toBe(false);
    });

    it('the exempt list has no stale entries', () => {
        // A stale entry keeps a path pre-approved for whatever is written
        // there next — the `require('@/env')` allowlist's failure mode.
        const callers = new Set(trendsCallers());
        for (const path of Object.keys(TRENDS_CALLER_EXEMPT)) {
            expect({ path, stillACaller: callers.has(path) }).toEqual({
                path,
                stillACaller: true,
            });
        }
    });

    it('every exemption carries a real reason', () => {
        for (const [path, reason] of Object.entries(TRENDS_CALLER_EXEMPT)) {
            expect({ path, long: reason.length >= 60 }).toEqual({ path, long: true });
            expect(reason).not.toMatch(/^(TODO|TBD|see above|n\/a)/i);
        }
    });
});
