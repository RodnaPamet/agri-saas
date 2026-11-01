/**
 * Every `Notification.linkUrl` a producer writes is resolvable by a client
 * that is NOT already inside a farm (#2512).
 *
 * ## The defect this exists for
 *
 * `linkUrl` had three shapes, and one could not be resolved by a native client
 * at all. `usecases/field-operation.ts` wrote `/farm-tasks/{id}` and
 * `usecases/evidence.ts` wrote `/evidence` — both resolve on the web, because
 * the browser is already inside a farm and the relative path lands in it.
 *
 * A phone has no current farm. For someone signed in to TWO farms there is no
 * safe guess either, so an unprefixed path is not a cosmetic inconsistency —
 * it is a push notification that cannot be opened.
 *
 * ## The three legitimate shapes
 *
 *   1. `/t/{slug}/…`  — tenant-prefixed, which 11 of 13 producers already were.
 *   2. `null`         — navigable-nowhere, which a client CAN handle. This is
 *                       the correct absent case, because `tenantSlug` is
 *                       OPTIONAL on `RequestContext`; a broken link is worse
 *                       than no link.
 *   3. an ABSOLUTE https URL from a tenant's own automation rule — exempt by
 *                       name below, because an automation rule may legitimately
 *                       point at an external document.
 *
 * ## Why a derived population
 *
 * A hand-written list of producers is the thing that goes stale: a fourteenth
 * producer is exactly the case this is for, and it would be born outside a
 * list. So the population is every `linkUrl:` assignment under
 * `src/app-layer`, and the denominator is printed on every run.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const ROOT = REPO_ROOT;

/**
 * Absolute-URL producers, exempt BY NAME with a reason.
 *
 * Not a regex over "looks absolute": that would exempt any future producer
 * that happened to interpolate a host, which is the shape most likely to be a
 * mistake. An entry here is a decision.
 */
const ABSOLUTE_BY_DESIGN: Readonly<Record<string, string>> = {
    'src/app-layer/automation/action-executor.ts':
        'Writes `cfg.linkUrl ?? null` from a TENANT-AUTHORED automation rule. '
        + '`automation.schemas.ts` declares it `httpsUrl().optional()` and the '
        + '`payload-url-scheme` guard sweeps that directory, so the scheme is pinned — but it '
        + 'is an absolute external URL by design, because a rule may point at a document '
        + 'outside the app. A client must therefore not assume every `linkUrl` is relative.',
};

/**
 * The selection, at MODULE level and named, so `selector-teeth` can
 * mutation-audit it — inline inside `it()` it would pass whether or not it
 * selected anything.
 *
 * `blankNonCode` with `{ strings: true }`: this file's own docblock quotes
 * `/farm-tasks/{id}` and `/evidence`, so an unblanked scan of the TREE is
 * fine but a scan that ever included tests would match its own prose. Blanking
 * strings also stops a `linkUrl` named inside a comment from entering the
 * population.
 */
export function linkUrlAssignments(): { file: string; line: number; value: string }[] {
    const out: { file: string; line: number; value: string }[] = [];
    /**
     * Through `collectSourceFiles` and NOT a private walker: a neighbouring
     * guard records that a hand-rolled one was refused by the
     * file-collection meta-guard on shard 1/6, and the shared helper also
     * THROWS on a renamed root rather than scanning zero files and passing
     * (#875).
     */
    for (const abs of collectSourceFiles({ roots: ['src/app-layer'], extensions: ['.ts'] })) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('linkUrl')) continue;
        const code = blankNonCode(raw);
        const lines = code.split('\n');
        lines.forEach((ln, i) => {
            const m = /linkUrl:\s*(.+?),?\s*$/.exec(ln);
            if (!m) return;
            out.push({
                file: relative(ROOT, abs).split('\\').join('/'),
                line: i + 1,
                // The RAW line's value, because blanking empties the template
                // literal we need to classify.
                value: (/linkUrl:\s*(.+?),?\s*$/.exec(raw.split('\n')[i] ?? '') ?? [])[1] ?? '',
            });
        });
    }
    return out;
}

/**
 * Every quoted path in this value — a backtick, single or double quote
 * followed immediately by `/`.
 *
 * This, and not "does the value START with a quote", is the discriminator. A
 * resolvable link is often written `ctx.tenantSlug ? `/t/${slug}/x` : null`,
 * which starts with `ctx.` — a start-of-value test excluded four of the nine
 * real producers while happily grading none of them. Asking what PATHS the
 * expression contains judges the ternary and the bare literal alike.
 *
 * It also excludes, correctly and without a special case, the fifteen
 * assignments that are not values at all: a TYPE annotation
 * (`linkUrl: string;`), a PASS-THROUGH (`linkUrl: row.linkUrl`), a Zod
 * declaration (`httpsUrl().optional()`) and a VARIABLE built further up
 * (`linkUrl: inquiriesUrl`). None contains a quoted path, so none is graded.
 *
 * The LIMIT is stated rather than hidden: a variable holding an unprefixed
 * path still escapes, because tracing a value is not something a regex can do.
 * §1 prints how many assignments fall in that class, which is the reading that
 * keeps the gap visible instead of implied.
 */
