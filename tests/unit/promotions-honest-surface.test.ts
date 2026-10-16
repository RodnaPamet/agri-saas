/**
 * Prompt A — the promotions surface must not lie.
 *
 * Two independent promises the product could not keep, plus the term split:
 *
 *   1. The sidebar linked to /offers unconditionally, while the global
 *      catalogue is empty in every uncurated environment — a nav entry whose
 *      only possible destination is an empty state.
 *   2. The lead confirmation claimed "the supplier will get back to you" and
 *      "you can track requests from the Offers page". Nothing notifies a
 *      supplier (Promotion is a global catalogue with no provider tenant) and
 *      `PromotionLead` has no reader, so neither was true. The modal's
 *      description made the same supplier-follow-up promise.
 *   3. Sidebar said „Оферти", the page said „Промоции" — two BG words for one
 *      thing.
 *
 * These assert the copy contract in BOTH locales and the wiring of the nav
 * gate — including that the feed and the gate share ONE definition of
 * "active", since two copies is precisely how a nav link outlives the content
 * it points at.
 */
import { readCatalogue } from '../helpers/catalogue';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const en = readCatalogue('en');
const bg = readCatalogue('bg');
const SIDEBAR_SRC = read('src/components/layout/SidebarNav.tsx');
const USECASE_SRC = read('src/app-layer/usecases/promotions.ts');

/** Claims that were false when made. None may return, in either locale. */
const BROKEN_PROMISES = [
    /supplier will get back to you/i,
    /track requests from the Offers page/i,
    /доставчикът ще се свърже с вас/i,
];

describe('A2 — no user-facing copy promises what the product cannot do', () => {
    it('the lead notification exists in both locales', () => {
        for (const [name, msgs] of [['en', en], ['bg', bg]] as const) {
            expect(msgs.ag.offers.leadNotification?.title).toEqual(expect.any(String));
            expect(msgs.ag.offers.leadNotification?.message).toEqual(expect.any(String));
            expect(msgs.ag.offers.leadNotification.title).not.toHaveLength(0);
            expect(msgs.ag.offers.leadNotification.message).not.toHaveLength(0);
            // Names the company so the receipt is identifiable.
            expect(`${name}:${msgs.ag.offers.leadNotification.title}`).toContain('{company}');
        }
    });

    it('no broken promise survives anywhere in either locale', () => {
        const haystack = JSON.stringify({ en, bg });
        for (const pattern of BROKEN_PROMISES) {
            expect(haystack).not.toMatch(pattern);
        }
    });

    it('the notification text is NOT hardcoded in the usecase any more', () => {
        // It must come from the message catalogue, keyed for the recipient's
        // own language — the row stores literal text, so a hardcoded English
        // string is a permanently-English notification for a Bulgarian user.
        expect(USECASE_SRC).not.toMatch(/title: `Offer request sent to/);
        expect(USECASE_SRC).toMatch(/translateFor\(/);
        expect(USECASE_SRC).toMatch(/ag\.offers\.leadNotification\.title/);
        expect(USECASE_SRC).toMatch(/ag\.offers\.leadNotification\.message/);
        // Localised for the RECIPIENT, not the ambient request locale.
        expect(USECASE_SRC).toMatch(/uiLanguage/);
    });

    it('the modal description no longer promises a supplier follow-up', () => {
        for (const msgs of [en, bg]) {
            const description: string = msgs.ag.offers.ask.description;
            expect(description).toEqual(expect.any(String));
            for (const pattern of BROKEN_PROMISES) {
                expect(description).not.toMatch(pattern);
            }
        }
    });
});

describe('A1 — the Promotions nav entry is gated on the catalogue', () => {
    it('gates the /offers item on the catalogue being non-empty', () => {
        expect(SIDEBAR_SRC).toMatch(/tenantHref\('\/offers'\)/);
        // Matches the sibling Events gate's shape (`!== false`) so two
        // adjacent data-driven nav gates don't behave differently.
        expect(SIDEBAR_SRC).toMatch(/visible:\s*tenant\.promotionsAvailable !== false/);
    });

    it('resolves the flag server-side in the tenant layout, not in nav render', () => {
        const layout = read('src/app/t/[tenantSlug]/layout.tsx');
        expect(layout).toMatch(/hasVisiblePromotions\(\)/);
        expect(layout).toMatch(/promotionsAvailable,/);
    });

    it('the feed and the gate share ONE visibility predicate (incl. the draft gate)', () => {
        // Two copies of "active" would let the link outlive the content.
        expect(USECASE_SRC).toMatch(/function visibleWhere\(now: Date\)/);
        // Both callers go through it.
        expect(USECASE_SRC).toMatch(/where: visibleWhere\(now\)/);
        expect(USECASE_SRC).toMatch(/where: visibleWhere\(now\),\s*\n\s*select: \{ id: true \}/);
    });
});

describe('A3 — one Bulgarian term for promotions', () => {
    it('nav and page agree, in both locales', () => {
        expect(bg.sidebarNav.offers).toBe('Промоции');
        expect(bg.ag.offers.title).toBe('Промоции');
        expect(en.sidebarNav.offers).toBe('Promotions');
        expect(en.ag.offers.title).toBe('Promotions');
    });

    it('„Оферти" is gone as a nav label', () => {
        expect(bg.sidebarNav.offers).not.toBe('Оферти');
    });
});
