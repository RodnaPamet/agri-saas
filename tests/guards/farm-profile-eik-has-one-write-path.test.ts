/**
 * `FarmProfile.eik` is written by the staff verification path and nowhere else.
 *
 * ── the bypass this exists to keep closed (#1352) ──
 *
 * P3.4 built a careful mechanism for this one field: a blind index under its
 * own HKDF info, a PARTIAL unique index on `(eikHash) WHERE status =
 * 'VERIFIED'` enforced by the database because an RLS-scoped pre-check is
 * structurally blind, and a PENDING → VERIFIED transition only platform staff
 * can make. Its schema header states that `FarmProfile.eik` "is written ONLY
 * from a VERIFIED claim… so this table is the sole gate on that field."
 *
 * It was not the sole gate. `'eik'` sat in `PROFILE_FIELDS` — "the editable
 * string fields" — so any tenant ADMIN could set their own ЕИК through the
 * profile form with no claim, no review and no checksum. That number is
 * rendered into the ДНЕВНИК PDF and the БАБХ register export: documents filed
 * with a regulator.
 *
 * The removal is one line. This guard is the part that keeps it removed,
 * because the field is in a list of eleven siblings that all belong there and
 * the twelfth will look like an omission to whoever reads it next.
 *
 * ── what this does NOT assert, deliberately ──
 *
 * `egn` is expected to stay editable and this guard says nothing about it. It
 * is the farmer's own personal identity number on their own profile, it has no
 * claim mechanism and needs none, and a self-declared ЕГН asserts nothing
 * about a third party the way a company number does. A guard that swept both
 * would be making a privacy argument it cannot support.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectTrackedFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/**
 * The braced block that opens after `from`, to its MATCHING close brace.
 *
 * A bound the source supplies, so a comment added inside the block cannot push
 * the thing being asserted out of range. `error-codes-are-documented` and
 * `error-params-carry-no-pii` both reached this conclusion from their own
 * broken character windows; this is the same fix for a brace rather than a
 * paren. Caller passes text that has been through `blankNonCode`, so a brace
 * inside a comment or a string cannot be counted.
 */
function blockAfter(src: string, from: number): string {
    const open = src.indexOf('{', from);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    return src.slice(open);
}

const ROOT = path.resolve(__dirname, '../..');

/** The one module allowed to write it, because it owns the verification. */
const OWNER = 'src/app-layer/usecases/farm-identity-review.ts';

