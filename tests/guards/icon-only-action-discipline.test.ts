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

    // The curated in-scope call-site registry is EMPTY as of GRC teardown
    // phase 2. Every site this ratchet pinned lived on the audit-pack
    // detail page (`audits/packs/[packId]/page.tsx`) — the three IconAction
    // buttons (Freeze pack / Generate share link / Clone for retest) and the
    // two Tooltip-wrapped export links (Export JSON / CSV). That page is
    // gone, and `IconAction` now has no call site anywhere in `src/`.
    //
    // The suite is kept rather than deleted because its other two halves
    // still have real subjects: the shared-primitive contract above reads a
    // file that exists, and the Admin exclusion below is a NEGATIVE scan
    // over a live directory tree — it can still fail when someone reaches
    // for IconAction on an admin page. Re-populate the registry here when
    // the primitive gets its next call site.

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
