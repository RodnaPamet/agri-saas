/**
 * Emit `src/generated/route-inventory.json` — the path templates this HTTP
 * surface serves, as an APPEND-ONLY ledger.
 *
 * ## Why this file exists
 *
 * agri-saas#1087 renamed five tile routes out from under the native iOS
 * client, which went on calling the old shape and silently rendered no
 * satellite overlay until the owner noticed on a phone. The rename was
 * deliberate and correct; what was missing was anything that made the BREAK
 * visible. Both test suites stayed green, because a route rename is invisible
 * to a repo that only checks its own callers.
 *
 * The client half of the control lives in agrent-ios#132 (every path the app
 * builds must exist here). This is the artifact it reads, and the server half
 * is `tests/guards/route-inventory-ledger.test.ts`.
 *
 * ## Why not just let the client vendor openapi.json
 *
 * Measured: the spec is 1.29 MB and took 39 commits in 30 days, about one
 * every eighteen hours. Only 18 of those changed the PATH SET. A client that
 * vendored the spec would carry daily megabyte churn for the handful of
 * strings it needs. This file is the path list alone.
 *
 * It is also the only COMPLETE answer. 239 of the 368 live paths are real
 * routes that are simply undocumented — they sit on
 * `tests/guards/openapi-undocumented-baseline.json` — so a client checking
 * against the spec alone would report `/api/auth/token`,
 * `/api/account/profile` and most of the admin surface as nonexistent. The
 * `documented` flag carries that distinction instead of hiding it: `true`
 * means the shape is verifiable against the spec, `false` means the route
 * exists and its shape is not described anywhere.
 *
 * ## Append-only, and why the generator will not retire anything
 *
 * A ledger that regenerated wholesale would make a REMOVAL exactly as cheap
 * as an addition, which is the defect it exists to prevent — the same shape as
 * `npm run fonts:vendor` writing files and hashes in one step, where a changed
 * font program becomes a green diff.
 *
 * So: this script ADDS paths that appeared, and RESURRECTS a retired path that
 * came back (a route returning is not a silent loss). It NEVER marks a path
 * retired. When a path leaves the filesystem the entry stays `live`, the guard
 * fails, and a human has to write down what happened to it and why. That
 * sentence in the diff is the whole point.
 *
 *     npm run routes:inventory
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ROOT, routePathTemplates } from './lib/api-routes';

const OUT_REL = 'src/generated/route-inventory.json';
const SPEC_REL = 'src/generated/openapi.json';

interface Entry {
    path: string;
    status: 'live' | 'retired';
    /** Verifiable against openapi.json. Absent-from-spec is not absent-from-server. */
    documented?: boolean;
    /** Required on a retired entry. Why it went, and what replaced it. */
    reason?: string;
}

interface Inventory {
    _README: string[];
    routes: Entry[];
}

const README = [
    'Every path template this API serves. APPEND-ONLY.',
    '',
    'ORDER: `routes` is sorted by `path` in UTF-16 CODE-UNIT order, never via',
    'localeCompare — that resolves through the generating machine\'s ICU and',
    'locale, so two machines could emit different bytes for the same surface.',
    'tests/guards/route-inventory-ledger.test.ts asserts the order.',
    '',
    'Consumed by native clients to check that a path they build still exists',
    '(agrent-ios#132) and by tests/guards/route-inventory-ledger.test.ts, which',
    'fails when a live path leaves the filesystem.',
    '',
    'RULES:',
    '  - `npm run routes:inventory` adds new paths and resurrects returning',
    '    ones. It NEVER retires a path. That is deliberate: a generator that',
    '    rewrote the list wholesale would make a removal as cheap as an',
    '    addition, which is the defect this file exists to prevent.',
    '  - A path that leaves the filesystem FAILS the guard until someone sets',
    '    `status: "retired"` and writes a `reason`. A client may be calling it.',
    '  - `documented: false` means the route EXISTS and no schema describes it',
    '    (it is on openapi-undocumented-baseline.json). It does not mean the',
    '    route is absent. 239 of 368 were in that state when this file was',
    '    created.',
    '',
    'WHY IT EXISTS: #1087 renamed five tile routes and the iOS client went on',
    'calling the old shape, rendering no satellite overlay until the owner saw',
    'it on a phone. Both suites stayed green — a rename is invisible to a repo',
    'that only checks its own callers.',
];

