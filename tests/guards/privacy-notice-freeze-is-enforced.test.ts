/**
 * The privacy notice's GRACE-PERIOD claim must be backed by code (#1655).
 *
 * ## Why a second notice guard exists
 *
 * `privacy-notice-matches-erasure.test.ts` ranges over `RETAINED_MODELS` — it
 * asks whether the notice discloses what SURVIVES an erasure. That axis was
 * green the whole time the notice carried a false sentence about the 30-day
 * grace period, because a grace-period promise is not in its population. One
 * axis true, the other false, nothing red.
 *
 * `a-coverage-number-names-its-axis`: every such check ranges over one axis and
 * scores the rest zero. This is the other axis.
 *
 * ## What it checks, and why it is shaped as a BICONDITIONAL
 *
 * The drift can run either way, and only one direction is the one people worry
 * about:
 *
 *   - **notice claims, code does not enforce** — what shipped. A legal notice
 *     promising something the product does not do.
 *   - **code enforces, notice does not say** — harmless legally, but it means
 *     somebody removed the sentence and left the behaviour, so the next reader
 *     cannot tell whether the hiding is deliberate or a bug.
 *
 * So the two are required to be present together or absent together, and the
 * failure message says which direction tripped.
 */
import { readCatalogue } from '../helpers/catalogue';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The sentence fragments that constitute the invisibility CLAIM, per locale. */
const CLAIM_MARKERS: Record<string, RegExp> = {
    // "stops being visible to other farms"
    en: /stops? being visible to other farms/i,
    // „престава да бъде видим за други стопанства“
    bg: /престава да бъде видим за други стопанства/i,
};

function noticeClaimsInvisibility(locale: string): boolean {
    const messages = (readCatalogue(locale) as unknown as Record<string, Record<string, string>>);
    const text: string = messages?.privacy?.deleteRequest ?? '';
    return CLAIM_MARKERS[locale].test(text);
}

describe('the deletion-freeze claim and its enforcement move together', () => {
    const SUPPRESSION_COLUMN = 'suppressedForDeletionAt';

    it('every locale agrees on whether the claim is made', () => {
        // A claim in one language and not the other is its own defect: the two
        // notices would describe different products, and the Bulgarian one is
        // the one nearly every user reads (measured four in five on
        // `uiLanguage`).
        const made = Object.keys(CLAIM_MARKERS).map((l) => [l, noticeClaimsInvisibility(l)]);
        const distinct = new Set(made.map(([, v]) => v));
        expect({ perLocale: Object.fromEntries(made), agree: distinct.size === 1 })
            .toEqual({ perLocale: Object.fromEntries(made), agree: true });
    });

    it('a notice that claims invisibility has enforcement behind it', () => {
        const claims = noticeClaimsInvisibility('en');
        const schema = read('prisma/schema/exchange.prisma');
        const suppress = read('src/app-layer/usecases/account-erasure.ts');
        const browse = read('src/app-layer/repositories/exchange.ts');

        const enforced =
            schema.includes(SUPPRESSION_COLUMN) &&
            suppress.includes(SUPPRESSION_COLUMN) &&
            browse.includes(SUPPRESSION_COLUMN);

        expect({ claims, enforced }).toEqual({ claims, enforced: claims });
    });

    it('the SUPPRESSION is restorable — a restore path exists', () => {
        // Without this the "enforced" check above is satisfied by a one-way
        // hide, which would be worse than the bug: a person who cancels would
        // silently lose their listings for ever.
        const src = read('src/app-layer/usecases/account-erasure.ts');

        expect(src).toMatch(/restoreListingsAfterCancel/);
        // Keyed on the COLUMN, not on `status` — restoring by status resurrects
        // listings the seller had withdrawn themselves.
        const restore = src.slice(src.indexOf('async function restoreListingsAfterCancel'));
        expect(restore.slice(0, 600)).toContain(`${SUPPRESSION_COLUMN}: { not: null }`);
    });

    it('the DEEP LINK and the thread-open path honour it, not just the feed', () => {
        // A hide that only covers the browse list is defeated by sharing a URL.
        // Both of these had no such filter before #1655 — `openExchangeThread`
        // filtered on `id` alone.
        expect(read('src/app-layer/usecases/exchange.ts')).toContain(SUPPRESSION_COLUMN);
        expect(read('src/app-layer/usecases/exchange-messaging.ts'))
            .toContain(SUPPRESSION_COLUMN);
    });

    it("the person's OWN management view is deliberately NOT filtered", () => {
        // They can still sign in to cancel, and hiding their listings from
        // themselves reads as "already deleted" at the moment they are deciding
        // whether to recover. Pinned as an ABSENCE so a well-meaning "filter it
        // everywhere" change has to argue with this test.
        const src = read('src/app-layer/repositories/exchange.ts');
        const fnStart = src.indexOf('static async listListingsBySeller');
        expect(fnStart).toBeGreaterThan(-1);
        const body = src.slice(fnStart, src.indexOf('static async', fnStart + 10));
        expect(body).not.toContain(SUPPRESSION_COLUMN);
    });

    it('the escape hatch is exempt from the mutation freeze', () => {
        // The behavioural proof is `deletion-freeze-blocks-mutations.test.ts`,
        // which executes the real wrapper. This is the structural half: the
        // prefix list must still contain the account surface, because that is
        // what keeps `DELETE /api/account/deletion` reachable.
        const api = read('src/lib/errors/api.ts');
        const listMatch = api.match(/DELETION_FREEZE_EXEMPT_PREFIXES\s*=\s*\[([^\]]+)\]/);
        expect(listMatch).not.toBeNull();
        const list = listMatch![1];
        expect(list).toContain("'/api/account/'");
        expect(list).toContain("'/api/auth/'");
        // Trailing slashes, so `/api/accountsomething` is not exempted too.
        expect(list).not.toMatch(/'\/api\/account'/);
    });
});