const PATH_LITERAL = /[`'"]\/[^`'"]*/g;

function pathLiterals(value: string): string[] {
    return value.match(PATH_LITERAL) ?? [];
}

/** Judged only when the expression names at least one path. */
function isGradable(value: string): boolean {
    return pathLiterals(value).length > 0;
}

/**
 * Every path this expression names is tenant-scoped.
 *
 * ALL of them, not some: `a ? `/t/${s}/x` : `/x`` is a producer that resolves
 * on one branch and breaks on the other, and `some` would pass it.
 */
function isResolvable(value: string): boolean {
    return pathLiterals(value).every((lit) => lit.slice(1).startsWith('/t/'));
}

describe('§1 the population this covers', () => {
    it('prints the denominator and is not empty', () => {
        const all = linkUrlAssignments();
        const exempt = all.filter((a) => a.file in ABSOLUTE_BY_DESIGN);
        const inScope = all.filter((a) => !(a.file in ABSOLUTE_BY_DESIGN));
        const literals = inScope.filter((a) => isGradable(a.value));
        const notLiteral = inScope.filter((a) => !isGradable(a.value));
        console.log(
            `[notification-link-scoped] ${all.length} linkUrl assignment(s) across `
                + `${new Set(all.map((a) => a.file)).size} file(s): `
                + `${literals.length} literal path(s) GRADED, `
                + `${notLiteral.length} name no path (type annotation, pass-through or `
                + `variable) and therefore NOT graded, `
                + `${exempt.length} absolute by design`,
        );
        // A detector over an empty population passes every assertion below.
        expect(all.length).toBeGreaterThanOrEqual(12);
        // And a floor on what is actually JUDGED — the number that would fall
        // silently if a producer stopped using a literal.
        // 8 since `low-stock-monitor` was removed (owner ruling 2026-11-01).
        // It wrote exactly one graded literal `linkUrl`, so the population
        // shrank by one for a reason, not because the detector stopped seeing
        // things — which is the failure a floor exists to catch, and why this
        // moves only on a measured, explained change.
        expect(literals.length).toBeGreaterThanOrEqual(8);
    });
});

describe('§2 every graded link is resolvable without a current farm', () => {
    it('no producer writes a tenant-unprefixed relative path', () => {
        const bad = linkUrlAssignments()
            .filter((a) => !(a.file in ABSOLUTE_BY_DESIGN))
            .filter((a) => isGradable(a.value))
            .filter((a) => !isResolvable(a.value));
        expect(bad.map((b) => `${b.file}:${b.line} — ${b.value}`)).toEqual([]);
    });
});

describe('§3 the exemption has not gone stale', () => {
    it.each(Object.keys(ABSOLUTE_BY_DESIGN))('%s still writes a linkUrl', (file) => {
        // Without this the map rots into a permanent allowlist — the one thing
        // an exemption map must not become.
        const src = readFileSync(join(ROOT, file), 'utf8');
        expect(src).toContain('linkUrl');
    });

    it('every exempt file still exists', () => {
        for (const file of Object.keys(ABSOLUTE_BY_DESIGN)) {
            expect(() => readFileSync(join(ROOT, file), 'utf8')).not.toThrow();
        }
    });

    it('classifies the three shapes correctly — the detector control', () => {
        // Without this, a classifier that returned `true` for everything would
        // satisfy §2 forever.
        expect(isResolvable('`/t/${ctx.tenantSlug}/farm-tasks/1`')).toBe(true);
        expect(isResolvable('ctx.tenantSlug ? `/t/${ctx.tenantSlug}/evidence` : null')).toBe(true);
        expect(isResolvable('null')).toBe(true);
        expect(isResolvable('`/farm-tasks/${taskId}`')).toBe(false);
        expect(isResolvable('`/evidence`')).toBe(false);
        // The gradability filter keeps the non-values out...
        expect(isGradable('string;')).toBe(false);
        expect(isGradable('row.linkUrl } }')).toBe(false);
        expect(isGradable('httpsUrl().optional()')).toBe(false);
        expect(isGradable('inquiriesUrl')).toBe(false);
        // ...and admits both shapes a real producer writes.
        expect(isGradable('`/t/${s}/x`')).toBe(true);
        expect(isGradable('ctx.tenantSlug ? `/t/${ctx.tenantSlug}/x` : null')).toBe(true);
        // EVERY path must be scoped, not merely one of them.
        expect(isResolvable('a ? `/t/${s}/x` : `/x`')).toBe(false);
    });
});
