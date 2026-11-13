/**
 * Every notification DESTINATION in `src/app-layer` names a page that exists —
 * #2987, and #2932 is why it needs a guard rather than a convention.
 *
 * ## The defect this exists for, three times over
 *
 * `push-summary` sent `url: '/notifications'` and `link: '/notifications'`, a
 * bare path with no tenant slug. There is no root-level `/notifications` page,
 * so `public/sw.js`'s `clients.openWindow(target)` opened a **404**, and on
 * iOS there was no `PushLink` case so the push merely opened the app. #2932
 * fixed it and measured the population: 19 of 19 production
 * `Notification.linkUrl` rows started with `/t/`, and that one job was the
 * only violator.
 *
 * It then happened twice more on 2026-11-13, in two sessions at once:
 *
 *   - the person-scoped push aimed at `/messages/{conversationId}` — a route
 *     P8.4 ruled out **outright**, putting the DM screen under
 *     `/t/{slug}/exchange/threads/dm/{id}`. Two docs said so and the comment
 *     three lines above the literal said so;
 *   - `machine-area-alert`'s `link:` pointed at `/t/{slug}/machines/{assetId}`
 *     — FIXED in #3032 by adding the page; the exemption deleted itself
 *     (#3032). Correctly prefixed, and there is no `machines` page — the live
 *     map and day history are iOS screens — so a web recipient clicking that
 *     notification got a 404 from the moment it merged.
 *
 * All three satisfied "root-relative", which is what the existing guard
 * checks. So the property here is deliberately NOT that. It is **resolves to a
 * `page.tsx` that exists**.
 *
 * ## Why the existing guard could not see any of them
 *
 * `notification-link-is-tenant-scoped` derives over the right tree and the
 * wrong KEY: its population is `linkUrl:` assignments, and the destinations in
 * `src/app-layer` come in four field shapes. It is correct about everything it
 * ranges over — the field name is its list, and the list has one entry. That
 * is **#3033**, filed rather than fixed here, because the PREFIX axis is its
 * job and page-existence is this file's: one property in two spellings is the
 * #1664 class, which both guards exist to avoid.
 *
 * ## The four fields, and why `url:` is out
 *
 *   `linkUrl:`          notifications/*.ts, several usecases and jobs
 *   `linkPath:`         notifications/assignment.ts, a `(slug, id) =>` lambda
 *   `link:`             the push payloads — `push-send`, `person-push-send`
 *   `farmRelativePath:` `person-push-send`'s payload
 *
 * `url:` is NOT graded, and that is a decision rather than an omission: the
 * two sites carrying it (`tenant-invites`, `org-invites`) are EMAIL payloads
 * pointing at `/invite/{token}`, which is a real page at `src/app/invite` —
 * deliberately OUTSIDE the tenant shell, because an invitee holds no
 * membership yet. Grading them against `(app)` would report two correct links
 * as dead.
 *
 * ## `farmRelativePath` checks the INVERSE prefix rule
 *
 * A channel post and a direct message are tenantless, so the enqueuing usecase
 * has no slug; `person-push-send` resolves the RECIPIENT's oldest active farm
 * and composes `/t/{slug}{farmRelativePath}`, sending no link when it cannot.
 * A value in that field carrying its own `/t/` would compose
 * `/t/{slug}/t/{slug}/…`, so it is refused. For the other three, a leading
 * `/t/{…}` is stripped before resolution and its ABSENCE is #3033's business,
 * not this file's — #2932's bare `/notifications` resolves fine here, and was
 * wrong for the other reason.
 *
 * ## The field name is `farmRelativePath` because `linkPath` was taken
 *
 * It was `linkPath` for an afternoon, and THIS GUARD found the collision:
 * `notifications/assignment.ts` has carried a `linkPath` since #2490 meaning
 * the opposite — a builder producing the FULL prefixed link. One name, two
 * opposite meanings, in one codebase: «Борса» against «Пазар» for one
 * destination, `app.user_id` against `app.actor_user_id` for one person.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { DESTINATION_FIELDS } from '../helpers/notification-destination-fields';

const APP_ROOT = join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)');

/** Which prefix rule each destination field obeys. See the docblock. */
/**
 * The field list moved to `tests/helpers/notification-destination-fields.ts`
 * in #3033, because the sibling prefix guard needs the SAME list and had a
 * copy with one entry. Two copies of "which fields carry a destination" is how
 * one of them goes stale when a producer picks a different name — which is
 * exactly what happened. The postures and the reason `url:` is absent are
 * documented there; the extraction below stays here, on its own axis.
 */

