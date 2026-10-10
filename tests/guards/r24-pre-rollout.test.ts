/**
 * R24-PR-E — Icon-button shape rollout ratchet.
 *
 * The gear / columns-dropdown button is the canonical icon-only
 * button in IC. Two implementations (`columns-dropdown.tsx` for
 * the useColumnsDropdown hook + `edit-columns-button.tsx` for the
 * legacy direct mount) historically used `rounded-lg` (12px),
 * which was a chrome-family outlier — the surrounding filter
 * dropdown + adjacent action buttons inherited the cva 8px slim
 * radius. Two systems in one toolbar read as drift.
 *
 * R24-PR-E pulls both gear buttons onto the R24-PR-C slim radius
 * (`rounded-[8px]`) so the toolbar reads as one chassis.
 *
 * Why ratchet: a future "use rounded-lg for consistency with
 * something" PR would re-introduce the outlier without anyone
 * catching it in review.
 *
 * Out of scope (deliberately picked up in follow-up R24-PR-F's
 * `no-ad-hoc-button-styling` baseline):
 *   - Other icon-only buttons (kebab menus, close buttons in
 *     modals) — they're already on the cva 8px because they're
 *     plain `<Button icon={...} />` calls without the
 *     `rounded-lg` override.
 *   - Wholesale audit of every `<button>` JSX in the repo —
 *     PR-F's structural sweep.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

const ICON_BUTTON_SITES = [
    // R-filter-gear (2026-06-07): the controlled gear's <Button> moved into
    // the shared <ChecklistGearButton> primitive (both toolbar gears trigger
    // through it). The legacy table-bound variant still has its own <Button>.
    'src/components/ui/checklist-gear-button.tsx',
    'src/components/ui/table/edit-columns-button.tsx',
] as const;

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('R24-PR-E — Icon-button shape rollout', () => {
    for (const site of ICON_BUTTON_SITES) {
        describe(site, () => {
            const src = read(site);

            it('the gear button uses the slim 8px radius', () => {
                // Scope the assertion to the Button instance that
                // mounts the Settings icon — both files have exactly
                // one such usage today.
                const gearMatch = src.match(
                    /<Button[\s\S]*?icon=\{[\s\S]*?\/>/m,
                );
                expect(gearMatch).not.toBeNull();
                const gearBlock = gearMatch![0];
                expect(gearBlock).toMatch(/rounded-\[8px\]/);
            });

            it('the gear button no longer uses `rounded-lg` (legacy 12px outlier)', () => {
                const stripped = blankNonCode(src);
                expect(stripped).not.toMatch(/\brounded-lg\b/);
            });

            it('the gear button stays `<Button>` (not a raw <button>)', () => {
                // A future "simplify" PR that drops <Button> and
                // rolls a raw <button className="..."> would lose
                // the cva-driven glass material entirely. The
                // canonical shape is <Button> + className overrides.
                expect(src).toMatch(
                    /<Button[\s\S]*?icon=\{[\s\S]*?\/>/m,
                );
            });
        });
    }
});
