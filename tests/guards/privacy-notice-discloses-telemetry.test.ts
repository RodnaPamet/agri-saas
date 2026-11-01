import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { readCatalogue, locales } from '../helpers/catalogue';
import { USAGE_EVENT_RETENTION_DAYS } from '@/app-layer/telemetry/usage-events';

const ROOT = path.resolve(__dirname, '../..');
const PAGE = path.join(ROOT, 'src/app/privacy/page.tsx');

/**
 * The privacy notice must disclose usage telemetry, in every locale, with its
 * retention INTERPOLATED rather than written out.
 *
 * #493's events are Product Interaction data **linked to the account**, which
 * is what makes them personal data rather than statistics. GDPR Art 13 wants a
 * data subject informed when their data is collected, so the disclosure has to
 * exist before the first event is recorded — and the `usage.events` flag was
 * deliberately left OFF until it did (owner decision 2026-11-01, asked
 * directly: "add the notice first, then switch on").
 *
 * Two failures this is built to catch, and only the second is obvious:
 *
 *   · the paragraph is deleted or never translated, so one locale's readers
 *     are told and the other's are not;
 *   · the retention period is written as a LITERAL. Then
 *     `USAGE_EVENT_RETENTION_DAYS` can change and the notice keeps promising
 *     the old number — and the drift direction is always the bad one, a notice
 *     promising a shorter life than the data actually gets. Same reasoning as
 *     `{graceDays}` in the deletion paragraph.
 */

/**
 * Locales whose catalogue is missing either key.
 *
 * `read` is a parameter defaulted to the real reader so the control below can
 * hand it a catalogue with the keys removed. The LOCALE LIST is never
 * synthesised — a control that supplied its own list would keep passing with
 * `locales()` gutted, which is the failure this pair exists to catch.
 */
export function localesMissingDisclosure(
    read: (loc: string) => unknown = readCatalogue,
): string[] {
    return locales().filter((loc) => {
        const privacy = (read(loc) as Record<string, Record<string, string>>).privacy;
        return typeof privacy?.collectUsage !== 'string' || typeof privacy?.keepUsage !== 'string';
    });
}

/** Does the page render the paragraph and pass the constant? */
export function pageWiring(src: string): { lists: boolean; interpolates: boolean } {
    const code = blankNonCode(src, { strings: false });
    return {
        lists: /'collectUsage'/.test(code),
        interpolates: /usageDays:\s*USAGE_EVENT_RETENTION_DAYS/.test(code),
    };
}

describe('the privacy notice discloses usage telemetry (#493)', () => {
    const page = fs.readFileSync(PAGE, 'utf8');

    it('every locale carries both paragraphs', () => {
        const all = locales();
        console.log(`[privacy-telemetry] locales=${all.length} missing=${localesMissingDisclosure().length}`);
        // Floor: an empty locale list would satisfy the assertion below over
        // nothing at all.
        expect(all.length).toBeGreaterThanOrEqual(2);
        expect(localesMissingDisclosure()).toEqual([]);
    });

    it('the page renders the disclosure and interpolates the retention period', () => {
        const { lists, interpolates } = pageWiring(page);
        expect(lists).toBe(true);
        expect(interpolates).toBe(true);
    });

    it('no locale hard-codes the number of days', () => {
        // The actual failure mode: `90` written into the sentence. Then the
        // constant moves and the notice silently lies.
        const offenders = locales().filter((loc) => {
            const keep = (readCatalogue(loc) as unknown as Record<string, Record<string, string>>).privacy?.keepUsage ?? '';
            return !keep.includes('{usageDays}') || new RegExp(`\\b${USAGE_EVENT_RETENTION_DAYS}\\b`).test(keep);
        });
        expect(offenders).toEqual([]);
    });

    it('the disclosure says what is NOT collected, not only what is', () => {
        // A reader told only "we record how you use the app" reasonably assumes
        // the worse version — typed content, position, tracking. The notice has
        // to deny those explicitly or it understates by omission.
        for (const loc of locales()) {
            const text = (readCatalogue(loc) as unknown as Record<string, Record<string, string>>).privacy?.collectUsage ?? '';
            expect(text.length).toBeGreaterThan(120);
            // A negation is present in both languages' phrasing.
            //
            // NO `\b` around the Cyrillic alternatives: JavaScript's word
            // boundary is ASCII-only, so `/\bне\b/` never matches «Не
            // записваме». I wrote it that way first and this assertion failed
            // on Bulgarian — LOUDLY, because it is a positive expectation.
            //
            // Worth being precise about the direction, because the danger is
            // the other one: in a NEGATED assertion the same mistake passes
            // silently over Cyrillic and the check protects nothing. A
            // Cyrillic `\b` is never right; whether it is noisy or silent
            // depends only on which way the expectation points.
            expect(/\bnot\b|\bnever\b|(^|\s)не\s|нито|никога/i.test(text)).toBe(true);
        }
    });

    it('the missing-locale selector can SELECT — the control', () => {
        // `toEqual([])` above is satisfied perfectly by a selector that always
        // returns nothing, which is exactly what selector-teeth mutated it to.
        // So it is shown to select on the REAL locale list with the keys
        // stripped from the REAL catalogue — not from a synthesised one.
        const gutted = (loc: string) => {
            const real = JSON.parse(JSON.stringify(readCatalogue(loc))) as Record<string, Record<string, unknown>>;
            delete real.privacy.collectUsage;
            return real;
        };
        expect(localesMissingDisclosure(gutted).sort()).toEqual(locales().sort());

        // ...and only one key missing is still a miss.
        const halfGutted = (loc: string) => {
            const real = JSON.parse(JSON.stringify(readCatalogue(loc))) as Record<string, Record<string, unknown>>;
            delete real.privacy.keepUsage;
            return real;
        };
        expect(localesMissingDisclosure(halfGutted).length).toBe(locales().length);
    });

    it('the detectors discriminate', () => {
        expect(pageWiring("body: ['collectUsage']").lists).toBe(true);
        expect(pageWiring("body: ['collectFarm']").lists).toBe(false);
        expect(pageWiring('t("keepUsage", { usageDays: USAGE_EVENT_RETENTION_DAYS })').interpolates).toBe(true);
        expect(pageWiring('t("keepUsage", { usageDays: 90 })').interpolates).toBe(false);
        // A COMMENT mentioning the key is not the page rendering it.
        expect(pageWiring("// we should add 'collectUsage' one day").lists).toBe(false);
    });
});
