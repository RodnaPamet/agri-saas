/**
 * A parcel read ordered by name carries an id tiebreak (#1742).
 *
 * ## The rule, and why it is contractual rather than cosmetic
 *
 * `ParcelRepository.listSummariesByIds` writes it down:
 *
 * > `ORDER BY "name", "id"` is contractual, not cosmetic (#1391): a client
 * > renders a legend keyed on name, so an unstable order reshuffles it between
 * > loads, and parcel names are not unique — the id breaks ties so the order is
 * > total rather than merely mostly-stable.
 *
 * Two sibling reads did not follow it. Postgres gives no stability guarantee
 * for rows that tie, so a farm with two parcels called «1» could get them in
 * either order on consecutive reads.
 *
 * ## Why a guard and not just the two fixes
 *
 * #1742 asked for exactly this: *"if there is a third, it should be found by
 * grep rather than by the next person hitting it."* The rule was written down
 * in one place and followed in another, which is the condition under which a
 * third instance is written by someone who read the wrong one.
 *
 * It also catches the shape that made this more than cosmetic. One of the two
 * sites capped at `take: 5000`: with a non-total order, WHICH rows come back
 * is unstable, so a parcel near the cap can be present in one read and absent
 * in the next with nothing changed — the same defect as a paginated list with
 * a non-total ordering.
 *
 * ## What it does NOT claim
 *
 * Reads with no `orderBy` at all are out of scope and deliberately so. Several
 * exist and are correct: `smart-defaults` selects only `id` and feeds it to an
 * `in` filter, and `ParcelRepository.areaHaFor` reads one row by primary key.
 * Ordering is meaningless where nothing consumes a sequence, and demanding it
 * everywhere would be a rule nobody could follow honestly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function tsFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root missing: ${dir} — a renamed root would scan zero files and pass`);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) tsFiles(full, acc);
        else if (e.name.endsWith('.ts')) acc.push(full);
    }
    return acc;
}

/**
 * Every `parcel.findMany({...})` call, with the window that follows it.
 *
 * Comments blanked first: both sites now DISCUSS the `name, id` rule at
 * length directly above the query, and a scan that read prose would find the
 * words "id" in an explanation and call the query compliant. A scar is not a
 * wound.
 */
interface ParcelRead {
    file: string;
    line: number;
    orderBy: string | null;
}

/**
 * The call's own extent, by BRACE MATCHING rather than a fixed window.
 *
 * My first version read a 900-character slice after the match, and it missed
 * one of the two sites this guard was written for. `blankNonCode` replaces a
 * comment with SPACES character-for-character — so the nine-line paragraph I
 * had just added inside `parcel-lease.ts` explaining the `name, id` rule
 * pushed its own `orderBy` past the window.
 *
 * A window sized to the code it was written against is the
 * narrow-enough-to-always-pass shape: it would have reported that file as
 * having no ordering at all, which the "offenders" filter treats as out of
 * scope — so the guard would have gone quiet on exactly the site it exists
 * for, and nothing would have failed.
 */
function callExtent(code: string, start: number): string {
    const open = code.indexOf('{', start);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return code.slice(start, i + 1);
        }
    }
    return code.slice(start); // unbalanced — give the caller everything
}

function parcelReads(): ParcelRead[] {
    const out: ParcelRead[] = [];
    for (const file of tsFiles(SRC)) {
        const code = blankNonCode(fs.readFileSync(file, 'utf8'));
        const re = /\.parcel\.findMany\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            const extent = callExtent(code, m.index);
            const ob = /orderBy:\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/.exec(extent);
            out.push({
                file: path.relative(ROOT, file),
                line: code.slice(0, m.index).split('\n').length,
                orderBy: ob ? ob[1].replace(/\s+/g, ' ') : null,
            });
        }
    }
    return out;
}

