/**
 * Elevation PR-4 — Modal/Sheet action-ordering ratchet.
 *
 * The convention
 *   In every <Modal.Actions> / <Modal.Footer> / <Sheet.Actions> /
 *   <Sheet.Footer> block, the LAST <Button> child is the primary
 *   (or destructive-primary) action. Cancel / secondary / ghost
 *   buttons render BEFORE it (left of it on desktop, above it on
 *   mobile sheet).
 *
 *   A user's hand learns one direction. Modals don't ask them to
 *   learn two.
 *
 * What this ratchet detects
 *   For each file under src/app or src/components, find blocks
 *   bounded by <Modal.Actions>...</Modal.Actions> (or .Footer,
 *   or Sheet equivalents). Inside the block, find every <Button
 *   variant="..."> declaration and assert the LAST one is
 *   variant="primary" or variant="destructive". variant="secondary"
 *   / "ghost" / "destructive-outline" as the last child is a
 *   violation.
 *
 * What this ratchet does NOT police
 *   - Blocks where the only child is a single button (no ordering
 *     to enforce).
 *   - Blocks containing non-Button children (e.g. a confirm-text
 *     <input> + buttons) — those are out of scope for this ratchet.
 *   - Sheet.Actions on mobile-direction sheets where vertical
 *     stacking puts primary on TOP (different rule, not policed).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

const EXEMPT_DIR_NAMES = new Set<string>(['node_modules', '__tests__', '__mocks__']);
const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const EXEMPT_FILES = new Set<string>([
    // The Modal / Sheet primitives themselves.
    'src/components/ui/modal.tsx',
    'src/components/ui/sheet.tsx',
]);

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        const segments = rel.split(path.sep);
        if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (EXEMPT_FILES.has(rel)) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
}

const ACTIONS_BLOCK_RE =
    /<(Modal|Sheet)\.(Actions|Footer)>([\s\S]*?)<\/(Modal|Sheet)\.(Actions|Footer)>/g;
// Match a single `<Button …>` open-tag (greedy up to the closing `>` or `/>`,
// but stopping at the next `<` so we never bleed into the following sibling).
// A Button without an explicit `variant=` is treated as `"primary"` because
// `src/components/ui/button.tsx` defaults to it.
const BUTTON_OPEN_RE = /<Button(\s[^<]*?)?(\/?)>/g;
const VARIANT_ATTR_RE = /\bvariant=["']([a-z-]+)["']/;

describe('Modal/Sheet action ordering (Elevation PR-4)', () => {
    it('every Modal/Sheet action block ends with a primary or destructive Button', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                let match: RegExpExecArray | null;
                ACTIONS_BLOCK_RE.lastIndex = 0;
                while ((match = ACTIONS_BLOCK_RE.exec(content)) !== null) {
                    const inner = match[3];
                    // Find every Button open tag in the block. Missing
                    // `variant=` collapses to the primitive's default —
                    // "primary".
                    const variants: string[] = [];
                    let buttonMatch: RegExpExecArray | null;
                    const buttonRe = new RegExp(BUTTON_OPEN_RE.source, 'g');
                    while ((buttonMatch = buttonRe.exec(inner)) !== null) {
                        const attrs = buttonMatch[1] ?? '';
                        const v = VARIANT_ATTR_RE.exec(attrs);
                        variants.push(v ? v[1] : 'primary');
                    }
                    if (variants.length < 2) continue; // single button — no ordering
                    const last = variants[variants.length - 1];
                    if (last !== 'primary' && last !== 'destructive') {
                        // Find approximate line number of the block start.
                        const before = content.slice(0, match.index);
                        const lineNum = before.split('\n').length;
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: lineNum,
                            text: `last button is variant="${last}"; expected "primary" or "destructive"`,
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} Modal/Sheet action block(s) where the LAST <Button> is not primary or destructive.\n\nConvention: cancel/secondary/ghost buttons render FIRST in JSX order; the most-affirmative action (primary or destructive) renders LAST. This way the user's hand learns one direction across every modal.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(4);
    });
});
