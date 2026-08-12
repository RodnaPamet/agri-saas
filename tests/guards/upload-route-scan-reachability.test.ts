/**
 * Every route that accepts a file can reach a scanner.
 *
 * ── The regression this exists for ──────────────────────────────────
 *
 * `tests/guards/upload-scan-explicitness.test.ts` derives its call sites
 * from `FileRepository.markStored`, which is exactly right for uploads that
 * mint a `FileRecord`. The avatar path mints none — a fixed key, one object
 * per user, streamed back by an image route — so it has no `markStored`
 * call for that guard to find, and it went from launch to 2026-08-12
 * calling no scanner whatsoever. Not a weak scan and not a skipped default:
 * no scan. The sibling promotion-artwork path has the same record-less
 * shape and did scan, which is precisely why the difference was invisible —
 * nothing compared them.
 *
 * So a second derivation is needed, over the class the first cannot see.
 *
 * ── Why derived from ROUTES ─────────────────────────────────────────
 *
 * Every path in this repo that ingests client bytes begins at an API route
 * reading `formData()` and pulling a `File` out of it. That is the honest
 * upstream boundary, and it is enumerable from the filesystem rather than
 * from anybody's memory of "the upload routes" — the list that failed here
 * twice, once for two importers (#543) and once for an avatar.
 *
 * A route PASSES when a call to a scanner is reachable from it: in the
 * route itself, in a module it imports, or in a module that one imports.
 * Two hops is deliberate — a route reaches a usecase which does the work.
 * Widening it would eventually let any route "reach" a scan through some
 * unrelated barrel and quietly stop meaning anything.
 *
 * The check is on the CALL, and comments are stripped before matching:
 * several guards in this repo have failed a file for prose that merely
 * described the pattern, and the inverse — passing a file whose only
 * mention of scanning is a docblock claiming it happens — is exactly the
 * failure mode #543 found in the spatial importer.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const API = path.join(SRC, 'app/api');

/** How far from a route a scanner may sit and still count as reachable. */
const MAX_HOPS = 2;

/**
 * A call to something that resolves a scan verdict.
 *
 * `ingestUploadedFile` and `scanOrRefuse` are the two shared pipelines
 * (`@/lib/upload/ingest`); the two `scan*Buffer` forms are the primitives
 * they and the not-yet-migrated usecases stand on.
 */
const SCANNERS = [
    'scanUploadedBuffer',
    'scanOrRefuse',
    'scanBuffer',
    'scanStream',
    'ingestUploadedFile',
] as const;

const SCAN_CALL = new RegExp(`\\b(${SCANNERS.join('|')})\\s*\\(`);

/**
 * A module that DEFINES a scanner is not evidence that anything calls one.
 *
 * Without this the guard passes for free: `@/lib/upload/ingest` contains
 * calls to `scanUploadedBuffer` by construction, so every module that so
 * much as imports the pipeline "reaches a scan" two hops later whether or
 * not it invokes anything. Derived from the same name list rather than
 * spelled as a path exclusion, so a scanner that moves house stays covered.
 */
