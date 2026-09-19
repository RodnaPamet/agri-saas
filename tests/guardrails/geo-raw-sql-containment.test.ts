/**
 * Guardrail: PostGIS `ST_*` SQL is contained in src/lib/db/geo.ts.
 *
 * `Parcel.geometry` is a Prisma `Unsupported(...)` column, so all
 * spatial reads/writes are raw SQL. Containing every `ST_*` fragment in
 * one audited file (geo.ts) keeps the spatial surface reviewable and
 * stops ad-hoc geometry SQL from scattering through usecases/repos.
 *
 * Any new geometry SQL must use the typed helpers exported from
 * `@/lib/db/geo` (geometrySql, areaHectaresSql, asGeoJsonSql, col).
 *
 * Comments/docstrings that merely *mention* ST_* are fine — they are
 * stripped before scanning so design docs can reference the functions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

const SRC_DIR = path.resolve(__dirname, '../../src');
const GEO_FILE = 'lib/db/geo.ts';
const ST_PATTERN = /\bST_[A-Za-z]/;

/** Blank out block comments (newline-preserving) and trailing/line `//` comments. */
function stripComments(src: string): string {
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    return noBlock
        .split('\n')
        .map((line) => {
            const idx = line.indexOf('//');
            // keep `https://`-style sequences (not a comment)
            if (idx >= 0 && line[idx - 1] !== ':') return line.slice(0, idx);
            return line;
        })
        .join('\n');
}

describe('Guardrail: PostGIS ST_* SQL is contained in src/lib/db/geo.ts', () => {
    it('no raw ST_* appears outside src/lib/db/geo.ts', async () => {
        const files = await glob('**/*.{ts,tsx}', { cwd: SRC_DIR, posix: true });
        const violations: string[] = [];

        for (const rel of files) {
            if (rel === GEO_FILE) continue;
            if (rel.endsWith('.d.ts')) continue;
            const code = stripComments(fs.readFileSync(path.join(SRC_DIR, rel), 'utf-8'));
            code.split('\n').forEach((line, i) => {
                if (ST_PATTERN.test(line)) {
                    violations.push(`src/${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
                }
            });
        }

        if (violations.length > 0) {
            throw new Error(
                'Raw ST_* SQL found outside src/lib/db/geo.ts. Route all PostGIS through the ' +
                'typed helpers in @/lib/db/geo (geometrySql / areaHectaresSql / asGeoJsonSql / col):\n' +
                violations.map((v) => `  ${v}`).join('\n'),
            );
        }
    });

    it('geo.ts itself contains ST_* (guards against the helper file moving or emptying)', () => {
        const content = fs.readFileSync(path.join(SRC_DIR, GEO_FILE), 'utf-8');
        expect(ST_PATTERN.test(content)).toBe(true);
    });

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // The scan above reports violations it FINDS. Nothing proved it could
    // find any: `selector-teeth` showed `stripComments` survives being
    // gutted to `''`, which blanks every file before the `ST_` test runs.
    // The containment guard then reports zero violations across the whole
    // of `src/` while raw geometry SQL scatters freely — and "scanned 900
    // files, found nothing" is byte-identical to "scanned nothing".
    //
    // The check below it cannot cover this either: it reads geo.ts with
    // `fs.readFileSync` directly, never through `stripComments`.
    //
    // Two controls, because this helper has to do two opposite things and a
    // mutation in either direction is silent. One proves real code SURVIVES
    // the strip (or detection dies); the other proves a comment is REMOVED
    // (or the documented exemption dies and design docs start failing the
    // build). Neither passes on the other's mutation.

    it('control: stripComments keeps real ST_* code', () => {
        const kept = stripComments('const q = sql`SELECT ST_Area(geometry) FROM parcel`;');
        expect(ST_PATTERN.test(kept)).toBe(true);
        // Not just "non-empty": the surviving text must still be the line,
        // so a helper that returns some other non-empty constant is caught.
        expect(kept).toContain('ST_Area');
    });

    it('control: stripComments removes ST_* that is only mentioned in a comment', () => {
        // Both comment shapes the helper claims to handle, plus the
        // `https://` carve-out it documents.
        const line = stripComments('// mentions ST_Area in prose');
        const block = stripComments('/* mentions ST_Area in prose */');
        expect(ST_PATTERN.test(line)).toBe(false);
        expect(ST_PATTERN.test(block)).toBe(false);
        // The `https://` carve-out, asserted as it BEHAVES rather than as I
        // first assumed. `indexOf('//')` finds the one inside the URL, whose
        // preceding character is ':', so the whole line is kept — including a
        // real trailing comment after it.
        //
        // That is a limitation, not a hole, and the direction matters: the
        // line is over-scanned, so an `ST_` mentioned after a URL would be
        // reported as a violation rather than missed. A containment guard
        // that occasionally over-reports is safe; one that under-reports is
        // the thing this file exists to prevent. Pinned so the trade-off is
        // recorded rather than rediscovered, and so a future rewrite that
        // flips it to under-reporting fails here.
        const url = stripComments('const doc = "https://example.com"; // ST_Area');
        expect(url).toContain('https://example.com');
        expect(ST_PATTERN.test(url)).toBe(true);
    });
});
