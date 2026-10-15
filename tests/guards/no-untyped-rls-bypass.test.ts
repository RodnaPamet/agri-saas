/**
 * An RLS bypass must NAME ITS REASON. P1.7.
 *
 * ── what this is really guarding ──
 *
 * `src/lib/db/rls-middleware.ts` has carried `runWithoutRls({ reason })` for a
 * long time: a closed union of reasons, a runtime rejection of anything not in
 * it, and an info-level log with a caller fingerprint so an audit can
 * enumerate every bypass without grepping. It has unit tests and an
 * integration test.
 *
 * Measured 2026-10-02, before P1.7: it had **ZERO production call sites**. All
 * eighteen references outside its own module were tests. Meanwhile four real
 * bypasses went through `runInGlobalContext` next door — no reason, no record,
 * no constraint, and a docblock ("use this SAFELY and specifically for
 * unauthenticated public routes") that described none of the four actual
 * callers.
 *
 * So the control was code-complete, test-green and inert, with the untyped
 * door still open beside it. That is the shape this file exists to prevent
 * recurring, and it is why the second assertion matters as much as the first:
 * a guard that only banned the old name would be perfectly satisfied by a
 * codebase that had deleted both and bypassed RLS some third way.
 */
import fs from 'fs';
import path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** Mask comments so a name discussed in prose is not counted as a call. */
function codeOf(source: string): string {
    return blankNonCode(source);
}

const FILES = collectSourceFiles({
    roots: ['src'],
    // High enough that a broken collector fails rather than reporting a tidy
    // zero over an empty set.
    floor: 500,
}).map((abs) => ({
    rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
    code: codeOf(fs.readFileSync(abs, 'utf8')),
}));

/** Files that CALL a symbol (not merely mention or re-export it). */
function callersOf(symbol: string): string[] {
    const re = new RegExp('\\b' + symbol + '\\s*\\(');
    return FILES.filter((f) => re.test(f.code)).map((f) => f.rel);
}

/**
 * One entry per CALL, as `file:line` — not one per file.
 *
 * `callersOf` answers "which files bypass", which is a different question
 * from "how many reads bypass", and the ceiling below used to be set on the
 * first. Measured when P6.6 added `farm-handle-availability` to
 * `public-farm-profile.ts`, a file that already held
 * `public-projection-read`: the number did not move and the guard stayed
 * green while another query started reading across tenants (#1864).
 *
 * The two reasons in that one file are not the same risk, which is what
 * makes the distinction matter rather than merely tidy. The ceiling's own
 * docblock argues `public-projection-read` is safe because
 * `PublicFarmProfile` has no PII columns and no `tenantId`, so "a mistake at
 * the call site cannot widen its reach" — bounded by the TABLE.
 * `farm-handle-availability` reads `FarmBrand`, which is tenant-scoped; its
 * reach is bounded by the QUERY, and a later edit to that query can widen it
 * with nothing structural objecting.
 *
 * Counts MATCHES, not lines: two calls on one line are two sites. Reads
 * `f.code`, which `blankNonCode` has already blanked, so a comment naming
 * the function is not a site.
 */
export function callSitesIn(
    files: ReadonlyArray<{ rel: string; code: string }>,
    symbol: string,
): string[] {
    const out: string[] = [];
    for (const f of files) {
        f.code.split('\n').forEach((line, i) => {
            const re = new RegExp('\\b' + symbol + '\\s*\\(', 'g');
            const hits = [...line.matchAll(re)].length;
            for (let k = 0; k < hits; k += 1) out.push(`${f.rel}:${i + 1}`);
        });
    }
    return out;
}

/**
 * Takes the file list so a SYNTHETIC one can be handed to it.
 *
 * `selector-teeth` reported the first version dead: gutted to `return []` it
 * survived, because `expect(sites.length).toBeLessThanOrEqual(9)` is
 * satisfied by zero. A ceiling cannot prove its own selector works — the
 * same defect, in the same shape, as `staticSiblings` in #1847.
 *
 * Two controls answer it below: a floor tying sites to files, which an empty
 * result cannot satisfy, and a synthetic population proving the counter sees
 * two calls on one line.
 */