describe('a parcel read ordered by name is ordered totally', () => {
    const reads = parcelReads();

    it('finds a real population, and the known sites among it', () => {
        // The denominator, printed rather than assumed. A regex that stopped
        // matching would make every assertion below vacuously true.
        expect(reads.length).toBeGreaterThanOrEqual(10);
        const files = reads.map((r) => r.file);
        expect(files).toContain('src/app-layer/usecases/parcel-lease.ts');
        expect(files).toContain('src/app-layer/reports/pdf/farm-record-diary.ts');
    });

    it('every name-ordered read breaks ties on id', () => {
        const offenders = reads
            .filter((r) => r.orderBy !== null && /name:\s*'asc'|name:\s*'desc'/.test(r.orderBy))
            .filter((r) => !/\bid:\s*'(asc|desc)'/.test(r.orderBy!));

        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} parcel read(s) order by name with no id tiebreak:\n  ` +
                    offenders.map((o) => `${o.file}:${o.line}  orderBy=${o.orderBy}`).join('\n  ') +
                    `\n\nParcel names are NOT unique and Postgres does not order ties, so the ` +
                    `sequence is unstable between reads. Where the query also carries a ` +
                    `\`take\`, WHICH rows come back is unstable too. Add \`{ id: 'asc' }\` — ` +
                    `the rule is documented on ParcelRepository.listSummariesByIds (#1391, #1742).`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('at least one read IS name-ordered, so the rule has subjects', () => {
        // Without this, deleting every `orderBy: name` in the codebase would
        // make the assertion above pass by having nothing to check — the
        // emptied-window failure mode.
        const nameOrdered = reads.filter(
            (r) => r.orderBy !== null && /name:\s*'(asc|desc)'/.test(r.orderBy),
        );
        expect(nameOrdered.length).toBeGreaterThanOrEqual(2);
    });

    it('the extraction reaches an orderBy behind a long comment', () => {
        // The bug my first version had, as a fixture. `blankNonCode` keeps a
        // comment's LENGTH, so prose inside the call pushes later keys
        // arbitrarily far from the match. Brace matching has no window to
        // outgrow.
        const padded = [
            'const x = await db.parcel.findMany({',
            '    where: { tenantId: t },',
            `    ${'// '.padEnd(400, 'x')}`,
            `    ${'// '.padEnd(400, 'y')}`,
            `    ${'// '.padEnd(400, 'z')}`,
            "    orderBy: [{ name: 'asc' }, { id: 'asc' }],",
            '});',
        ].join('\n');
        const code = blankNonCode(padded);
        const extent = callExtent(code, code.indexOf('.parcel.findMany('));

        expect(/orderBy/.test(extent)).toBe(true);
        expect(/\bid:\s*'asc'/.test(extent)).toBe(true);
        // And it stops at the call, so a LATER query's ordering cannot be
        // mistaken for this one's — the failure mode a bigger window would
        // have traded for the one it fixed.
        const two = `${padded}\nconst y = await db.parcel.findMany({ orderBy: [{ id: 'asc' }] });`;
        const firstExtent = callExtent(blankNonCode(two), two.indexOf('.parcel.findMany('));
        // ONE occurrence — its own. The extent starts AT the match, so it
        // always contains the marker once; two would mean it had run past
        // this call into the next, which is the failure mode a bigger window
        // would have traded for the one it fixed.
        expect(firstExtent.split('.parcel.findMany(').length - 1).toBe(1);
        // And it must not have swallowed the second query's ordering.
        expect(firstExtent).not.toContain("orderBy: [{ id: 'asc' }] }");
    });

    it('the detector discriminates — mutation proof on the regexes', () => {
        // In-memory, because the fixes are already applied on disk and a
        // scanner that matched everything (or nothing) would look identical
        // to a compliant codebase.
        const compliant = "orderBy: [{ name: 'asc' }, { id: 'asc' }]";
        const broken = "orderBy: [{ name: 'asc' }]";
        const nameRe = /name:\s*'(asc|desc)'/;
        const idRe = /\bid:\s*'(asc|desc)'/;

        expect(nameRe.test(compliant)).toBe(true);
        expect(idRe.test(compliant)).toBe(true);
        expect(nameRe.test(broken)).toBe(true);
        expect(idRe.test(broken)).toBe(false);
        // A different field's id must not satisfy it by accident.
        expect(idRe.test("orderBy: [{ name: 'asc' }, { locationId: 'asc' }]")).toBe(false);
    });

    it('prose about the rule does not satisfy it', () => {
        // Both fixed sites carry a paragraph explaining `name, id`. If the
        // scan read comments, deleting the tiebreak would leave the
        // explanation behind and the guard would still pass — which is how a
        // comment-reading scan certifies the exact defect it was written for.
        const withProse = [
            "// ORDER BY name, id is contractual: the id: 'asc' breaks ties.",
            "orderBy: [{ name: 'asc' }],",
        ].join('\n');
        const stripped = blankNonCode(withProse);

        expect(/\bid:\s*'(asc|desc)'/.test(withProse)).toBe(true);
        expect(/\bid:\s*'(asc|desc)'/.test(stripped)).toBe(false);
    });
});