function load(abs: string): Inventory {
    if (!fs.existsSync(abs)) return { _README: README, routes: [] };
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as Inventory;
    if (!Array.isArray(parsed.routes)) {
        throw new Error(`${OUT_REL} has no \`routes\` array — refusing to overwrite it.`);
    }
    return parsed;
}

function documentedPaths(): Set<string> {
    const abs = path.join(ROOT, SPEC_REL);
    if (!fs.existsSync(abs)) {
        throw new Error(`${SPEC_REL} is missing — run \`npm run openapi:generate\` first.`);
    }
    const spec = JSON.parse(fs.readFileSync(abs, 'utf8')) as { paths?: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});
    if (paths.length === 0) {
        // The spec's own historical defect: `paths?:` is optional, so a
        // document describing zero endpoints satisfies every check.
        throw new Error(`${SPEC_REL} describes zero paths — that is never right.`);
    }
    return new Set(paths);
}

function main(): void {
    const outAbs = path.join(ROOT, OUT_REL);
    const inventory = load(outAbs);
    const onDisk = routePathTemplates();
    const documented = documentedPaths();
    const byPath = new Map(inventory.routes.map((e) => [e.path, e]));

    let added = 0;
    let resurrected = 0;

    for (const p of onDisk) {
        const existing = byPath.get(p);
        if (!existing) {
            byPath.set(p, { path: p, status: 'live', documented: documented.has(p) });
            added += 1;
            continue;
        }
        if (existing.status === 'retired') {
            // It came back. Resurrecting is safe — the hazard is a silent
            // DISAPPEARANCE, not a reappearance.
            existing.status = 'live';
            delete existing.reason;
            resurrected += 1;
        }
        existing.documented = documented.has(p);
    }

    // Deliberately NOT retiring anything. Report it instead, loudly, and let
    // the guard be the thing that fails.
    const vanished = [...byPath.values()].filter(
        (e) => e.status === 'live' && !onDisk.includes(e.path),
    );

    // CODE-UNIT order, never `localeCompare`.
    //
    // This file is consumed by a drift check, so its byte order is part of its
    // contract. `localeCompare` resolves through ICU and the generating
    // machine's locale, which collates punctuation differently — it placed
    // `/api/notifications/{id}` BEFORE `/api/notifications/stream` even though
    // `{` is 0x7B and `s` is 0x73. Sixteen such inversions shipped in the first
    // version of this file, caught by the iOS session reading it.
    //
    // Two machines regenerating the "same" inventory could therefore produce
    // different bytes, and a reorder would read as a change — in the one
    // artifact whose job is to make a real change impossible to miss.
    const routes = [...byPath.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const next: Inventory = { _README: README, routes };
    fs.writeFileSync(outAbs, `${JSON.stringify(next, null, 2)}\n`);

    const live = routes.filter((e) => e.status === 'live').length;
    const undocumented = routes.filter((e) => e.status === 'live' && !e.documented).length;
    process.stdout.write(
        `${OUT_REL}: ${routes.length} entries — ${live} live ` +
            `(${live - undocumented} documented, ${undocumented} undocumented), ` +
            `${routes.length - live} retired. +${added} added, +${resurrected} resurrected.\n`,
    );

    if (vanished.length > 0) {
        process.stdout.write(
            `\n${vanished.length} live path(s) are NO LONGER ON DISK. This script does not\n` +
                `retire them — a client may be calling them, so the decision is a human's:\n\n` +
                vanished.map((e) => `    ${e.path}`).join('\n') +
                `\n\nSet \`status: "retired"\` with a \`reason\` naming what replaced it, and\n` +
                `tell whoever maintains the clients. The guard fails until you do.\n`,
        );
    }
}

main();