const SCANNER_DEFINITION = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const)\\s+(?:${SCANNERS.join('|')})\\b`,
);

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, out);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** Source with block and line comments removed. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** First-party import specifiers (`@/…` and relative), resolved to files. */
function importsOf(file: string, read: (f: string) => string): string[] {
    const src = stripComments(read(file));
    const specs = new Set<string>();
    const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.add(m[1]);

    const resolved: string[] = [];
    for (const spec of specs) {
        let base: string | null = null;
        if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
        else if (spec.startsWith('.')) base = path.resolve(path.dirname(file), spec);
        if (!base) continue;
        for (const cand of [
            `${base}.ts`,
            `${base}.tsx`,
            path.join(base, 'index.ts'),
            path.join(base, 'index.tsx'),
        ]) {
            if (fs.existsSync(cand)) {
                resolved.push(cand);
                break;
            }
        }
    }
    return resolved;
}

/** True when a scan call sits within `MAX_HOPS` module hops of `entry`. */
function reachesScan(entry: string, read: (f: string) => string): boolean {
    const seen = new Set<string>([entry]);
    let frontier = [entry];
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        for (const file of frontier) {
            const src = stripComments(read(file));
            if (SCANNER_DEFINITION.test(src)) continue;
            if (SCAN_CALL.test(src)) return true;
        }
        if (hop === MAX_HOPS) break;
        const next: string[] = [];
        for (const file of frontier) {
            for (const dep of importsOf(file, read)) {
                if (seen.has(dep)) continue;
                seen.add(dep);
                next.push(dep);
            }
        }
        frontier = next;
    }
    return false;
}

/**
 * Routes that take a file: they read `formData()` AND handle a `File`.
 *
 * The second half is load-bearing rather than belt-and-braces — the SAML
 * POST-binding callback reads `formData()` for a base64 assertion and never
 * touches a file, and an exemption list with one entry on it is a list that
 * grows.
 */
function fileAcceptingRoutes(): string[] {
    return walk(API)
        .filter((f) => path.basename(f) === 'route.ts')
        .filter((f) => {
            const src = stripComments(fs.readFileSync(f, 'utf-8'));
            return /\bformData\s*\(\s*\)/.test(src) && /\bFile\b/.test(src);
        });
}

const readFile = (f: string) => fs.readFileSync(f, 'utf-8');

describe('every file-accepting API route can reach a scanner', () => {
    const routes = fileAcceptingRoutes();

    it('finds the routes at all (the guard is not vacuously passing)', () => {
        // A move of `src/app/api`, a rename of `route.ts`, or a switch away
        // from `formData()` would leave every assertion below iterating an
        // empty array and passing forever.
        expect(routes.length).toBeGreaterThanOrEqual(7);
    });

    it.each(routes.map((r) => [path.relative(ROOT, r), r] as const))(
        '%s reaches a scan call',
        (_label, route) => {
            expect(reachesScan(route, readFile)).toBe(true);
        },
    );

    it('detects a removed scan — proved by mutation, not by assertion', () => {
        // Without this, a detector that silently matched everything would
        // report all clear forever. The avatar module's scan call is deleted
        // from an in-memory copy of the tree; its route must go red.
        const avatarRoute = routes.find((r) => r.includes('account/avatar'));
        expect(avatarRoute).toBeDefined();
        const avatarModule = path.join(SRC, 'lib/account/avatar.ts');

        const mutated = (f: string) =>
            f === avatarModule
                ? fs.readFileSync(f, 'utf-8').replace(/scanOrRefuse\s*\(/g, 'noop(')
                : fs.readFileSync(f, 'utf-8');

        expect(reachesScan(avatarRoute!, readFile)).toBe(true);
        expect(reachesScan(avatarRoute!, mutated)).toBe(false);
    });

    it('does not count a scan named only in a comment', () => {
        // The spatial importer's docblock asserted that ClamAV scanned
        // asynchronously and left the record PENDING. There is no async scan
        // worker, and the code called nothing. A guard that grepped raw text
        // would have read that docblock as compliance.
        const commentOnly = `
            /** This module calls scanUploadedBuffer() on every upload. */
            // await scanOrRefuse(buf, opts);
            export const x = 1;
        `;
        expect(SCAN_CALL.test(stripComments(commentOnly))).toBe(false);
    });

    it('does not count merely IMPORTING the pipeline as calling it', () => {
        // The other way to pass for free. `@/lib/upload/ingest` contains
        // scanner calls by construction, so a module that imports it sits two
        // hops from one without invoking anything.
        const pipeline = fs.readFileSync(path.join(SRC, 'lib/upload/ingest.ts'), 'utf-8');
        expect(SCANNER_DEFINITION.test(stripComments(pipeline))).toBe(true);
        const avScan = fs.readFileSync(path.join(SRC, 'lib/storage/av-scan.ts'), 'utf-8');
        expect(SCANNER_DEFINITION.test(stripComments(avScan))).toBe(true);
    });
});
