/**
 * App Router modules export only what Next allows.
 *
 * ## Why this guard exists, and why CI could not see the problem
 *
 * Next generates type-constraint files under `.next/types/**` that reject a
 * `route.ts` exporting anything other than an HTTP handler or route-segment
 * config, and a `page.tsx`/`layout.tsx` exporting anything other than a
 * default plus metadata/config. Violating it is a real error — `tsc` reports
 * `TS2344: … is incompatible with index signature`.
 *
 * **But that error only exists if a build ran first.** The `Typecheck` CI job
 * runs `tsc --noEmit` on a clean checkout, where `.next/types` does not exist,
 * so the constraint files are absent and the violation is invisible. The
 * `Build` job compiles but does not fail on it either. The result: three
 * violations accumulated on main — `HANDOFF_COOKIE` in
 * `api/auth/native/start/route.ts`, a dead `jsonResponse` re-export in
 * `processes/[id]/export-pdf/route.ts`, and `KeyDisplay` in the api-keys
 * page — and the only way anyone saw them was running `tsc` locally straight
 * after a build.
 *
 * This guard needs no build, so it runs everywhere `tsc` runs and fails on the
 * PR that introduces the export rather than months later.
 *
 * ## What it does NOT do
 *
 * Type-only exports (`export type`, `export interface`) are erased before Next
 * ever sees them and are legal; they are ignored here. This is a source-text
 * scan, so it is a floor, not a proof — the authoritative check remains Next's
 * own generated constraint, which a build-then-typecheck will still surface.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(ROOT, 'src/app');

/**
 * Route-segment config, shared by every App Router module kind.
 * https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
 */
const SEGMENT_CONFIG = [
    'dynamic',
    'dynamicParams',
    'revalidate',
    'fetchCache',
    'runtime',
    'preferredRegion',
    'maxDuration',
    'generateStaticParams',
    'config',
];

const ALLOWED: Record<string, string[]> = {
    route: [...SEGMENT_CONFIG, 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    page: [...SEGMENT_CONFIG, 'default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport'],
    layout: [...SEGMENT_CONFIG, 'default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport'],
    template: [...SEGMENT_CONFIG, 'default'],
    'not-found': [...SEGMENT_CONFIG, 'default', 'metadata', 'generateMetadata'],
    error: [...SEGMENT_CONFIG, 'default'],
    'global-error': [...SEGMENT_CONFIG, 'default'],
    loading: [...SEGMENT_CONFIG, 'default'],
    default: [...SEGMENT_CONFIG, 'default'],
    'opengraph-image': [...SEGMENT_CONFIG, 'default', 'alt', 'size', 'contentType'],
    icon: [...SEGMENT_CONFIG, 'default', 'size', 'contentType'],
    apple: [...SEGMENT_CONFIG, 'default', 'size', 'contentType'],
    sitemap: [...SEGMENT_CONFIG, 'default'],
    robots: [...SEGMENT_CONFIG, 'default'],
    manifest: [...SEGMENT_CONFIG, 'default'],
};

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
    }
    return acc;
}

/** The App Router module kind for a file, or null if it is a plain helper. */
function moduleKind(file: string): string | null {
    const base = path.basename(file).replace(/\.(ts|tsx)$/, '');
    return base in ALLOWED ? base : null;
}

/**
 * VALUE exports declared in a module. Type-only exports are skipped because
 * they do not exist at runtime and Next never sees them.
 */
function valueExports(src: string): string[] {
    const names = new Set<string>();

    // `export function X`, `export async function X`, `export const X`,
    // `export class X`, `export let/var X`
    const decl =
        /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(src)) !== null) names.add(m[1]);

    // `export default …`
    if (/^\s*export\s+default\b/m.test(src)) names.add('default');

    // `export { A, B as C }` — but NOT `export type { … }`
    const list = /^\s*export\s+(?!type\b)\{([^}]*)\}/gm;
    while ((m = list.exec(src)) !== null) {
        for (const raw of m[1].split(',')) {
            const part = raw.trim();
            if (!part) continue;
            // `export { type Foo }` is also erased.
            if (/^type\s/.test(part)) continue;
            const asMatch = part.match(/\bas\s+([A-Za-z0-9_$]+)\s*$/);
            names.add(asMatch ? asMatch[1] : part.split(/\s+/)[0]);
        }
    }
    return [...names];
}

describe('App Router modules export only what Next allows', () => {
    const files = walk(APP_DIR).filter((f) => moduleKind(f) !== null);

    it('finds App Router modules — an empty scan must not pass vacuously', () => {
        if (files.length < 100) {
            throw new Error(
                `Only ${files.length} App Router module(s) found under ${APP_DIR}. ` +
                    `This app has hundreds; the walker is probably broken, and a broken ` +
                    `walker passes every assertion below.`,
            );
        }
        expect(files.length).toBeGreaterThan(100);
    });

    it('every module exports only permitted names', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const kind = moduleKind(file)!;
            const allowed = new Set(ALLOWED[kind]);
            const rel = path.relative(ROOT, file).split(path.sep).join('/');
            for (const name of valueExports(fs.readFileSync(file, 'utf8'))) {
                if (!allowed.has(name)) offenders.push(`${rel} exports \`${name}\` (${kind} module)`);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} App Router module(s) export a name Next does not permit:\n  ` +
                    offenders.join('\n  ') +
                    `\n\nNext's generated types reject these with TS2344 — but ONLY after a ` +
                    `build, so CI's Typecheck job cannot see them. Move the symbol into its ` +
                    `own module and import it (see ` +
                    `src/app/t/[tenantSlug]/(app)/admin/api-keys/KeyDisplay.tsx), or delete ` +
                    `it if nothing imports it.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the detector recognises the three forms that actually occurred', () => {
        // Mutation proof. Each of these shipped on main at some point.
        expect(valueExports("export { HANDOFF_COOKIE };")).toEqual(['HANDOFF_COOKIE']);
        expect(valueExports("export function KeyDisplay() {}")).toEqual(['KeyDisplay']);
        expect(valueExports("export const runtime = 'nodejs';")).toEqual(['runtime']);
    });

    it('ignores type-only exports, which Next never sees', () => {
        expect(valueExports('export type Foo = string;')).toEqual([]);
        expect(valueExports('export interface Bar { a: string }')).toEqual([]);
        expect(valueExports('export type { Baz };')).toEqual([]);
        expect(valueExports('export { type Qux };')).toEqual([]);
    });
});
