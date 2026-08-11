/**
 * The Bulgaria lon/lat transform lives in ONE place.
 *
 * `src/lib/geo/bg-projection.ts` owns it. Before that it was inline in
 * `ExchangeMap`, and a second consumer (the parcel-overview map) was
 * about to copy it. Two copies of a projection drift, and the symptom
 * is not a crash or a type error — it is a marker drawn in the wrong
 * field, which a farmer reads as BAD DATA rather than as a bug. Nothing
 * in the type system or the test suite would go red.
 *
 * So the invariant is structural: no file outside the projection module
 * may re-implement the arithmetic.
 *
 * This is a SOURCE-TEXT guard (CLAUDE.md, "Green is not the same as
 * executed"). It proves the formula appears in one file and nowhere
 * else; it never runs the arithmetic and contributes zero runtime
 * coverage. The correctness of the projection itself — including the
 * six values pinned from the pre-extraction inline code — is proven by
 * `tests/unit/geo/bg-projection.test.ts`, which executes it. Neither
 * test substitutes for the other.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const OWNER = path.join(SRC, 'lib/geo/bg-projection.ts');

/**
 * The projection's distinguishing arithmetic. Matching on `proj.minX`
 * and `proj.maxY` together with an offset term is specific enough that
 * ordinary code cannot trip it by accident, and general enough that a
 * copy-paste with renamed locals still matches — whitespace and the
 * variable holding the proj object are both allowed to vary.
 */
const LON_TRANSFORM = /\.ox\s*\+\s*\(\s*\w+\s*-\s*\w+\.minX\s*\)/;
const LAT_TRANSFORM = /\.oy\s*\+\s*\(\s*\w+\.maxY\s*-\s*\w+\s*\)/;

function walk(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, acc);
        } else if (/\.tsx?$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

describe('bg-projection is the single source of the lon/lat transform', () => {
    const files = walk(SRC);

    it('scans a real population (the walker still works)', () => {
        // A broken walker would make every assertion below vacuous —
        // the classic way a structural guard rots into decoration.
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain(OWNER);
    });

    it('the owner module still CONTAINS the transform', () => {
        // Guards against the file being emptied or the formula moving
        // out from under the guard, which would make the "nobody else
        // has it" assertion trivially true.
        const src = fs.readFileSync(OWNER, 'utf8');
        expect(LON_TRANSFORM.test(src)).toBe(true);
        expect(LAT_TRANSFORM.test(src)).toBe(true);
    });

    it('no other file re-inlines it', () => {
        const offenders = files
            .filter((f) => f !== OWNER)
            .filter((f) => {
                const src = fs.readFileSync(f, 'utf8');
                return LON_TRANSFORM.test(src) || LAT_TRANSFORM.test(src);
            })
            .map((f) => path.relative(ROOT, f));

        expect(offenders).toEqual([]);
    });

    it('ExchangeMap consumes the shared projector', () => {
        // The original owner of the inline copy. If this import ever
        // disappears, the formula has probably come back.
        const src = fs.readFileSync(path.join(SRC, 'components/exchange/ExchangeMap.tsx'), 'utf8');
        expect(src).toMatch(/from '@\/lib\/geo\/bg-projection'/);
        expect(src).toMatch(/makeProjector\(/);
    });

    it.each([
        ['inline lon copy', 'const x = proj.ox + (lon - proj.minX) * proj.cos * proj.s;'],
        ['renamed locals', 'const a = p.ox + (longitude - p.minX) * p.cos * p.s;'],
        ['inline lat copy', 'const y = proj.oy + (proj.maxY - lat) * proj.s;'],
    ])('the detector fires on a %s (mutation proof)', (_label, planted) => {
        // A guard that only ever passes is indistinguishable from one
        // that cannot fail. Plant the violation, watch it match.
        expect(LON_TRANSFORM.test(planted) || LAT_TRANSFORM.test(planted)).toBe(true);
    });

    it.each([
        ['an unrelated offset', 'const x = box.ox + (a - b.minY) * s;'],
        ['a similar-looking sum', 'const total = acc.ox + (count - other.max) * rate;'],
    ])('the detector does NOT fire on %s (false-positive proof)', (_label, benign) => {
        // A detector broad enough to catch everything catches nothing
        // useful — it just gets exempted away by the next contributor.
        expect(LON_TRANSFORM.test(benign) || LAT_TRANSFORM.test(benign)).toBe(false);
    });
});
