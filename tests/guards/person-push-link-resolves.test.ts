/**
 * Every deep link a PERSON-SCOPED push carries names a page that exists —
 * #2987, and #2932 is why it needs a guard rather than a convention.
 *
 * ## The defect this exists for, twice over
 *
 * `push-summary` sent `url: '/notifications'` and `link: '/notifications'`, a
 * bare path with no tenant slug. There is no root-level `/notifications` page,
 * so `public/sw.js`'s `clients.openWindow(target)` opened a **404**, and on
 * iOS there was no `PushLink` case so the push merely opened the app. #2932
 * fixed it and recorded the measurement: 19 of 19 production
 * `Notification.linkUrl` rows start with `/t/`, and that one job was the only
 * violator.
 *
 * It then happened again, in the branch that added this file. The DM push
 * carried `/messages/{conversationId}` — and P8.4 ruled out a `/messages`
 * route **outright**, putting the DM screen under
 * `/t/{slug}/exchange/threads/dm/{id}`. Two docs said so, the comment three
 * lines above the literal said so, and the whole 1,954-suite population was
 * green, because:
 *
 *   - `notification-link-is-tenant-scoped` derives its population from
 *     `linkUrl:` assignments, and a push payload's field is
 *     `farmRelativePath` — a field the branch invented, so the sites were
 *     outside the denominator rather than passing it;
 *   - `tests/integration/p8-2-direct-messages.test.ts` asserted the value the
 *     code emitted. A test that pins a destination without checking it is a
 *     page is exactly what #2932 found holding its own bare path in place.
 *
 * So the property here is deliberately NOT "looks root-relative", which both
 * defects satisfied. It is **resolves to a `page.tsx` that exists**.
 *
 * ## Why `farmRelativePath` is farm-RELATIVE and that is not the bug
 *
 * A channel post and a direct message are tenantless, so the enqueuing usecase
 * has no slug to write; `person-push-send` resolves the RECIPIENT's oldest
 * active farm and composes `/t/{slug}{farmRelativePath}`, sending no link at all when
 * it cannot. The paths graded here are therefore the part AFTER `/t/{slug}`,
 * and a value that carries its own `/t/` prefix is a double prefix — refused
 * below, with its own assertion, because that is the mistake this shape
 * invites.
 *
 * ## The field is `farmRelativePath` because `linkPath` was already taken
 *
 * It was called `linkPath` for an afternoon, and THIS GUARD is what found the
 * collision: `notifications/assignment.ts` has carried a `linkPath` since
 * #2490, and it means the opposite — `(slug, id) => `/t/${slug}/assets/${id}``,
 * a builder that produces the FULL prefixed link. One name, two opposite
 * meanings, in one codebase, is the class this repo keeps paying for:
 * «Борса» against «Пазар» for one destination, and `app.user_id` against
 * `app.actor_user_id` for one person. The guard reported those two assignment
 * sites as carrying their own `/t/` prefix, which is true and correct of them
 * — they are not person-scoped pushes at all. Renaming was the fix; narrowing
 * the population to exclude them would have left the name ambiguous and the
 * next reader to discover it.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const APP_ROOT = join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)');

/**
 * Today's count. A FLOOR and not an equality: a third person-scoped push is
 * welcome, a population that silently drops to one is the failure this
 * separates from zero.
 */
const MIN_SITES = 2;

/**
 * The route patterns `(app)` actually serves, as segment arrays.
 *
 * Route GROUPS — `(app)`, `(whatever)` — contribute no URL segment, so they
 * are dropped; a `[param]` segment is kept as a wildcard marker. Derived from
 * the filesystem rather than listed, which is the half that makes a renamed
 * page fail here instead of in production.
 */
export function appRoutePatterns(): string[][] {
    const out: string[][] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (entry.name !== 'page.tsx') continue;
            const rel = relative(APP_ROOT, dir).split('\\').join('/');
            const segs = rel === '' ? [] : rel.split('/').filter((s) => !/^\(.*\)$/.test(s));
            out.push(segs);
        }
    };
    walk(APP_ROOT);
    return out;
}

/**
 * Every `farmRelativePath:` assignment under `src/app-layer`, at MODULE level and
 * exported so `selector-teeth` can mutation-audit it — a selection made inline
 * inside `it()` passes whether or not it selected anything.
 *
 * Comments are blanked and STRINGS ARE KEPT: the value is the thing being
 * graded. Blanking comments is what stops this file's own prose, and the
 * explanatory comments at both call sites, from entering the population.
 */
