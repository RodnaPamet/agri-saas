/**
 * A path cannot leave this API silently.
 *
 * ## The defect this exists for
 *
 * #1087 renamed five satellite-tile routes — correctly, to get a location id
 * out of a query string that Apple's networking layer writes to the device log
 * below anything an app can suppress. It shipped without a compatibility shim,
 * deliberately, on the reasoning that "the app is pre-release so a coordinated
 * change costs a version bump rather than users".
 *
 * The coordinated change never happened. The iOS client went on building the
 * old shape, every request 404'd, no satellite overlay mounted, and nobody
 * knew until the owner opened the map on a phone four days later. Both test
 * suites were green throughout, because a route rename is invisible to a repo
 * that only ever checks its own callers.
 *
 * ## The two halves
 *
 * This is the SERVER half: a path that leaves the filesystem fails HERE, on
 * the PR that removes it. agrent-ios#132 is the client half: every path that
 * app builds must exist in `src/generated/route-inventory.json`.
 *
 * Neither subsumes the other, and the asymmetry is the point —
 * `tests/guards/public-routes-self-authenticate.test.ts` makes the same
 * argument for its own two directions, that "either half alone is worse than
 * neither". A client-side check cannot fail on the diff that causes the break;
 * a server-side check cannot know what a client calls.
 *
 * ## Why an append-only ledger rather than a regenerated list
 *
 * `npm run routes:inventory` adds and resurrects; it never retires. If it
 * rewrote the list wholesale, a removal would cost exactly what an addition
 * costs — a regenerated file — and the reviewer would see a line vanish with
 * no reason attached. That is the `fonts:vendor` lesson in this repo: writing
 * the files and their hashes in one step makes a changed font program a green
 * diff. So a vanished path stays `live`, this guard fails, and somebody has to
 * write down what replaced it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    NON_SURFACE_ROUTE_FILES as EXEMPT,
    ROOT,
    routeFiles,
    routePathTemplates,
    toOpenApiPath,
    toRouteFile,
} from '../../scripts/lib/api-routes';

const INVENTORY_REL = 'src/generated/route-inventory.json';
const SPEC_REL = 'src/generated/openapi.json';

interface Entry {
    path: string;
    status: 'live' | 'retired';
    documented?: boolean;
    reason?: string;
}

interface Audit {
    /** On disk with no live entry — the inventory is stale; regenerate. */
    missingFromInventory: string[];
    /** A live entry whose route is gone. THE #1087 CLASS. */
    vanished: string[];
    /** Retired with no reason written. */
    retiredWithoutReason: string[];
    /** Retired, but the route is back — resurrect it. */
    staleRetired: string[];
}

/**
 * The whole comparison, as a pure function of two lists.
 *
 * Pure on purpose. The controls below drive it with synthetic input, which is
 * what proves it can FAIL — and it takes arrays rather than a reader, so
 * making it testable does not introduce a second untested collector the way an
 * injected `readFromDisk` seam would.
 */
export function auditInventory(onDisk: readonly string[], routes: readonly Entry[]): Audit {
    const disk = new Set(onDisk);
    const live = new Set(routes.filter((e) => e.status === 'live').map((e) => e.path));
    const retired = routes.filter((e) => e.status === 'retired');
    // Any entry at all, live or retired. `missingFromInventory` means "this
    // route is not recorded"; a route that IS recorded but marked retired is a
    // different situation and `staleRetired` names it. Partitioning on `live`
    // reported such a path twice, under two names, one of which told the
    // reader to regenerate — which would have been the wrong fix.
    const known = new Set(routes.map((e) => e.path));

    return {
        missingFromInventory: [...disk].filter((p) => !known.has(p)).sort(),
        vanished: [...live].filter((p) => !disk.has(p)).sort(),
        retiredWithoutReason: retired
            .filter((e) => !e.reason || e.reason.trim().length === 0)
            .map((e) => e.path)
            .sort(),
        staleRetired: retired
            .filter((e) => disk.has(e.path))
            .map((e) => e.path)
            .sort(),
    };
}

const inventory = JSON.parse(
    fs.readFileSync(path.join(ROOT, INVENTORY_REL), 'utf8'),
) as { _README?: string[]; routes: Entry[] };

const onDisk = routePathTemplates();