/**
 * Floors, not equalities. A fifth producer is welcome; a population that
 * silently drops is the failure a floor separates from zero.
 */
const MIN_SITES = 14;
const MIN_PAGE_ROUTES = 50;

/**
 * A CEILING on the blind spot, so it cannot grow quietly.
 *
 * One site is ungradable today — `lease-expiry-sweep.ts`, a nested template the
 * literal scan cannot see the end of. The sibling guard keeps the same kind of
 * honesty about its own blind spot (a path held in a variable) by printing the
 * count; a ceiling is strictly more, because a second such producer is then a
 * visible line in a diff rather than a number nobody reads.
 */
const MAX_UNGRADABLE = 1;

/**
 * A destination the guard knows is dead, with the issue that makes it dead and
 * the change that will fix it. SHRINK-ONLY, and the "no stale entries" test
 * below deletes its own cover: once the page exists the entry FAILS, so it
 * cannot outlive the defect.
 *
 * Keyed by file plus the path SHAPE rather than a line number — a comment
 * added above a producer moves the line and would silently un-exempt it.
 */
const DEAD_BY_KNOWN_ISSUE: Readonly<Record<string, string>> = {
    // EMPTY, and it emptied itself.
    //
    // `machine-area-alert :: t/*/machines/*` was the one entry, exempted
    // against #3032. That PR added `machines/[assetId]/page.tsx`, so the
    // destination resolves, so the "no stale entries" assertion below failed
    // the moment the two met — which is the entry deleting its own cover
    // exactly as its author designed. Removed here, in the diff that fixed the
    // defect, rather than left as a permanent excuse.
    //
    // The reading on every run is the thing to watch: `15 resolve, 0 dead`
    // after this. Anything else wants investigating rather than a floor moved.
};

/**
 * The route patterns `(app)` serves, as segment arrays.
 *
 * Route GROUPS — `(app)`, `(whatever)` — contribute no URL segment and are
 * dropped; a `[param]` segment is kept. Derived from the filesystem rather
 * than listed, which is the half that makes a renamed page fail here instead
 * of in production.
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
 * Replace every BALANCED `${…}` with a single `*`, innermost first.
 *
 * Nesting is the reason this is a loop rather than one regex, and the reason
 * is measured: `lease-expiry-sweep.ts` writes
 * `` `/t/${r.slug}/rent${cond ? `?locationId=${id}` : ''}` ``, and a
 * `[^`'"]*` scan stops at the INNER backtick — grading `['*']` where the real
 * path is `/rent`, i.e. reporting a correct link as dead. A guard that
 * mis-parses toward DEAD blocks correct work, which is worse than one that
 * misses.
 */
export function collapseInterpolations(src: string): string {
    let out = src;
    for (let i = 0; i < 20; i++) {
        const next = out.replace(/\$\{[^{}]*\}/g, '*');
        if (next === out) return next;
        out = next;
    }
    return out;
}

export type Destination =
    | { kind: 'graded'; segments: string[] }
    | { kind: 'ungradable'; why: string };

