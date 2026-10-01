/**
 * The API route surface, derived from the filesystem. Held ONCE.
 *
 * Two consumers need the same answer and must not drift:
 *
 *   · `tests/guards/openapi-paths-complete.test.ts` — every route on disk is
 *     documented, exempt, or baselined.
 *   · `scripts/generate-route-inventory.ts` — emits the inventory a native
 *     client vendors to check the paths it builds still exist.
 *
 * That guard carried this derivation inline first. It is here now for the same
 * reason `scripts/lib/coverage-groups.mjs` exists: two copies of a selection
 * rule is how the two answers diverge, and the divergence is invisible until
 * something depends on both. Do not fork it.
 *
 * ── Why the collection is spelled out rather than imported ──
 *
 * `tests/helpers/collect-files.ts` has `collectSourceFiles`, which is what the
 * guard used. A script importing from `tests/` has no precedent in this repo
 * (the traffic runs the other way — five tests import from `scripts/`), so the
 * walk is reimplemented here with the two protections that matter kept intact:
 * a missing root THROWS (#875 — a renamed root scans zero files and passes),
 * and a result under the floor THROWS (#865 — an empty selection reads as
 * "every route accounted for", which is the failure direction that matters).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '..', '..');

/** Where the App Router keeps HTTP handlers, repo-relative. */
export const API_REL = 'src/app/api';

/**
 * Route files that exist but are not an HTTP surface of ours.
 *
 * `[...nextauth]` is NextAuth's own catch-all: one file serving a dozen
 * provider endpoints whose paths we do not choose. It is excluded here rather
 * than filtered by every caller.
 */
export const NON_SURFACE_ROUTE_FILES: ReadonlySet<string> = new Set([
    'src/app/api/auth/[...nextauth]/route.ts',
]);

/**
 * 353 route files at the time of writing. The floor sits well under that and
 * far above zero: it is here to catch a walk that stopped resolving, not to
 * track growth.
 */
const ROUTE_FILE_FLOOR = 300;

const SKIP_DIRS = ['node_modules', '.next', '.git', 'dist', 'coverage'];

function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.includes(entry.name)) continue;
            walk(full, out);
        } else if (entry.isFile() && entry.name === 'route.ts') {
            out.push(full);
        }
    }
    return out;
}

/**
 * Every `route.ts` under `src/app/api`, repo-relative and sorted.
 *
 * Throws rather than returning a short list — see the header.
 */
export function routeFiles(): string[] {
    const abs = path.join(ROOT, API_REL);
    if (!fs.existsSync(abs)) {
        throw new Error(
            `route root does not exist: ${API_REL} — a renamed root would walk zero ` +
                `files and report every route accounted for (#875).`,
        );
    }
    const found = walk(abs, [])
        .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
        .sort();
    if (found.length < ROUTE_FILE_FLOOR) {
        throw new Error(
            `found ${found.length} route files under ${API_REL}, below the floor of ` +
                `${ROUTE_FILE_FLOOR}. An empty or truncated selection reads as "nothing ` +
                `to check" (#865) — fix the walk rather than the floor.`,
        );
    }
    return found;
}

/** `src/app/api/t/[tenantSlug]/journal/[id]/route.ts` -> `/api/t/{tenantSlug}/journal/{id}` */
export function toOpenApiPath(routeFile: string): string {
    const dir = routeFile.slice('src/app'.length, -'/route.ts'.length);
    return dir.replace(/\[([^\]]+)\]/g, (_m, name: string) => `{${name}}`);
}

/** `/api/t/{tenantSlug}/journal/{id}` -> the route file it must have come from */
export function toRouteFile(openApiPath: string): string {
    const dir = openApiPath.replace(/\{([^}]+)\}/g, (_m, name: string) => `[${name}]`);
    return `src/app${dir}/route.ts`;
}

/**
 * Every path template the HTTP surface serves, sorted, excluding the
 * non-surface files above.
 */
export function routePathTemplates(): string[] {
    return routeFiles()
        .filter((f) => !NON_SURFACE_ROUTE_FILES.has(f))
        .map(toOpenApiPath)
        .sort();
}
