/**
 * Every name→slug and name→filename derivation goes through `toSlug`.
 *
 * ── the defect this exists to prevent recurring ──
 *
 * `src/lib/bg-transliterate.ts` shipped with ZERO callers while SEVEN sites
 * hand-rolled `name.toLowerCase().replace(/[^a-z0-9]+/g, '-')`. For a
 * Bulgarian product that expression does not sanitise a name — it DELETES one,
 * because every Cyrillic character is outside `[a-z0-9]`. Measured on the real
 * code before this guard existed:
 *
 *   register route      «ЗК Победа»           → `-m2x3k9`     (name gone)
 *   knowledge article   «Торене на пшеница»   → `article`     (name gone)
 *   access-review PDF   «Преглед на достъпа»  → `___`         (name gone)
 *   share card          any Cyrillic label    → `card.png`    (name gone)
 *   process export      any Cyrillic map name → `process-map` (name gone)
 *
 * The failure is quiet in the worst way: each site has a sensible-looking
 * fallback, so nothing errors and nothing looks broken in a Latin-named test.
 * It only shows up as a farmer with three different process maps that all
 * download as `process-map.pdf` and overwrite each other.
 *
 * ── why a guard and not just the fix ──
 *
 * Seven independent sites grew this same expression over time, and the eighth
 * would too — one of them even carried a comment claiming it "mirrors
 * policy.ts", a file that no longer exists. A fix converges today's sites; the
 * guard is what makes `toSlug` the only definition tomorrow.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectTrackedFiles } from '../helpers/collect-files';
import { stripComments } from '../helpers/strip-comments';
import { toSlug } from '@/lib/bg-transliterate';

const ROOT = path.resolve(__dirname, '../..');

/** The one module allowed to spell the strip, because it owns it. */
const OWNER = 'src/lib/bg-transliterate.ts';

/**
 * A `.replace()` deleting a negated ASCII-alphanumeric class.
 *
 * Deliberately NOT matching `[^0-9]` or `[^0-9.]`: those are numeric-input
 * sanitisers on number fields (`setRowsPerBed`, `price-parse`), where dropping
 * a Cyrillic letter is the correct behaviour and there is no name to preserve.
 * Banning them would be a guard aimed one level off its subject — it would
 * redden 18 correct call sites and teach the next reader to add an allowlist
 * entry rather than think.
 */
// Requires a LETTER range (`a-z`, `A-Z`) inside the negated class. That is
// exactly what separates "delete the name" from "keep only digits": a class
// naming letters to exclude destroys Cyrillic, a class of only digits is a
// numeric field sanitiser. My first attempt here was
// `[aA]-[zZ]?[a-zA-Z]*0-9`, which could not match `[^A-Za-z0-9]` at all
// because `-` is not in `[a-zA-Z]` — the structural assertion was green
// against a needle blind to a third of its targets, and only the control
// below caught it.
const STRIP = /\.replace\(\s*\/\[\^[^\]]*[a-zA-Z]-[a-zA-Z][^\]]*\]/;

describe('slug derivation is converged on toSlug', () => {
    // `floor` is the helper's own refuse-empty check. It is restated as an
    // assertion below as well, deliberately: a floor inside a helper protects
    // the HELPER, and gutting the one-line call here would skip it entirely.
    const files = collectTrackedFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 500,
    });

    it('derives its population from git, and that population is not empty', () => {
        // An empty selection PASSES every assertion below. This is what makes
        // the rest of the file mean anything.
        expect(files.length).toBeGreaterThan(500);
    });

    it('no module outside bg-transliterate.ts strips a name to ASCII', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            // `collectTrackedFiles` returns ABSOLUTE paths; the ban list and
            // the offender report are both repo-relative.
            const rel = path.relative(ROOT, abs);
            if (rel === OWNER) continue;
            const code = stripComments(fs.readFileSync(abs, 'utf8'));
            for (const [i, line] of code.split('\n').entries()) {
                if (STRIP.test(line)) offenders.push(`${rel}:${i + 1}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('CONTROL: the stripper does not simply return nothing', () => {
        // Without this, a stripComments that returned '' would make the
        // assertion above pass forever. Five of the converged sites now carry
        // the banned pattern in a COMMENT explaining why it was removed, so
        // this guard genuinely depends on comment-stripping being real — and
        // on it not being too eager.
        const sample = `/* .replace(/[^a-z0-9]+/g, '-') in a block comment */
// .replace(/[^a-z0-9]+/g, '-') in a line comment
const kept = 'https://example.test';`;
        const out = stripComments(sample);
        expect(out).toContain('https://example.test'); // not over-eager
        expect(STRIP.test(out)).toBe(false); // and it did strip
    });

    it('CONTROL: the pattern still matches the thing it bans', () => {
        // A regex that matches nothing is a guard that passes everything. This
        // pins the needle to the exact expression the seven sites used.
        expect(STRIP.test(`x.toLowerCase().replace(/[^a-z0-9]+/g, '-')`)).toBe(true);
        expect(STRIP.test(`name.replace(/[^a-z0-9]+/gi, '_')`)).toBe(true);
        expect(STRIP.test(`name.replace(/[^A-Za-z0-9]+/g, '-')`)).toBe(true);
        // …and does NOT match the numeric sanitisers it deliberately permits.
        expect(STRIP.test(`e.target.value.replace(/[^0-9.]/g, '')`)).toBe(false);
        expect(STRIP.test(`raw.replace(/[^0-9.,-]/g, '')`)).toBe(false);
    });

    it('toSlug keeps a Bulgarian name, which is the point of all of this', () => {
        // The guard above is structural: it proves nobody hand-rolls the strip.
        // It would stay green if `toSlug` itself dropped Cyrillic, so the
        // behaviour is pinned here too.
        expect(toSlug('ЗК Победа')).toBe('zk-pobeda');
        expect(toSlug('Торене на пшеница')).toBe('torene-na-pshenitsa');
        expect(toSlug('Преглед на достъпа')).toBe('pregled-na-dostapa');
        expect(toSlug('...')).toBeNull();
    });
});
