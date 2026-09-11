/**
 * Roadmap-2 PR-9 — toast vocabulary discipline.
 *
 * Sonner's `toast()` was imported and configured per call site —
 * duration, variant, position decided by the page. The Epic 67
 * undo pattern coexisted as a separate API the page author had to
 * know about. Toasts are the most-seen feedback surface in the
 * product, and they had the LEAST design discipline.
 *
 * After PR-9 there is one canonical hook (`useToast`) with four
 * named methods (`success`, `error`, `info`, `warning`) plus a
 * fifth (the undo pattern, separate hook). Locked durations,
 * locked variants. Pages call the right method and the design
 * decisions stay centralized.
 *
 * What this ratchet locks in
 *   1. The `useToast()` hook exists at the canonical path with
 *      the four named methods + dismiss.
 *   2. No file outside the curated `SONNER_PRIMITIVE_FILES`
 *      allowlist imports `from 'sonner'`. The allowlist contains
 *      ONLY the canonical seam: the Toaster mount in providers,
 *      the `useToast` hook itself, and the two undo-pattern
 *      modules that wrap sonner's primitives in their own way.
 *
 * Future toast surfaces extend this ratchet by adding to the
 * allowlist with a written reason, or — preferably — by routing
 * through `useToast`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const HOOK_PATH = 'src/components/ui/hooks/use-toast.ts';

// The canonical seam. Every other file MUST flow through
// `useToast()`. Adding to this set requires a written rationale
// in the PR description.
const SONNER_PRIMITIVE_FILES = new Set<string>([
    // The Toaster <Toaster /> mount lives here.
    'src/app/providers.tsx',
    // The useToast hook IS the seam — it imports sonner under
    // the hood and re-exports a four-method API.
    'src/components/ui/hooks/use-toast.ts',
    // Epic 67 undo pattern wraps sonner's `toast.custom()` to
    // render a UndoToast component. The hook owns the timing +
    // countdown bar; sonner is the renderer. Stays direct.
    'src/components/ui/hooks/use-toast-with-undo.ts',
    // The UndoToast component itself uses `toast.dismiss()` and
    // related primitives directly.
    'src/components/ui/undo-toast.tsx',
    // Celebration toast — renders a custom milestone toast with
    // confetti + tone. The animation orchestration uses sonner's
    // promise/custom APIs that don't fit the four-method shape.
    'src/components/ui/hooks/use-celebration.ts',
]);

const SONNER_IMPORT_RE = /import[^;]*?from\s+['"]sonner['"]/m;

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(ts|tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Toast vocabulary discipline (Roadmap-2 PR-9)', () => {
    it('the useToast hook exposes the four canonical methods', () => {
        const src = read(HOOK_PATH);
        expect(src).toMatch(/export\s+function\s+useToast/);
        for (const method of ['success', 'error', 'info', 'warning', 'dismiss']) {
            // Each method appears in the ToastApi interface and as
            // a property on the api object.
            expect(src).toMatch(
                new RegExp(`\\b${method}\\b`),
            );
        }
    });

    it('the useToast hook locks per-variant durations', () => {
        const src = read(HOOK_PATH);
        // The four default durations must be set explicitly so
        // pages don't drift into "5s on success / 8s on warning"
        // ad-hoc decisions.
        for (const variant of ['success', 'error', 'info', 'warning']) {
            expect(src).toMatch(new RegExp(`${variant}:\\s*(\\d+|Infinity)`));
        }
    });

    it('no file outside the curated seam imports from sonner', () => {
        const offenders: string[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            if (!SONNER_IMPORT_RE.test(content)) continue;
            const rel = path.relative(ROOT, file);
            if (!SONNER_PRIMITIVE_FILES.has(rel)) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `Found ${offenders.length} file(s) importing directly from 'sonner' outside the canonical seam:\n  ${offenders.join('\n  ')}\n\nMigrate to \`useToast()\` from '@/components/ui/hooks/use-toast'. The four named methods (success/error/info/warning) cover every standard surface; for the destructive-undo flow, use \`useToastWithUndo\` from the same hooks barrel. Adding to SONNER_PRIMITIVE_FILES requires a written reason in the PR description.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('every primitive in the allowlist actually imports sonner', () => {
        // Defensive: a stale allowlist entry would hide a future
        // direct import slipping through silently. Mirror of the
        // no-lucide ratchet's stale-entry check.
        const stale: string[] = [];
        for (const rel of SONNER_PRIMITIVE_FILES) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) {
                stale.push(`${rel} (file deleted)`);
                continue;
            }
            const content = fs.readFileSync(abs, 'utf-8');
            if (!SONNER_IMPORT_RE.test(content)) {
                stale.push(`${rel} (no sonner import)`);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `Stale entries in SONNER_PRIMITIVE_FILES — remove them in the same diff that retires the file:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });
});
