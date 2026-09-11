/**
 * Polish PR-6 — no-nested-cards ratchet (density discipline).
 *
 * The Card primitive defines a real elevation system: flat / inset
 * / raised / floating, expressed via background tone (no shadow).
 * A `<Card>` rendered DIRECTLY inside another `<Card>` (with no
 * intermediate non-Card subtree boundary) is an architectural
 * smell — it produces a "card stuffed inside a card" composition
 * that reads as a fence, not a frame.
 *
 * The rule
 *   A card frames; it does not subdivide. Subdivision is
 *   typography's job — eyebrow labels, dividers, vertical spacing.
 *   When a section needs internal hierarchy, use type rhythm +
 *   `<hr className="border-border-subtle">` instead of nesting
 *   another card surface.
 *
 * What this ratchet detects
 *   For each .tsx/.jsx file under SCAN_DIRS, scan for the literal
 *   pattern: a `<Card` open token followed by another `<Card` open
 *   BEFORE the matching `</Card>` close, on the same component
 *   subtree. The matcher tracks open/close depth so siblings (one
 *   `<Card>` followed by `</Card>` then another `<Card>`) don't
 *   trip it.
 *
 * What this ratchet does NOT police
 *   - `<Card>` rendered as a child of a non-Card parent that ALSO
 *     happens to be inside a card (e.g. modal body). Modal isn't
 *     a Card; the inner Card stands alone.
 *   - `glass-card` raw className (those are caught by the Polish
 *     PR-3 card-pretender ratchet).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

const EXEMPT_DIR_NAMES = new Set<string>([
    'node_modules',
    '__tests__',
    '__mocks__',
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
    /card\.tsx$/, // the primitive itself
];

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
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
}


/**
 * Scan a file for nested-card pattern. Tracks Card-open-depth
 * line by line: when depth >= 2 at the moment a `<Card>` open is
 * encountered, that's a violation.
 *
 * Self-closing `<Card />` doesn't add to depth (rare, but possible
 * when used as a placeholder).
 */
function findNestedCards(content: string): Array<{ line: number; text: string }> {
    const lines = content.split('\n');
    const violations: Array<{ line: number; text: string }> = [];
    let depth = 0;
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*'))
            return;
        // Process closes BEFORE opens on the same line so
        // `<Card>...<Card />...</Card>` doesn't double-count.
        const closeMatches = (line.match(/<\/Card\b/g) || []).length;
        const selfCloseMatches = (line.match(/<Card\b[^>]*\/>/g) || []).length;
        const openMatches =
            (line.match(/<Card\b(?!Header|Footer|Body|Title|Description|List)/g) || []).length -
            selfCloseMatches;
        // Are we ABOUT to open a card while already inside one?
        if (openMatches > 0 && depth >= 1) {
            violations.push({
                line: i + 1,
                text: trimmed.slice(0, 200),
            });
        }
        depth += openMatches - closeMatches;
        if (depth < 0) depth = 0;
    });
    return violations;
}

describe('No-nested-cards ratchet (Polish PR-6)', () => {
    it('zero <Card> directly nested inside another <Card>', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const hits = findNestedCards(content);
                for (const hit of hits) {
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: hit.line,
                        text: hit.text,
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
                `Found ${offenders.length} nested <Card> instance(s).\n\nA card frames; it does not subdivide. When a section needs internal hierarchy, use eyebrow labels + spacing + <hr className="border-border-subtle"> dividers — never nest a Card inside a Card.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('the scanner correctly identifies an intentional nesting', () => {
        // Mutation test — feed the scanner a deliberately-nested
        // example. If the scanner returns 0 hits on the canonical
        // bad case, the ratchet has decayed into a no-op.
        const sample = [
            'function Test() {',
            '  return (',
            '    <Card>',
            '      <Card>nested</Card>',
            '    </Card>',
            '  );',
            '}',
        ].join('\n');
        const hits = findNestedCards(sample);
        expect(hits.length).toBeGreaterThanOrEqual(1);
    });

    it('the scanner ignores siblings (open then close, then re-open)', () => {
        const sample = [
            'function Test() {',
            '  return (',
            '    <>',
            '      <Card>first</Card>',
            '      <Card>second</Card>',
            '    </>',
            '  );',
            '}',
        ].join('\n');
        const hits = findNestedCards(sample);
        expect(hits.length).toBe(0);
    });
});
