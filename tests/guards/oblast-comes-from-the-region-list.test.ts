/**
 * An oblast is one of 28 names, and the two representations never cross — #2068.
 *
 * ## The defect
 *
 * `FarmBrand.oblast` was free text in the web editor (`<Input value={oblast}>`)
 * while the iOS client wrote one of the 28 `BULGARIA_REGIONS` names. So two
 * farms in the same oblast could hold different values for it depending on which
 * client their owner used, and a farm spelled unusually is silently absent from
 * the browse filter's list — a failure that looks exactly like "no farms there
 * yet" to both the visitor and the farmer. #1909 made the filter
 * case-insensitive, which is the cheap half; this is the write end.
 *
 * ## Two representations, identical labels, and that is the trap
 *
 *   - **ISO code** (`BG-08`) — the exchange. `BULGARIA_REGION_OPTIONS`.
 *   - **Bulgarian name** (`Добрич`) — the public farm profile.
 *     `BULGARIA_REGION_NAME_OPTIONS`.
 *
 * Their `label`s are byte-identical and only `value` differs, so a call site
 * that reaches for the wrong one looks correct in review. #2068's own suggested
 * fix says "a select over `BULGARIA_REGION_OPTIONS`" — following it verbatim
 * would store `BG-08` into a column every reader treats as a name, which is
 * WORSE than the free text it replaced: free text at least sometimes matched.
 * That is why this guard asserts the pairing rather than merely asserting that
 * some region list is used.
 *
 * ## What it cannot do
 *
 * It reads source text, so it proves the editor is WIRED to the list, not that
 * a farmer cannot store free text — a non-UI client still can, knowingly
 * (owner ruling: normalise, never reject, because a `z.enum` would fail a
 * shipped iOS build's write — #1087). The canonicaliser's behaviour is executed
 * in `tests/unit/bulgaria-regions.test.ts`; this holds the wiring.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const codeOf = (src: string): string => blankNonCode(src);
const read = (rel: string): string => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const EDITOR = 'src/app/t/[tenantSlug]/(app)/admin/public-profile/PublicProfileClient.tsx';
const USECASE = 'src/app-layer/usecases/public-farm-profile.ts';
const EXCHANGE_FORM = 'src/app/t/[tenantSlug]/(app)/exchange/CreateOfferModal.tsx';
const EXCHANGE_FILTERS = 'src/app/t/[tenantSlug]/(app)/exchange/filter-defs.ts';

/**
 * Client files that mention an oblast but do NOT let anyone choose one, each
 * with the reason. Shrink-only: an entry is a claim that the file is read-only
 * about oblast, and a new editor landing here is the regression.
 */
const READ_ONLY: Record<string, string> = {
    'src/components/public-profile/public-farm-body.tsx':
        'Renders the public page. Displays the stored oblast and offers no control that '
        + 'sets one, so there is nothing for it to source from the list.',
    'src/app/f/[handle]/page.tsx':
        'The public page itself — reads the projection and passes it down. No form, no '
        + 'write path; it cannot introduce a spelling.',
};

