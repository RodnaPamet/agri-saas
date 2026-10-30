/**
 * Guardrail: button consistency.
 *
 * Prevents ad-hoc button styling from creeping back into app pages.
 * Scans all .tsx files under src/app/ for inline button styling
 * patterns that should use the .btn system instead.
 *
 * Allowlisted files can use inline button styling (navigation chrome,
 * loading / error skeletons that can't depend on the full Button tree).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');
const APP_DIR = path.join(SRC_DIR, 'app');

// Files that are allowed to have inline button styling
const ALLOWLIST = [
    // Layout components may have special styling
    'SidebarNav.tsx',
    // Loading/error skeletons may use inline styles
    'loading.tsx',
    'error.tsx',
    'not-found.tsx',
];

function findTsxFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findTsxFiles(full, acc);
        else if (entry.name.endsWith('.tsx') && !ALLOWLIST.includes(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

/**
 * Detects <button> tags with ad-hoc sizing classes that should use .btn instead.
 *
 * Catches patterns like:
 *   <button className="rounded-lg px-4 py-2 ..."
 *   <button className="text-sm rounded-full ..."
 *
 * Does NOT flag:
 *   <button className="btn btn-primary ..."   (correct)
 *   <button className="icon-btn ..."           (correct)
 *   <button onClick={...} className="text-red-400 ..."  (non-CTA inline)
 */
const AD_HOC_BUTTON_REGEX = /<button\b[^>]*className="(?!.*btn\b)(?=.*(?:rounded-|px-\d|py-\d))[^"]*"/g;

/**
 * Detects text-sm used on btn classes (should use btn-lg instead).
 */
const TEXT_SM_ON_BTN_REGEX = /btn .*text-sm|btn-primary.*text-sm|btn-secondary.*text-sm/g;

describe('Button consistency guardrails', () => {
    const appFiles = findTsxFiles(APP_DIR);

    it('should find .tsx files to scan', () => {
        expect(appFiles.length).toBeGreaterThan(0);
    });

    it.each(appFiles)('no ad-hoc button sizing in %s', (filePath) => {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const violations: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

            const adHocMatches = [...line.matchAll(AD_HOC_BUTTON_REGEX)];
            for (const _m of adHocMatches) {
                const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
                violations.push(`  ${rel}:${i + 1} — <button> with inline sizing classes, use .btn system`);
            }

            const textSmMatches = [...line.matchAll(TEXT_SM_ON_BTN_REGEX)];
            for (const _m of textSmMatches) {
                const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
                violations.push(`  ${rel}:${i + 1} — text-sm on .btn class, use btn-lg for larger buttons`);
            }
        }

        expect(violations).toEqual([]);
    });
});
