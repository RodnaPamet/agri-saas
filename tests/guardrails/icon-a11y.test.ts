/**
 * Guardrail: icon accessibility.
 *
 * Scans all .tsx files for icon-only buttons (buttons whose only visible
 * child is a symbol character like × or a single AppIcon) and verifies
 * they have an aria-label attribute.
 *
 * Runs as part of the Jest suite — no DOM needed.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');

const SCAN_DIRS = [
    path.join(SRC_DIR, 'app'),
    path.join(SRC_DIR, 'components'),
];

function findTsxFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findTsxFiles(full, acc);
        else if (entry.name.endsWith('.tsx')) acc.push(full);
    }
    return acc;
}

/**
 * Matches button elements containing only × (U+00D7) or similar single-char
 * symbols without an aria-label.
 *
 * Pattern explanation:
 * - Finds <button ... > followed by a single symbol character and </button>
 * - Checks that aria-label is NOT present in the button's attributes
 */
const ICON_ONLY_BUTTON_RE = /<button\b(?![^>]*aria-label)[^>]*>\s*[×✕✓✗]\s*<\/button>/g;

describe('Icon accessibility guardrails', () => {
    const allFiles: string[] = [];
    for (const dir of SCAN_DIRS) {
        findTsxFiles(dir, allFiles);
    }

    it('should find .tsx files to scan', () => {
        expect(allFiles.length).toBeGreaterThan(0);
    });

    it.each(allFiles)('icon-only buttons have aria-label in %s', (filePath) => {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const violations: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) continue;

            const matches = [...line.matchAll(ICON_ONLY_BUTTON_RE)];
            if (matches.length > 0) {
                const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
                violations.push(`  ${rel}:${i + 1} — icon-only button missing aria-label`);
            }
        }

        expect(violations).toEqual([]);
    });
});