describe('oblast comes from the 28-name list (#2068)', () => {
    const editor = read(EDITOR);

    it('[oblast] ranges over the files that mention an oblast', () => {
        const mentions = collectSourceFiles({ roots: ['src'] })
            .map((f) => path.relative(ROOT, f))
            .filter((rel) => /\boblast\s*[:=]/.test(read(rel)));
        console.log(
            `[oblast] ${mentions.length} file(s) mention an oblast; `
                + `${Object.keys(READ_ONLY).length} declared read-only`,
        );
        // A derivation that stopped matching would make the exemption audit
        // below pass over nothing.
        expect(mentions.length).toBeGreaterThanOrEqual(5);
        expect(mentions).toContain(EDITOR);
    });

    it('the editor sources its options from the NAME list', () => {
        expect(editor).toContain('BULGARIA_REGION_NAME_OPTIONS');
    });

    it('the editor does NOT reach for the code-valued list', () => {
        // The specific mistake #2068's suggested fix would have made. Matched
        // as a whole word so the NAME_OPTIONS import does not satisfy it.
        expect(/\bBULGARIA_REGION_OPTIONS\b/.test(editor)).toBe(false);
    });

    it('the editor renders no free-text control bound to the oblast value', () => {
        // The original defect was literally `<Input value={oblast}>`. Any
        // control taking the raw value back as text reintroduces it.
        expect(/<(Input|Textarea)[^>]*value=\{oblast\}/s.test(editor)).toBe(false);
        expect(editor).toContain('<Combobox');
    });

    it('a stored value outside the 28 is kept as an option, not dropped', () => {
        // Dropping it renders the combobox empty over a farm that HAS an
        // oblast, and the next save then writes null — destroying data by
        // opening a form. Free text was the only way in before this change,
        // so such values exist by construction.
        expect(editor).toContain('isBulgariaRegionName');
        expect(editor).toContain('oblastUnlisted');
    });

    it('the write path canonicalises the stored value', () => {
        const usecase = read(USECASE);
        expect(usecase).toContain('canonicaliseRegionName');
        // On the assignment, not merely imported somewhere in a 1,100-line file.
        expect(/data\.oblast\s*=\s*canonicaliseRegionName\(/.test(usecase)).toBe(true);
    });

    it('the exchange still uses CODES — the other half of the pairing', () => {
        // Asserted so a future "unify the region lists" change has to notice
        // that these two columns are different kinds of thing.
        const form = read(EXCHANGE_FORM);
        const filters = read(EXCHANGE_FILTERS);
        expect(form).toContain('BULGARIA_REGION_OPTIONS');
        expect(/\bBULGARIA_REGION_NAME_OPTIONS\b/.test(form)).toBe(false);
        expect(/value:\s*r\.code/.test(filters)).toBe(true);
    });

    it('every read-only entry carries a reason and still names a live file', () => {
        for (const [rel, why] of Object.entries(READ_ONLY)) {
            expect({ rel, long: why.length > 80 }).toEqual({ rel, long: true });
            // A stale entry pre-approves the path for whatever is created
            // there next — the #1285 defect.
            expect({ rel, mentionsOblast: /\boblast/.test(read(rel)) }).toEqual({
                rel,
                mentionsOblast: true,
            });
            // And must genuinely offer no control.
            expect({ rel, hasCombobox: read(rel).includes('<Combobox') }).toEqual({
                rel,
                hasCombobox: false,
            });
        }
    });

    it('CONTROL: the detectors fire on the shapes they are looking for', () => {
        // Every assertion above is a `toContain` or a negated regex, and both
        // are satisfied by a matcher aimed at nothing.
        expect(/<(Input|Textarea)[^>]*value=\{oblast\}/s.test('<Input value={oblast} />')).toBe(
            true,
        );
        expect(/\bBULGARIA_REGION_OPTIONS\b/.test('BULGARIA_REGION_NAME_OPTIONS')).toBe(false);
        expect(/\bBULGARIA_REGION_OPTIONS\b/.test('BULGARIA_REGION_OPTIONS')).toBe(true);
        expect(/data\.oblast\s*=\s*canonicaliseRegionName\(/.test('data.oblast = input.oblast;')).toBe(
            false,
        );
    });

    it('CONTROL: comments cannot satisfy any of it', () => {
        // The editor's own docblock names `BULGARIA_REGION_OPTIONS` while
        // explaining why it must NOT be used — so without blanking, the
        // "does not reach for the code list" assertion would fail on prose
        // that says exactly the right thing.
        const raw = readFileSync(path.join(ROOT, EDITOR), 'utf8');
        expect(raw).toContain('BULGARIA_REGION_OPTIONS');
        expect(/\bBULGARIA_REGION_OPTIONS\b/.test(editor)).toBe(false);
    });
});
