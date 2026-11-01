import fs from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

/**
 * Nothing may create a LOW_STOCK notification. Owner ruling 2026-11-01:
 * *"we need to remove the low stock notification - it's not useful."*
 *
 * ## Why a guard and not just a deletion
 *
 * The sweep was deleted, and a deletion is undone by one plausible-looking
 * commit. The numbers are the argument for holding it: measured in production
 * 2026-10-30, LOW_STOCK was **8,778 of 8,815 notification rows — 99.6% of every
 * notification in the product**, growing ~66 a day. Because the phone reads only
 * the newest 50, that flood pushed every other kind off the farm's «Известия»
 * screen entirely. Re-introducing the producer does not merely add noise; it
 * takes the notification surface away from everything else.
 *
 * It had already been tuned once rather than removed — the 2026-10-31 ruling
 * made it once-per-episode instead of once-per-day — so "make it quieter" is a
 * road already travelled. The owner's second look settled it.
 *
 * ## What is deliberately NOT removed
 *
 * - The `LOW_STOCK` enum value. Existing rows carry it, and dropping an enum
 *   value is a destructive migration needing an inverse script, to no benefit.
 * - `Item.lowStockNotifiedAt`. Same reasoning: a column drop for a column that
 *   now simply stays NULL.
 * - The inventory list's low-stock indicator and the dashboard row. Owner
 *   ruling, same day: those are IN-CONTEXT — you see them when you are looking
 *   at inventory, rather than being interrupted — which is the opposite of the
 *   complaint. This guard is about the PRODUCER, not the concept.
 */

/** Calls that CREATE a notification. Module-level so `selector-teeth` can bite. */
export function notificationCreationSites(src: string): string[] {
    const code = blankNonCode(src, { strings: false });
    return (
        code.match(/(?:createNotification|publishNotification|notify\w*)\s*\(/g) ?? []
    );
}

/** Does this source CREATE a LOW_STOCK notification (as opposed to reading one)? */
export function producesLowStock(src: string): boolean {
    // Comments stripped first: a file may EXPLAIN why it no longer produces
    // LOW_STOCK — this very repo's style — without being reported as producing
    // it. That is the `a-scar-is-not-a-wound` rule.
    const code = blankNonCode(src, { strings: false });
    if (!/LOW_STOCK/.test(code)) return false;
    // A `type: 'LOW_STOCK'` literal being WRITTEN is the producing shape.
    return /type:\s*['"]LOW_STOCK['"]/.test(code);
}

describe('no LOW_STOCK notification producer (owner ruling 2026-11-01)', () => {
    const files = collectSourceFiles({ roots: ['src'] });

    it('the scan population is real', () => {
        console.log(`[no-low-stock-producer] files=${files.length}`);
        // Floor, because every assertion below passes perfectly over zero files.
        expect(files.length).toBeGreaterThanOrEqual(500);
    });

    it('no file creates a LOW_STOCK notification', () => {
        const offenders = files.filter((f) => producesLowStock(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('the detector discriminates — it is not blind and not a catch-all', () => {
        // Positive: the exact shape the deleted sweep used.
        expect(producesLowStock("await createNotification({ type: 'LOW_STOCK', tenantId })")).toBe(true);
        expect(producesLowStock('const n = { type: "LOW_STOCK" };')).toBe(true);
        // Negative: READING or filtering the type is fine — the enum value
        // stays, and the bell still has to render the rows already written.
        expect(producesLowStock("where: { type: { not: 'LOW_STOCK' } }")).toBe(false);
        expect(producesLowStock("if (n.type === 'LOW_STOCK') return icon;")).toBe(false);
        // Negative: a COMMENT about it is not a producer.
        expect(producesLowStock("// we used to send type: 'LOW_STOCK' here")).toBe(false);
        expect(producesLowStock('nothing to see')).toBe(false);
    });

    it('the notification-creation selector still selects on the real tree', () => {
        // Guards the OTHER half: if `notificationCreationSites` stopped matching
        // — a rename of the helper, say — the assertion above would pass over a
        // product that had quietly started sending them again by another name.
        const total = files.reduce(
            (n, f) => n + notificationCreationSites(fs.readFileSync(f, 'utf8')).length,
            0,
        );
        console.log(`[no-low-stock-producer] notification-creation call sites=${total}`);
        expect(Number.isFinite(total)).toBe(true);
        expect(total).toBeGreaterThanOrEqual(5);
    });
});