describe('route inventory — a path cannot leave silently', () => {
    // ── Positive controls ────────────────────────────────────────────
    //
    // Every assertion below is of the form "this set is empty", and an empty
    // set is what two empty inputs produce. Without these, a walk that
    // resolved nothing and a file that parsed to nothing would report a
    // perfectly clean ledger.

    it('control: the walk found a real route surface', () => {
        // `routePathTemplates` throws under its own floor, so reaching here
        // already means >300 files. Pinned again because this file's whole
        // output is "nothing is wrong".
        expect(onDisk.length).toBeGreaterThan(300);
        expect(onDisk.every((p) => p.startsWith('/api/'))).toBe(true);
        expect(new Set(onDisk).size).toBe(onDisk.length); // no duplicate templates
    });

    it('control: the inventory parsed and describes that surface', () => {
        expect(inventory.routes.length).toBeGreaterThan(300);
        expect(inventory.routes.every((e) => e.status === 'live' || e.status === 'retired')).toBe(
            true,
        );
        // The path<->file mapping ROUND-TRIPS. Without this, a broken
        // `toOpenApiPath` would make the ledger agree with a fiction — both
        // sides derived from the same wrong function, agreeing perfectly.
        //
        // Deliberately NOT "every live entry maps to a file that exists":
        // that is true of a genuine removal too, so it would raise a second
        // alarm for the situation the `vanished` test already names, and one
        // of the two messages would send the reader to the wrong fix.
        const roundTripped = routeFiles()
            .filter((f) => !EXEMPT.has(f))
            .filter((f) => toRouteFile(toOpenApiPath(f)) !== f);
        expect(roundTripped).toEqual([]);
    });

    it('control: auditInventory reports a vanished path, and only that', () => {
        // The assertion this file exists for cannot demonstrate itself: it is
        // green precisely when nothing vanished. So drive the comparison with
        // a synthetic pair where a path HAS gone.
        const audit = auditInventory(
            ['/api/kept'],
            [
                { path: '/api/kept', status: 'live' },
                { path: '/api/gone', status: 'live' },
            ],
        );
        expect(audit.vanished).toEqual(['/api/gone']);
        expect(audit.missingFromInventory).toEqual([]);
        expect(audit.retiredWithoutReason).toEqual([]);
        expect(audit.staleRetired).toEqual([]);
    });

    it('control: auditInventory separates its four outcomes', () => {
        const audit = auditInventory(
            ['/api/new', '/api/back'],
            [
                { path: '/api/gone', status: 'live' },
                { path: '/api/back', status: 'retired', reason: 'was retired in error' },
                { path: '/api/quiet', status: 'retired' },
            ],
        );
        // A new route on disk is a stale INVENTORY, not a missing route.
        expect(audit.missingFromInventory).toEqual(['/api/new']);
        // A live entry with no file is the dangerous one.
        expect(audit.vanished).toEqual(['/api/gone']);
        // A retirement with no reason is a removal with no record.
        expect(audit.retiredWithoutReason).toEqual(['/api/quiet']);
        // A retired path that is back must be resurrected, not left lying.
        expect(audit.staleRetired).toEqual(['/api/back']);
    });

    it('control: a retirement WITH a reason is accepted', () => {
        const audit = auditInventory(
            [],
            [{ path: '/api/old', status: 'retired', reason: 'renamed to /api/new in #1087' }],
        );
        expect(audit.vanished).toEqual([]);
        expect(audit.retiredWithoutReason).toEqual([]);
    });

    // ── The ledger itself ────────────────────────────────────────────

    const audit = auditInventory(onDisk, inventory.routes);

    it('every live path in the inventory still exists on disk', () => {
        if (audit.vanished.length > 0) {
            throw new Error(
                `${audit.vanished.length} path(s) are in the inventory as live but no longer ` +
                    `exist:\n${audit.vanished.map((p) => `  ${p}`).join('\n')}\n\n` +
                    `A CLIENT MAY BE CALLING THEM. This is #1087: five tile routes were ` +
                    `renamed,\nthe iOS app kept calling the old shape, and nothing went red ` +
                    `until someone\nopened the map on a phone.\n\n` +
                    `If the removal is intended, set \`status: "retired"\` on each entry in ` +
                    `${INVENTORY_REL}\nwith a \`reason\` naming what replaced it — and tell ` +
                    `whoever maintains the native\nclients, because their guard reads this ` +
                    `file. Do NOT delete the entry.`,
            );
        }
        expect(audit.vanished).toEqual([]);
    });

    it('every route on disk is in the inventory', () => {
        if (audit.missingFromInventory.length > 0) {
            throw new Error(
                `${audit.missingFromInventory.length} route(s) on disk are not in the ` +
                    `inventory:\n${audit.missingFromInventory.map((p) => `  ${p}`).join('\n')}\n\n` +
                    `Run \`npm run routes:inventory\` and commit the result.`,
            );
        }
        expect(audit.missingFromInventory).toEqual([]);
    });

    it('every retired entry carries a reason, and none has come back', () => {
        expect(audit.retiredWithoutReason).toEqual([]);
        expect(audit.staleRetired).toEqual([]);
    });

    it('the documented flag agrees with the spec', () => {
        const spec = JSON.parse(fs.readFileSync(path.join(ROOT, SPEC_REL), 'utf8')) as {
            paths: Record<string, unknown>;
        };
        const documented = new Set(Object.keys(spec.paths));
        // A positive control on the spec read itself: the flag is only
        // meaningful if some paths are documented and some are not.
        expect(documented.size).toBeGreaterThan(0);

        const wrong = inventory.routes
            .filter((e) => e.status === 'live')
            .filter((e) => (e.documented ?? false) !== documented.has(e.path))
            .map((e) => e.path);
        expect(wrong).toEqual([]);

        const live = inventory.routes.filter((e) => e.status === 'live');
        expect(live.some((e) => e.documented)).toBe(true);
        expect(live.some((e) => !e.documented)).toBe(true);
    });
});