function callSitesOf(symbol: string): string[] {
    return callSitesIn(FILES, symbol);
}

describe('the untyped RLS bypass is gone', () => {
    it('reports the population, so a zero would be visible', () => {
        expect(FILES.length).toBeGreaterThan(500);
    });

    it('`runInGlobalContext` appears NOWHERE in src', () => {
        // P1's exit criterion is "0 runInGlobalContext imports". Checked as
        // "no occurrence in code at all", which also catches a re-export or a
        // local re-definition under the same name.
        const offenders = FILES.filter((f) => /\brunInGlobalContext\b/.test(f.code)).map(
            (f) => f.rel,
        );
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) still reference runInGlobalContext:\n  ` +
                    offenders.join('\n  ') +
                    `\n\nUse runWithoutRls({ reason }) from @/lib/db/rls-middleware. ` +
                    `If no existing reason fits, adding one is a review checkpoint — ` +
                    `which is the entire point of the closed union.`,
            );
        }
    });
});

describe('the typed bypass is actually USED — not a control that only exists', () => {
    it('runWithoutRls has real production call sites', () => {
        // The assertion that would have caught the original defect. Before
        // P1.7 this was ZERO while four bypasses ran next door.
        const callers = callersOf('runWithoutRls').filter(
            (rel) => rel !== 'src/lib/db/rls-middleware.ts',
        );
        expect(callers.length).toBeGreaterThanOrEqual(2);
    });

    it('the bypass sites are RATCHETED, so a new one is a visible diff', () => {
        // Bypasses should not multiply quietly. This is a ceiling on files, not
        // a ban: raising it means saying out loud that another part of the
        // product now reads across tenants.
        const callers = callersOf('runWithoutRls').filter(
            (rel) => rel !== 'src/lib/db/rls-middleware.ts',
        );
        // 3 → 4 (#1814): `readPublicFarmProfile` is the PUBLIC read path for
        // `/f/[handle]`, and its bypass is load-bearing in a way none of the
        // other three are — an anonymous visitor has no session, no tenant and
        // no membership, so `runInTenantContext` has nothing to enter with.
        // The alternative is not a narrower context, it is no query.
        //
        // What it may read is bounded by the TABLE rather than by the reason:
        // `PublicFarmProfile` has no PII columns and no `tenantId`, so a
        // mistake at the call site cannot widen its reach. Raised rather than
        // exempted, so the fourth caller is a visible diff — which is the
        // whole purpose of the number.
        expect(callers.length).toBeLessThanOrEqual(4);

        // ── and the SITES, because the file count hid five of them ──
        //
        // Measured 2026-10-15: 10 call sites across those 4 files. The file
        // ceiling was green at 4 the whole time, including when P6.6 added a
        // second reason to `public-farm-profile.ts` and a new query started
        // reading `FarmBrand` across tenants (#1864).
        //
        //   PortfolioRepository.ts   3   org-portfolio-read
        //   public-farm-profile.ts   4   public-projection-read x3,
        //                                farm-handle-availability
        //   exchange.ts              2   module-availability,
        //                                exchange-farm-attribution
        //   org-tenants.ts           1
        //
        // 9 -> 10 by P6.7 (#1816): `exchange-farm-attribution` resolves which
        // seller tenants are published farms, so an exchange listing can be
        // attributed to the farm that posted it. `FarmBrand` is tenant-scoped,
        // so under the viewer's own context the read returns at most the
        // VIEWER's own brand — the same argument the `module-availability`
        // site one line above makes for the same feed.
        //
        // Raised rather than exempted, which is the whole purpose of the
        // number. It also lands in the file that ALREADY bypasses, so the
        // file ceiling stayed green at 4 and did not notice — which is
        // precisely the hole the site count was added to cover (#1864).
        //
        // BOTH numbers are asserted rather than one replacing the other,
        // because they answer different questions: how much of the product
        // may read across tenants, and how many reads actually do. A cap on
        // files alone lets an existing bypasser grow without limit; a cap on
        // sites alone stops reporting when the bypass spreads to a new
        // module. Printed above either way, so a reader of CI output sees
        // the denominators instead of inferring them from a tick.
        const sites = callSitesOf('runWithoutRls').filter(
            (rel) => !rel.startsWith('src/lib/db/rls-middleware.ts'),
        );
        // No eslint-disable: `no-console` does not apply under tests/, so a
        // directive here is UNUSED — and an unused directive is itself a lint
        // finding. `social-routes-flag-gated` records exactly this three
        // files away; I added the directive without looking.
        console.log(
            `[rls-bypass] files=${callers.length} sites=${sites.length}\n  ` +
                sites.join('\n  '),
        );
        expect(sites.length).toBeLessThanOrEqual(10);

        // The floor, and it is an INVARIANT rather than a second hardcoded
        // number: every file that bypasses contains at least one call, so
        // sites can never be fewer than files. A selector returning nothing
        // fails this (0 >= 4 is false) while sailing through the ceiling
        // above — which is exactly how the first version of this was dead.
        //
        // It also costs nothing as bypasses are REMOVED: both numbers fall
        // together, where a floor of 9 would have to be edited down.
        expect(sites.length).toBeGreaterThanOrEqual(callers.length);
    });

    it('every bypass site names a reason from the union', () => {
        // The compiler already enforces the TYPE. What it cannot enforce is
        // that the call passes a reason at all through an `any`-shaped seam, so
        // the shape is checked textually at each site.
        const reasonless: string[] = [];
        for (const f of FILES) {
            if (f.rel === 'src/lib/db/rls-middleware.ts') continue;
            for (const m of f.code.matchAll(/runWithoutRls\s*\(([^)]{0,80})/g)) {
                if (!/reason\s*:/.test(m[1])) reasonless.push(`${f.rel}: ${m[1].trim()}`);
            }
        }
        expect(reasonless).toEqual([]);
    });
});

describe('the detector has teeth', () => {
    it('sees a call and ignores a mention in prose', () => {
        // Without this, a file that merely discusses the helper in a docblock
        // would register as a caller and the ratchet would count fiction.
        expect(codeOf('const x = runInGlobalContext(fn);')).toContain('runInGlobalContext');
        expect(codeOf('// runInGlobalContext would be wrong here')).not.toContain(
            'runInGlobalContext',
        );
        expect(codeOf('/* uses runInGlobalContext internally */')).not.toContain(
            'runInGlobalContext',
        );
    });

    it('a reasonless call is detected', () => {
        // Proven against a synthetic source rather than against zero real
        // matches — an exemption nothing exercises is one nobody can trust.
        const bad = codeOf('await runWithoutRls(async (db) => db.tenant.findMany());');
        expect(/runWithoutRls\s*\(([^)]{0,80})/.exec(bad)?.[1] ?? '').not.toMatch(/reason\s*:/);
        const good = codeOf("await runWithoutRls({ reason: 'seed' }, async (db) => db.x());");
        expect(/runWithoutRls\s*\(([^)]{0,80})/.exec(good)?.[1] ?? '').toMatch(/reason\s*:/);
    });
    it('the site counter can select, and counts CALLS not lines', () => {
        // The positive control `selector-teeth` asked for. Synthetic, because
        // the real population cannot demonstrate the two-on-one-line case —
        // no file in src happens to have one, so only a fixture can show the
        // counter does not merely count lines.
        const synthetic = [
            { rel: 'a.ts', code: 'runWithoutRls(x); runWithoutRls(y);' },
            { rel: 'b.ts', code: 'const q = 1;\nrunWithoutRls(z);' },
        ];
        const sites = callSitesIn(synthetic, 'runWithoutRls');
        expect(sites).toEqual(['a.ts:1', 'a.ts:1', 'b.ts:2']);

        // And it finds nothing when there is nothing, rather than matching a
        // similarly-named symbol.
        expect(callSitesIn([{ rel: 'c.ts', code: 'runWithoutRlsX(1);' }], 'runWithoutRls')).toEqual(
            [],
        );
    });

});
