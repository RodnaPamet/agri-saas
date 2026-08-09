/**
 * Icon-only action discipline (2026-06-07).
 *
 * The reduction: in-scope page-level blue/yellow (primary/secondary)
 * action buttons are ICON-ONLY — text removed, meaning preserved through
 * a strong icon + the shared ~1s-delayed `<Tooltip>` + an `aria-label`.
 * One shared primitive carries the contract: `<IconAction>` (Button-based
 * sites) or a `<Tooltip>`-wrapped `size:'icon'` link (download/nav links).
 *
 * This ratchet stops the family drifting back into text-bearing clutter:
 * each in-scope site is pinned to its icon-only label, and the shared
 * contract is locked. Admin is explicitly OUT of scope and verified clean.
 *
 * OUT OF SCOPE (unchanged, NOT locked here): entity-create headers (keep
 * the noun — see action-button-canonical-entity-label), modal/dialog
 * confirms, form submits, Cancel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP = 'src/app/t/[tenantSlug]/(app)';
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('icon-only action discipline', () => {
    describe('shared IconAction contract', () => {
        const src = read('src/components/ui/icon-action.tsx');
        it('renders icon-only (size="icon", no text/children)', () => {
            expect(src).toMatch(/size="icon"/);
            expect(src).toMatch(/Omit<\s*ButtonProps,[\s\S]*?'children'[\s\S]*?'text'/);
        });
        it('wraps the shared Tooltip (the ~1s-delayed, focus-accessible label)', () => {
            expect(src).toMatch(/<Tooltip content=\{label\}>/);
        });
        it('mirrors the label to aria-label (keyboard/SR certainty)', () => {
            expect(src).toMatch(/aria-label=\{label\}/);
        });
    });

    // Curated in-scope call sites. Each is pinned to its icon-only label
    // (IconAction `label=` OR a link `aria-label=`). The label string is
    // distinctive enough that its presence proves the icon-only button is
    // wired — and a revert to a text `<Button>Freeze Pack</Button>` would
    // drop the `label=`/`aria-label=` and fail here.

    // i18n batch T08 — the audit-pack IconAction labels now route through
    // next-intl (`t('packDetail.freezePack')` etc.). Assert the icon-only
    // wiring is preserved AND the en.json values keep the copy so the a11y
    // contract holds.
    const PACK_ICON_ACTION_I18N: Array<{ key: string; en: string }> = [
        { key: 'freezePack', en: 'Freeze pack' },
        { key: 'generateShareLink', en: 'Generate share link' },
        { key: 'cloneForRetest', en: 'Clone for retest' },
    ];
    for (const { key, en } of PACK_ICON_ACTION_I18N) {
        it(`IconAction site stays icon-only (i18n): "${en}"`, () => {
            const src = read(`${APP}/audits/packs/[packId]/page.tsx`);
            expect(src).toMatch(/import \{ IconAction \} from '@\/components\/ui\/icon-action'/);
            expect(src).toMatch(
                new RegExp(`<IconAction[\\s\\S]*?label=\\{t\\('packDetail\\.${key}'\\)\\}`),
            );
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            expect(require('../../messages/en.json').audits.packDetail[key]).toBe(en);
        });
    }

    // Link sites (download / navigation) — icon-only via a Tooltip-wrapped
    // `size:'icon'` anchor with an aria-label.
    // i18n (T06): RisksClient's "Import risks" link now resolves both the
    // aria-label and the Tooltip content through next-intl (tm('importRisks')).
    const LINK_SITES: Array<{
        file: string;
        ariaLabel: string;
        ariaMatch: string;
        tooltipMatch: RegExp;
    }> = [
        // i18n batch T08 — the pack Export JSON/CSV icon-link labels + tooltips
        // now route through next-intl (`t('packDetail.exportJson' | 'exportCsv')`).
        {
            file: `${APP}/audits/packs/[packId]/page.tsx`,
            ariaLabel: 'Export JSON',
            ariaMatch: `aria-label=\\{t\\('packDetail\\.exportJson'\\)\\}[\\s\\S]*?size: 'icon'`,
            tooltipMatch: /<Tooltip content=\{t\('packDetail\.(?:exportJson|exportCsv)'\)\}>/,
        },
        {
            file: `${APP}/audits/packs/[packId]/page.tsx`,
            ariaLabel: 'Export CSV',
            ariaMatch: `aria-label=\\{t\\('packDetail\\.exportCsv'\\)\\}[\\s\\S]*?size: 'icon'`,
            tooltipMatch: /<Tooltip content=\{t\('packDetail\.(?:exportJson|exportCsv)'\)\}>/,
        },
    ];

    for (const { file, ariaLabel, ariaMatch, tooltipMatch } of LINK_SITES) {
        it(`icon-only link stays icon-only: "${ariaLabel}"`, () => {
            const src = read(file);
            expect(src).toMatch(new RegExp(ariaMatch));
            // wrapped in the shared Tooltip for the delayed label.
            expect(src).toMatch(tooltipMatch);
        });
    }

    describe('Admin exclusion', () => {
        // The rollout must not reach Admin — no IconAction usage there.
        const adminDir = path.join(ROOT, APP, 'admin');
        const walk = (dir: string): string[] =>
            fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
                const full = path.join(dir, e.name);
                return e.isDirectory()
                    ? walk(full)
                    : /\.(tsx|ts)$/.test(e.name)
                      ? [full]
                      : [];
            });
        it('no Admin-page file imports or uses IconAction', () => {
            const offenders = walk(adminDir).filter((f) =>
                /IconAction/.test(fs.readFileSync(f, 'utf8')),
            );
            expect(offenders).toEqual([]);
        });
    });
});
