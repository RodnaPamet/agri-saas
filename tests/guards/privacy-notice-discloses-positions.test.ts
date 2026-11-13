/**
 * The privacy notice must disclose machinery POSITION tracking — #3024.
 *
 * #2969 settled the Art 15 half: the export declares the trace it does not
 * return. This is Art 13 — what a person must be told WITHOUT asking — and the
 * notice said nothing at all: measured 2026-11-13, zero of the 30 `privacy.*`
 * keys mentioned a position, a tracker or a machine's location.
 *
 * #2948 §6's `tracked-machines` endpoint tells the OPERATOR, inside the app,
 * which machines are tracked. That is the right control for the person driving
 * and it is not a privacy notice: it sits behind a session, is scoped to one
 * farm, and is reachable only by somebody who already knows to look.
 *
 * ## Why this guard rather than trusting the paragraph to stay
 *
 * It is `privacy-notice-discloses-telemetry`'s shape, for its reasons, plus one
 * this subject adds.
 *
 *   · THE PARAGRAPH could be deleted, or land in one locale. `bg` is the one
 *     that matters most: `resolveRecipientLocale` falls back to it and four of
 *     five users carry `uiLanguage: 'bg'`.
 *   · THE RETENTION could be written as a literal. Then
 *     `RAW_POSITION_RETENTION_DAYS` moves and the notice keeps promising the
 *     old number — and the drift direction is always the bad one, a notice
 *     promising a shorter life than the data actually gets.
 *   · WHOSE RECORD IT IS could be dropped, and that is specific to this
 *     disclosure. `MachinePosition` carries no person column, so a farm can
 *     truthfully say the data is about a machine; it still shows where a person
 *     was if they were on it. A notice that omitted that would be accurate and
 *     misleading, which is the failure #2969 spent two rounds on.
 */
import fs from 'node:fs';
import path from 'node:path';

import { RAW_POSITION_RETENTION_DAYS } from '@/lib/machines/fleet-view';

import { blankNonCode } from '../helpers/blank-non-code';
import { readCatalogue, locales } from '../helpers/catalogue';

const ROOT = path.resolve(__dirname, '../..');
const PAGE = path.join(ROOT, 'src/app/privacy/page.tsx');

type Catalogue = Record<string, Record<string, string>>;
const privacyOf = (loc: string, read = readCatalogue) =>
    ((read(loc) as unknown as Catalogue).privacy ?? {}) as Record<string, string>;

/**
 * Locales missing either paragraph.
 *
 * `read` is a parameter defaulted to the real reader, so the control below can
 * hand it a gutted catalogue. The LOCALE LIST is never synthesised: a control
 * that supplied its own list would keep passing with `locales()` emptied, which
 * is the failure the pair exists to catch.
 */
export function localesMissingPositionDisclosure(
    read: (loc: string) => unknown = readCatalogue,
): string[] {
    return locales().filter((loc) => {
        const p = privacyOf(loc, read as typeof readCatalogue);
        return typeof p.collectPositions !== 'string' || typeof p.keepPositions !== 'string';
    });
}

/** Does the page list the paragraph and pass the constant? */
export function pagePositionWiring(src: string): { lists: boolean; interpolates: boolean } {
    const code = blankNonCode(src, { strings: false });
    return {
        lists: /'collectPositions'/.test(code),
        interpolates: /positionDays:\s*RAW_POSITION_RETENTION_DAYS/.test(code),
    };
}

describe('the privacy notice discloses machinery position tracking (#3024)', () => {
    const page = fs.readFileSync(PAGE, 'utf8');

    it('every locale carries both paragraphs', () => {
        const all = locales();
        console.log(
            `[privacy-positions] locales=${all.length} `
                + `missing=${localesMissingPositionDisclosure().length} `
                + `retention=${RAW_POSITION_RETENTION_DAYS}d`,
        );
        // A floor: an empty locale list satisfies the assertion below over
        // nothing at all.
        expect(all.length).toBeGreaterThanOrEqual(2);
        expect(localesMissingPositionDisclosure()).toEqual([]);
    });

    it('the page renders it and interpolates the retention', () => {
        const { lists, interpolates } = pagePositionWiring(page);
        expect(lists).toBe(true);
        expect(interpolates).toBe(true);
    });

    it('no locale hard-codes the number of days', () => {
        const offenders = locales().filter((loc) => {
            const keep = privacyOf(loc).keepPositions ?? '';
            return (
                !keep.includes('{positionDays}')
                || new RegExp(`\\b${RAW_POSITION_RETENTION_DAYS}\\b`).test(keep)
            );
        });
        expect(offenders).toEqual([]);
    });

    it('says the record is about the MACHINE and still shows where a person was', () => {
        /*
         * The half a driver cannot infer. Both locales must carry the word for
         * the machine AND an acknowledgement about the person — in Bulgarian
         * «Вас»/«сте били», in English "you".
         *
         * NO `\b` around the Cyrillic: JavaScript's word boundary is ASCII
         * only, so `/\bВас\b/` never matches. The sibling guard records the
         * same trap and the direction that makes it dangerous — in a NEGATED
         * assertion it passes silently over Cyrillic; here the expectation is
         * positive, so a mistake fails loudly.
         */
        for (const loc of locales()) {
            const text = privacyOf(loc).collectPositions ?? '';
            expect(text.length).toBeGreaterThan(120);
            expect(/machine|МАШИНАТА|машин/i.test(text)).toBe(true);
            /*
             * THE PERSON'S LOCATION, not merely the word "you" — measured,
             * because the looser version survived its own mutation. Replacing
             * "the record belongs to the MACHINE rather than to you — but if
             * you were on it, it shows where you were" with bland fleet-
             * management prose left `/\byou\b/` matching the NEXT sentence
             * ("the farm is required to tell you which of its machines are
             * tracked"), so the assertion passed over a paragraph that no
             * longer made the disclosure.
             *
             * The claim is specifically that the machine's record reveals where
             * the PERSON was. Anchored on that, the same mutation reddens.
             */
            expect(/where you were|къде сте били/i.test(text)).toBe(true);
        }
    });

    it('says what SURVIVES the deletion, not only that tracks are deleted', () => {
        // A reader told only "raw tracks are deleted after 30 days" would
        // reasonably conclude nothing is kept. The derived worked-parcel record
        // IS kept, and #2969's narrowed ruling is that it is the farm's own
        // production record — so the notice has to name it.
        for (const loc of locales()) {
            const text = privacyOf(loc).keepPositions ?? '';
            expect(/parcel|парцел/i.test(text)).toBe(true);
        }
    });

    it('the missing-locale selector can SELECT — the control', () => {
        /*
         * `toEqual([])` is satisfied perfectly by a selector that always
         * returns nothing. So it is shown to select on the REAL locale list
         * with the key stripped from the REAL catalogue, never a synthesised
         * one.
         */
        const gutted = (loc: string) => {
            const real = JSON.parse(JSON.stringify(readCatalogue(loc))) as Record<
                string,
                Record<string, unknown>
            >;
            delete real.privacy.collectPositions;
            return real;
        };
        expect(localesMissingPositionDisclosure(gutted).sort()).toEqual(locales().sort());
    });
});
