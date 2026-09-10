/**
 * Elevation PR-8 — form-drift cleanup ratchet.
 *
 * Locks two design-system invariants on form surfaces:
 *
 *   1. No file in src/app or src/components references the
 *      undefined `.card` CSS class. Use `<Card>` from
 *      `@/components/ui/card` (or `glass-card` if a CSS-class
 *      consumer is genuinely needed). The `.card` class doesn't
 *      exist in globals.css — references to it render unstyled
 *      and are silent visual debt.
 *
 *   2. Form pages don't hand-roll `<fieldset>` + `<legend>` for
 *      grouping radio inputs. The `<RadioGroup>` primitive
 *      (Radix-backed, semantic-token styled) is the canonical
 *      pattern for 2-5 visible choices.
 *
 * What this ratchet does NOT police
 *   - `<fieldset disabled>` used as a global disable wrapper for
 *     a form (no `<legend>` child) — that's a different pattern.
 *   - `<input type="radio">` inside a Radix-managed RadioGroup
 *     primitive — the wrapping is correct.
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
    // The radio-group primitive itself.
    'src/components/ui/radio-group.tsx',
    // TODO(Elevation PR-8 follow-up): migrate the 3 fieldset/legend
    // blocks in MembersTable to <RadioGroup>. The blocks
    // (org-add-member-role-group, change-role, invite-role) follow
    // the same shape as the NewTenantForm framework picker that
    // PR-8 already migrated. Held out of this PR to keep the diff
    // bounded; a later PR rewires them.
    'src/app/org/[orgSlug]/(app)/members/MembersTable.tsx',
]);

const CARD_CLASS_RE = new RegExp('className="card[ "]');
const FIELDSET_LEGEND_RE = /<fieldset[\s\S]{0,200}<legend\b/;

interface Hit {
    file: string;
    line: number;
    text: string;
    kind: 'card-class' | 'fieldset-legend';
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
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Form drift ratchet (Elevation PR-8)', () => {
    it('zero references to the undefined `.card` CSS class', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    if (CARD_CLASS_RE.test(line)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: i + 1,
                            text: line.trim().slice(0, 200),
                            kind: 'card-class',
                        });
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} reference(s) to the undefined .card CSS class.\n\nThe .card class doesn't exist in globals.css. Use <Card> from '@/components/ui/card' (or 'glass-card' for a CSS-class consumer).\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('zero hand-rolled <fieldset> + <legend> radio groups in form pages', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                if (!FIELDSET_LEGEND_RE.test(content)) continue;
                offenders.push({
                    file: path.relative(ROOT, file),
                    line: 0,
                    text: 'file contains <fieldset>...<legend> pattern',
                    kind: 'fieldset-legend',
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file} — ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} hand-rolled <fieldset>/<legend> shape(s).\n\nUse <RadioGroup> + <RadioGroupItem> from '@/components/ui/radio-group' for 2-5 visible choices. The Radix-backed primitive carries a11y + state + selected/hover styling.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
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