export function personPushLinkPaths(): { file: string; line: number; value: string }[] {
    const out: { file: string; line: number; value: string }[] = [];
    for (const abs of collectSourceFiles({ roots: ['src/app-layer'], extensions: ['.ts'] })) {
        const raw = readFileSync(abs, 'utf8');
        if (!raw.includes('farmRelativePath')) continue;
        const code = blankNonCode(raw);
        code.split('\n').forEach((ln, i) => {
            const m = /\bfarmRelativePath:\s*(.+?),?\s*$/.exec(ln);
            if (!m) return;
            const value = m[1].trim();
            // A TYPE annotation (`farmRelativePath: string | null;`) and a
            // PASS-THROUGH (`farmRelativePath: input.farmRelativePath`) are not destinations.
            // The discriminator is a quoted path, the same one
            // `notification-link-is-tenant-scoped` settled on.
            if (!/[`'"]\//.test(value)) return;
            out.push({
                file: relative(REPO_ROOT, abs).split('\\').join('/'),
                line: i + 1,
                value,
            });
        });
    }
    return out;
}

/** `/exchange/threads/dm/${x}` → `['exchange','threads','dm','*']`. */
export function pathSegments(value: string): string[] | null {
    const m = /[`'"](\/[^`'"]*)/.exec(value);
    if (!m) return null;
    return m[1]
        .split('/')
        .filter((s) => s !== '')
        .map((s) => (s.includes('${') ? '*' : s));
}

function resolves(segs: string[], patterns: string[][]): boolean {
    return patterns.some(
        (p) =>
            p.length === segs.length
            // A dynamic push segment may only land on a dynamic route
            // segment, and a literal must match a literal. `*` against
            // `[channelId]` is the intended pairing; `*` against `exchange`
            // would let any interpolation satisfy any route.
            && p.every((seg, i) =>
                segs[i] === '*' ? /^\[.*\]$/.test(seg) : seg === segs[i],
            ),
    );
}

describe('a person-scoped push link resolves to a page', () => {
    const sites = personPushLinkPaths();
    const patterns = appRoutePatterns();

    it('prints its denominator', () => {
        // eslint-disable-next-line no-console
        console.log(
            `[person-push-link] ${sites.length} farmRelativePath destination(s) graded against `
                + `${patterns.length} (app) page route(s)`,
        );
        expect(sites.length).toBeGreaterThanOrEqual(MIN_SITES);
        // The matcher needs something to match against, and an empty walk
        // would make every assertion below vacuous.
        expect(patterns.length).toBeGreaterThan(50);
    });

    it('every destination names a page that exists', () => {
        const dead = sites.filter((s) => {
            const segs = pathSegments(s.value);
            return segs === null || !resolves(segs, patterns);
        });
        expect(dead.map((d) => `${d.file}:${d.line} ${d.value}`)).toEqual([]);
    });

    it('no destination carries its own `/t/` prefix', () => {
        // `person-push-send` adds it. A value that already has one composes
        // `/t/{slug}/t/{slug}/…`, which resolves nowhere — and the two
        // conventions sit side by side in this repo: `push-send`'s `link` IS
        // tenant-prefixed, because that job's payload carries a `tenantId`.
        const prefixed = sites.filter((s) => (pathSegments(s.value) ?? [])[0] === 't');
        expect(prefixed.map((p) => `${p.file}:${p.line}`)).toEqual([]);
    });

    it('the matcher can FAIL — the control', () => {
        // Without this, "every destination resolves" is satisfied by a matcher
        // that returns true for everything, which is how a guard of this shape
        // dies. Both halves are asserted: the real path passes AND the two
        // real defects are refused.
        expect(resolves(pathSegments('`/channels/${id}`') ?? [], patterns)).toBe(true);
        expect(
            resolves(pathSegments('`/exchange/threads/dm/${id}`') ?? [], patterns),
        ).toBe(true);

        // #2932's bare `/notifications` resolves — it IS a page under `(app)`.
        // That is the point: it was wrong because nothing prefixed it, which
        // is the job's business and the previous assertion's. The two defects
        // this guard catches are a path to no page at all...
        expect(resolves(pathSegments('`/messages/${id}`') ?? [], patterns)).toBe(false);
        expect(resolves(pathSegments('`/channels/${a}/posts/${b}`') ?? [], patterns)).toBe(
            // #3030 — the permalink agrent-ios will parse, deliberately not
            // emitted until the page exists. When it does, this flips to true
            // and the line below it comes out.
            false,
        );
        // ...and an interpolation standing where a literal segment belongs.
        expect(resolves(['*', 'threads'], patterns)).toBe(false);
    });
});