/**
 * `/exchange/threads/dm/${x}` → `['exchange','threads','dm','*']`.
 *
 * THREE outcomes, not two. A segment that is part literal and part
 * interpolation (`rent*`, from the nested case above) cannot be matched
 * against a Next route, because Next resolves a whole segment — so it is
 * reported UNGRADABLE and COUNTED, never silently passed and never failed.
 * That is the same honesty `notification-link-is-tenant-scoped` keeps about
 * its own blind spot (a path held in a variable), stated rather than hidden.
 *
 * The QUERY STRING is cut and not graded. `/channels/${id}?post=${postId}` is
 * a real destination — the post rides in the query because that is the shape
 * agrent-ios honours on already-shipped builds — and a query parameter is not
 * a route segment. The cost: a misspelled parameter name is uncaught here,
 * which is a degraded link rather than a broken one.
 */
export function destinationOf(pathLiteral: string): Destination {
    const collapsed = collapseInterpolations(pathLiteral).split('?')[0];
    const segs = collapsed.split('/').filter((s) => s !== '');
    for (const s of segs) {
        // An interpolation the extractor could not see the END of. The literal
        // scan stops at a quote, so a NESTED template truncates the value
        // mid-expression and leaves an unbalanced `${` behind — measured on
        // `lease-expiry-sweep.ts`, whose destination is
        // `/t/${slug}/rent${cond ? `?locationId=${id}` : ''}`. Reporting that
        // as dead is a FALSE ALARM that blocks correct work; reporting it as
        // graded would pass a segment nobody understands. It is neither.
        if (s.includes('${') || s.includes('}')) {
            return { kind: 'ungradable', why: `truncated interpolation in ${JSON.stringify(s)}` };
        }
        if (s !== '*' && s.includes('*')) {
            return { kind: 'ungradable', why: `mixed segment ${JSON.stringify(s)}` };
        }
    }
    return { kind: 'graded', segments: segs };
}