describe('FarmProfile.eik has exactly one write path', () => {
    const files = collectTrackedFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 500,
    });

    it('derives its population from git, and it is not empty', () => {
        // An empty selection PASSES every assertion below.
        expect(files.length).toBeGreaterThan(500);
    });

    it('the WRITE list excludes `eik` while the READ shape keeps it', () => {
        // Both halves, because this is where my first attempt went wrong.
        // `PROFILE_FIELDS` defines the READ shape AND used to define the
        // write list; removing the field from it stopped tenant writes and
        // also stopped the farm SEEING its own verified number. So the lists
        // are now separate and this asserts the separation, not an absence.
        const src = blankNonCode(
            fs.readFileSync(path.join(ROOT, 'src/app-layer/usecases/farm-profile.ts'), 'utf8'),
        );

        // The write list is derived by filtering the field out — assert the
        // filter, which is the mechanism, rather than the resulting absence.
        expect(src).toMatch(/EDITABLE_PROFILE_FIELDS\s*=\s*PROFILE_FIELDS\.filter/);
        expect(src).toMatch(/!==\s*'eik'/);

        // Both write sites use the EDITABLE list. A site still iterating
        // PROFILE_FIELDS would write the field again.
        expect(src).toMatch(/for \(const k of EDITABLE_PROFILE_FIELDS\)/);
        expect(src).toMatch(/EDITABLE_PROFILE_FIELDS\.reduce/);

        // And the read shape still carries it, so the farm can see it.
        expect(src).toMatch(/'producerName'/);
        expect(src).toMatch(/'egn'/);
    });

    it('a PUT that CHANGES `eik` is refused, not silently stripped', () => {
        // The property stays in the request contract — removing a published
        // one is a breaking change and that gate has no waiver — so the
        // refusal is explicit here. Silence would look to a client exactly
        // like a successful write of a regulator-facing number.
        const src = blankNonCode(
            fs.readFileSync(path.join(ROOT, 'src/app-layer/usecases/farm-profile.ts'), 'utf8'),
        );
        // The window is the `if (said('eik')) { … }` BLOCK, taken to its
        // matching close brace — not a character count.
        //
        // It was `[\s\S]{0,600}?` and 600 was not enough as of #1645, which
        // added four comment lines explaining why the refusal is coded. That is
        // the third time a character window has broken in this repo for the
        // same reason, and `error-codes-are-documented` records the second with
        // its conclusion: raising the constant fixes today's comment and leaves
        // the next one to break it again, so the bound comes from the source.
        //
        // Worth noting what the OLD pattern did on the same diff, because it is
        // the more interesting half: against the RAW file it still matched, 541
        // characters in — on the word `FARM_PROFILE_EIK_NOT_EDITABLE` inside
        // the new comment. `blankNonCode` is the only reason this went red
        // rather than silently grading a comment. A scar is not a wound.
        const i = src.indexOf("said('eik')");
        expect(i).toBeGreaterThan(-1);
        expect(blockAfter(src, i)).toContain('FARM_PROFILE_EIK_NOT_EDITABLE');
    });

    it('…and an UNCHANGED `eik` is a no-op, not a refusal', () => {
        // This is the half that matters for real clients, and the half my
        // first version got wrong. The iOS editor PUTs all thirteen fields on
        // every save — the usecase's own docblock says so — so refusing the
        // KEY would have 400'd every farm-profile save from the owner's phone
        // with the number unchanged. The comparison is the fix, so assert the
        // comparison exists rather than just the throw.
        const src = blankNonCode(
            fs.readFileSync(path.join(ROOT, 'src/app-layer/usecases/farm-profile.ts'), 'utf8'),
        );
        expect(src).toMatch(/norm\(input\.eik\)\s*!==/);
        // It must compare against the STORED value, not against a constant.
        expect(src).toMatch(/held\?\.eik/);
    });

    it('no module outside the verification usecase writes the field', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            const rel = path.relative(ROOT, abs);
            if (rel === OWNER) continue;
            const code = blankNonCode(fs.readFileSync(abs, 'utf8'));
            // A `farmProfile.update`/`upsert`/`create` whose data mentions
            // `eik`. Deliberately a windowed match rather than a bare `eik:` match:
            // `eik` appears legitimately all over the codebase (validation,
            // the public check route, the claim model) and only a write to
            // THIS model matters.
            if (/farmProfile\s*\.\s*(update|upsert|create|updateMany)\s*\([\s\S]{0,400}?\beik\b/.test(code)) {
                offenders.push(rel);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('…and the verification usecase DOES write it', () => {
        // The control for the assertion above. A needle that matched nothing
        // would make it pass forever, and the removal of the free-edit path is
        // only safe because a legitimate path replaced it — a guard proving
        // "nobody writes this field" would be proving the feature is broken.
        const code = blankNonCode(fs.readFileSync(path.join(ROOT, OWNER), 'utf8'));
        expect(code).toMatch(
            /farmProfile\s*\.\s*upsert\s*\([\s\S]{0,400}?\beik\b/,
        );
    });

    it('CONTROL: the needle matches a real write and not a mention', () => {
        const write = 'await tx.farmProfile.upsert({ where: { tenantId }, update: { eik } });';
        const mention = 'const valid = isValidEik(eik); // farmProfile is untouched';
        const RE = /farmProfile\s*\.\s*(update|upsert|create|updateMany)\s*\([\s\S]{0,400}?\beik\b/;
        expect(RE.test(write)).toBe(true);
        expect(RE.test(mention)).toBe(false);
    });
});
