/**
 * Roadmap-3 PR-7 — Modal / Sheet width tokens.
 *
 * Modal and Sheet ALREADY have a tokenised size system in their
 * primitives (xs/sm/md/lg/xl/full for Modal; sm/md/lg/xl for
 * Sheet). The polish work this round is structural — lock the
 * token system in the primitive and ban call sites from
 * overriding the locked widths via `className="max-w-…"` /
 * `style={{ width: … }}` shenanigans.
 *
 * The user opens "Create Risk" and the modal is one width;
 * "Edit Practice" is another; "Upload Evidence" a third. Even
 * though the primitive supports a token system, anyone can
 * still pass an override className that bypasses it. This
 * ratchet shuts that door.
 *
 * What this ratchet locks
 *
 *   1. Modal primitive declares the canonical size tokens
 *      (xs / sm / md / lg / xl / full).
 *   2. Sheet primitive declares its size tokens
 *      (sm / md / lg / xl).
 *   3. No `<Modal>` or `<Sheet>` mount in src/app passes a
 *      `className="max-w-…"` override (would defeat the size
 *      token).
 *   4. No `<Modal>` or `<Sheet>` mount passes inline
 *      `style={{ width: … }}` (same).
 *
 * Pages that genuinely need a non-token width (rare) extend
 * the primitive's variant set in `modal.tsx` / `sheet.tsx`
 * itself — never via inline overrides.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const MODAL_PRIMITIVE = 'src/components/ui/modal.tsx';
const SHEET_PRIMITIVE = 'src/components/ui/sheet.tsx';

// Match `<Modal …>` open tags up to the closing `>` and check
// for a className max-w override OR an inline style width.
const MODAL_WITH_MAX_W =
    /<Modal\b[^>]*?className\s*=\s*["'][^"']*?max-w-\[/;
const SHEET_WITH_MAX_W =
    /<Sheet\b[^>]*?className\s*=\s*["'][^"']*?max-w-\[/;
const MODAL_WITH_STYLE_WIDTH =
    /<Modal\b[^>]*?style\s*=\s*\{[^}]*?width\s*:/;
const SHEET_WITH_STYLE_WIDTH =
    /<Sheet\b[^>]*?style\s*=\s*\{[^}]*?width\s*:/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Modal/Sheet width tokens (Roadmap-3 PR-7)', () => {
    it('Modal primitive defines the canonical size variants', () => {
        const src = read(MODAL_PRIMITIVE);
        for (const variant of ['xs', 'sm', 'md', 'lg', 'xl', 'full']) {
            expect(src).toMatch(
                new RegExp(`\\b${variant}\\s*:\\s*["']`),
            );
        }
    });

    it('Sheet primitive defines size variants', () => {
        const src = read(SHEET_PRIMITIVE);
        for (const variant of ['sm', 'md', 'lg', 'xl']) {
            expect(src).toMatch(
                new RegExp(`\\b${variant}\\s*:\\s*["']`),
            );
        }
    });

    it('no Modal/Sheet mount overrides width via className max-w-[…]', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            for (const rx of [MODAL_WITH_MAX_W, SHEET_WITH_MAX_W]) {
                const g = new RegExp(rx.source, 'g');
                let m: RegExpExecArray | null;
                while ((m = g.exec(content)) !== null) {
                    const before = content.slice(0, m.index);
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: before.split('\n').length,
                        text: m[0].slice(0, 200),
                    });
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} Modal/Sheet mount(s) overriding width via className. Use the size token (sm/md/lg/xl) on the primitive — never inline max-w-[…].\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('no Modal/Sheet mount overrides width via inline style', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            for (const rx of [MODAL_WITH_STYLE_WIDTH, SHEET_WITH_STYLE_WIDTH]) {
                const g = new RegExp(rx.source, 'g');
                let m: RegExpExecArray | null;
                while ((m = g.exec(content)) !== null) {
                    const before = content.slice(0, m.index);
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: before.split('\n').length,
                        text: m[0].slice(0, 200),
                    });
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} Modal/Sheet mount(s) with inline width style.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