/** Every quoted path in a value — a ternary carries two, and both are graded. */
export function pathLiteralsIn(value: string): string[] {
    const out: string[] = [];
    for (const m of value.matchAll(/[`'"](\/[^`'"]*)/g)) out.push(m[1]);
    return out;
}

/**
 * Every destination assignment under `src/app-layer`, at MODULE level and
 * exported so `selector-teeth` can mutation-audit it — a selection made inline
 * inside `it()` passes whether or not it selected anything.
 *
 * Comments are blanked and STRINGS ARE KEPT: the value is the thing graded.
 * Blanking comments is what stops this file's own prose, and the explanatory
 * comments at the call sites, from entering the population.
 */
export function destinationSites(): {
    file: string;
    line: number;
    field: keyof typeof DESTINATION_FIELDS;
    value: string;
}[] {
    const out: {
        file: string;
        line: number;
        field: keyof typeof DESTINATION_FIELDS;
        value: string;
    }[] = [];
    const fieldAlt = Object.keys(DESTINATION_FIELDS).join('|');
    const re = new RegExp(`\\b(${fieldAlt}):\\s*(.+?),?\\s*$`);
    for (const abs of collectSourceFiles({ roots: ['src/app-layer'], extensions: ['.ts'] })) {
        const raw = readFileSync(abs, 'utf8');
        if (!Object.keys(DESTINATION_FIELDS).some((f) => raw.includes(f))) continue;
        const code = blankNonCode(raw);
        code.split('\n').forEach((ln, i) => {
            const m = re.exec(ln);
            if (!m) return;
            const value = m[2].trim();
            // A TYPE annotation (`link: string | null;`) and a PASS-THROUGH
            // (`link: payload.link`) are not destinations. The discriminator
            // is a quoted path — the same one the sibling guard settled on.
            if (pathLiteralsIn(value).length === 0) return;
            out.push({
                file: relative(REPO_ROOT, abs).split('\\').join('/'),
                line: i + 1,
                field: m[1] as keyof typeof DESTINATION_FIELDS,
                value,
            });
        });
    }
    return out;
}

function resolvableSegments(
    field: keyof typeof DESTINATION_FIELDS,
    segments: string[],
): string[] {
    // A leading `/t/{…}` is the tenant shell. Stripping it is what lets one
    // page-route set grade both conventions. Its ABSENCE on a tenant-prefixed
    // field is #3033's axis, not this file's.
    if (DESTINATION_FIELDS[field] === 'tenant-prefixed' && segments[0] === 't') {
        return segments.slice(2);
    }
    return segments;
}

function resolves(segs: string[], patterns: string[][]): boolean {
    return patterns.some(
        (p) =>
            p.length === segs.length
            // A dynamic push segment may only land on a dynamic route segment,
            // and a literal must match a literal. `*` against `[channelId]` is
            // the intended pairing; `*` against `exchange` would let any
            // interpolation satisfy any route.
            && p.every((seg, i) => (segs[i] === '*' ? /^\[.*\]$/.test(seg) : seg === segs[i])),
    );
}

interface Verdict {
    site: string;
    key: string;
    segments: string[];
}

function classify(patterns: string[][]): {
    ok: Verdict[];
    dead: Verdict[];
    ungradable: { site: string; why: string }[];
    selfPrefixed: string[];
} {
    const ok: Verdict[] = [];
    const dead: Verdict[] = [];
    const ungradable: { site: string; why: string }[] = [];
    const selfPrefixed: string[] = [];

    for (const s of destinationSites()) {
        const site = `${s.file}:${s.line}`;
        for (const lit of pathLiteralsIn(s.value)) {
            const d = destinationOf(lit);
            if (d.kind === 'ungradable') {
                ungradable.push({ site, why: d.why });
                continue;
            }
            if (DESTINATION_FIELDS[s.field] === 'farm-relative' && d.segments[0] === 't') {
                selfPrefixed.push(site);
                continue;
            }
            const segs = resolvableSegments(s.field, d.segments);
            const key = `${s.file} :: ${d.segments.join('/')}`;
            const v: Verdict = { site, key, segments: segs };
            if (resolves(segs, patterns)) ok.push(v);
            else dead.push(v);
        }
    }
    return { ok, dead, ungradable, selfPrefixed };
}

describe('a notification destination resolves to a page', () => {
    const patterns = appRoutePatterns();
    const sites = destinationSites();
    const { ok, dead, ungradable, selfPrefixed } = classify(patterns);

    it('prints its denominator', () => {
        // No `eslint-disable` here, deliberately: every other guard in this
        // directory prints its denominator bare, so the rule is not enforced
        // for tests — and the lint CEILING counts INERT directives, so a
        // defensive one fails the build. Measured: it did.
        console.log(
            `[notify-destination] ${sites.length} assignment(s) over `
                + `${Object.keys(DESTINATION_FIELDS).length} field(s) → ${ok.length} resolve, `
                + `${dead.length} dead, ${ungradable.length} ungradable, against `
                + `${patterns.length} (app) page route(s)`,
        );
        expect(sites.length).toBeGreaterThanOrEqual(MIN_SITES);
        // The matcher needs something to match against; an empty walk would
        // make every assertion below vacuous.
        expect(patterns.length).toBeGreaterThanOrEqual(MIN_PAGE_ROUTES);
        // A population that is ALL ungradable would pass the dead check while
        // grading nothing — the empty-selection defect one level in.
        expect(ok.length).toBeGreaterThan(dead.length + ungradable.length);
        expect(ungradable.map((u) => `${u.site} — ${u.why}`).length).toBeLessThanOrEqual(
            MAX_UNGRADABLE,
        );
    });

    it('every destination names a page that exists', () => {
        const unexpected = dead.filter((d) => DEAD_BY_KNOWN_ISSUE[d.key] === undefined);
        expect(unexpected.map((d) => `${d.site} → /${d.segments.join('/')}`)).toEqual([]);
    });

    it('no known-dead entry has outlived its defect', () => {
        // The exemption deletes its own cover. When #3032 adds the page, the
        // destination resolves, drops out of `dead`, and this fails until the
        // entry goes — so the map cannot quietly become a list of things
        // nobody fixed.
        const stale = Object.keys(DEAD_BY_KNOWN_ISSUE).filter(
            (k) => !dead.some((d) => d.key === k),
        );
        expect(stale).toEqual([]);
    });

    it('a farm-relative destination never carries its own `/t/`', () => {
        // `person-push-send` adds it. A value that already has one composes
        // `/t/{slug}/t/{slug}/…`, which resolves nowhere — and the two
        // conventions sit side by side: `push-send`'s `link` IS tenant-
        // prefixed, because that payload carries a `tenantId`.
        expect(selfPrefixed).toEqual([]);
    });

    it('the matcher can FAIL — the control', () => {
        // Without this, "every destination resolves" is satisfied by a matcher
        // returning true for everything, which is how a guard of this shape
        // dies. Both directions are asserted.
        expect(resolves(['channels', '*'], patterns)).toBe(true);
        expect(resolves(['exchange', 'threads', 'dm', '*'], patterns)).toBe(true);

        // The real defect that is still a defect. `/messages/{id}` is the page
        // P8.4 ruled out explicitly, so nothing serves it.
        expect(resolves(['messages', '*'], patterns)).toBe(false);

        /*
         * `['machines', '*']` USED to be here as the second real defect and
         * now resolves: #3032 added `machines/[assetId]/page.tsx`, a redirect
         * to the asset, because the alert's link shape is one a shipped
         * TestFlight build already parses.
         *
         * It moved to the TRUE side rather than being deleted, which keeps the
         * control honest in both directions — and it is the better assertion
         * now, because the page is a redirect whose whole purpose is that this
         * destination resolves. Delete it only when the alert points somewhere
         * else.
         */
        expect(resolves(['machines', '*'], patterns)).toBe(true);

        // An interpolation standing where a literal segment belongs.
        expect(resolves(['*', 'threads'], patterns)).toBe(false);

        // #3030 — the permalink agrent-ios will parse, deliberately not
        // emitted until the page exists. This flips to true when it does.
        expect(resolves(['channels', '*', 'posts', '*'], patterns)).toBe(false);
    });

    it('parses the shapes that actually occur', () => {
        // The nested template that my first draft reported as dead.
        // Exactly what the literal scan hands over for the real site: it stops
        // at the inner backtick, so the expression is cut mid-way. Note the
        // ternary's own `?` is gone — the query cut runs first and cannot tell
        // a `?` that separates a query from a `?` that opens a ternary. It
        // does not change the verdict, and pinning the string here is what
        // stops that quirk being rediscovered as a bug.
        expect(destinationOf('/t/${r.slug}/rent${lease.parcel.locationId ? ')).toEqual({
            kind: 'ungradable',
            why: 'truncated interpolation in "rent${lease.parcel.locationId "',
        });
        // And a genuinely mixed segment is the other ungradable shape.
        expect(destinationOf('/t/${s}/rent*x')).toEqual({
            kind: 'ungradable',
            why: 'mixed segment "rent*x"',
        });

        // A ternary carries TWO literals and both are graded.
        expect(
            pathLiteralsIn("ctx.tenantSlug ? `/t/${ctx.tenantSlug}/evidence` : null"),
        ).toEqual(['/t/${ctx.tenantSlug}/evidence']);

        // The query is cut, so the emitted channel shape resolves to the same
        // page as the bare one.
        expect(destinationOf('/channels/${id}?post=${p}')).toEqual({
            kind: 'graded',
            segments: ['channels', '*'],
        });

        // A lambda body is a value like any other.
        expect(pathLiteralsIn('(slug, id) => `/t/${slug}/assets/${id}`')).toEqual([
            '/t/${slug}/assets/${id}',
        ]);
    });
});
