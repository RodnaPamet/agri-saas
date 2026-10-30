/**
 * Guardrail: no emoji icons in UI chrome.
 *
 * Scans all .tsx files in src/app/ and src/components/ for emoji characters
 * that are commonly used as icons. Emojis in user content are fine; emojis
 * as icons in UI chrome (nav, headers, buttons, tabs, badges, empty states)
 * are not — they should be replaced with lucide-react icons via AppIcon.
 *
 * Runs as part of the Jest suite — no DOM needed.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');

/** Directories to scan for emoji icon violations. */
const SCAN_DIRS = [
    path.join(SRC_DIR, 'app'),
    path.join(SRC_DIR, 'components'),
];

/** Files to exclude from scanning (e.g. code comments in non-UI files). */
const EXCLUDED_FILES = new Set([
    'prisma.ts', // Has ⚠️ in a developer code comment, not UI
    // Epic 57 — the shortcut help overlay pretty-prints modifier keys
    // to their standard Unicode glyphs (⌘ ⇧ ⌥ ↑↓←→). These are
    // keyboard notation, not emoji-as-icon. `⌥` (U+2325) happens to
    // fall in the regex's Misc-Technical bucket, but its role here is
    // strictly typographic — Mac users expect the glyph next to
    // "Alt/Option" affordances, not the word "Alt".
    'shortcut-help-overlay.tsx',
]);

/**
 * Emoji regex — matches common emoji icon characters used in UI chrome.
 *
 * Covers:
 * - Miscellaneous Symbols and Pictographs (U+1F300–1F5FF)
 * - Emoticons (U+1F600–1F64F)
 * - Transport and Map Symbols (U+1F680–1F6FF)
 * - Supplemental Symbols and Pictographs (U+1F900–1F9FF)
 * - Enclosed Alphanumeric Supplement (U+1F100–1F1FF) — flag emojis
 * - Common symbols: ⚠️ ❌ ✅ ⏰ ⏳ ✨ ⭐ ❗ ❓ ☑ ☐ ⚡ ⚙ ☀ ☁ ☂
 */
// \u{2934} + \u{2935} were each listed twice; one occurrence
// dropped. Functionally identical, drops two CodeQL warnings.
const EMOJI_ICON_RE = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1F100}-\u{1F1FF}\u{2702}-\u{27B0}\u{FE0F}\u{200D}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{231A}-\u{23FF}\u{2B50}\u{2B55}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FE}\u{25FD}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25B6}\u{23CF}]/gu;

function findTsxFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findTsxFiles(full, acc);
        else if (entry.name.endsWith('.tsx')) {
            if (!EXCLUDED_FILES.has(entry.name)) {
                acc.push(full);
            }
        }
    }
    return acc;
}

describe('No emoji icons in UI chrome', () => {
    const allFiles: string[] = [];
    for (const dir of SCAN_DIRS) {
        findTsxFiles(dir, allFiles);
    }

    it('should find at least some .tsx files to scan', () => {
        expect(allFiles.length).toBeGreaterThan(0);
    });

    it.each(allFiles)('no emoji icons in %s', (filePath) => {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const violations: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip imports, comments, and console.log lines
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) continue;
            // Skip lines that are purely comments (JSDoc, etc.)
            if (trimmed.startsWith('/**') || trimmed.startsWith('*/')) continue;

            const matches = [...line.matchAll(EMOJI_ICON_RE)];
            if (matches.length > 0) {
                // Filter out variation selector (U+FE0F) and zero-width joiner (U+200D) standalone
                const realEmojis = matches.filter(m => m[0] !== '\uFE0F' && m[0] !== '\u200D');
                if (realEmojis.length > 0) {
                    const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
                    violations.push(
                        `  ${rel}:${i + 1} — found emoji character(s): ${realEmojis.map(m => `U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`).join(', ')}`
                    );
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
