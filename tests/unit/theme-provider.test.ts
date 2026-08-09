/**
 * Epic 51 — theme provider + toggle contract.
 *
 * Jest runs under `testEnvironment: 'node'` so we cannot runtime-load
 * `ThemeProvider.tsx` (tsconfig `jsx: "preserve"`). This suite verifies the
 * observable contract by source inspection — the same pattern used by every
 * other React-layer test in the filter module.
 *
 * Guards:
 *   - ThemeProvider exports the documented hook + provider.
 *   - The storage key, attribute name, and fallback ordering are stable.
 *   - ThemeToggle renders a token-driven icon button with accessible labels.
 *   - The provider mounts inside `<Providers>` so every app page can call
 *     `useTheme()`.
 *   - globals.css legacy `--bg-primary` / `--brand` aliases resolve to the
 *     canonical semantic tokens.
 *   - layout.tsx seeds `data-theme="dark"` so SSR and first-client-paint
 *     agree on the baseline palette.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('ThemeProvider — source contract', () => {
    const src = read('src/components/theme/ThemeProvider.tsx');

    it('is a client module with named exports (no default)', () => {
        expect(src).toMatch(/^'use client'/);
        expect(src).toMatch(/export function ThemeProvider/);
        expect(src).toMatch(/export function useTheme/);
        expect(src).not.toMatch(/^export default/m);
    });

    it('persists user choice under a namespaced localStorage key', () => {
        expect(src).toMatch(/STORAGE_KEY\s*=\s*['"]inflect:theme['"]/);
    });

    it('flips the html[data-theme] attribute (not a class) so tokens.css matches', () => {
        expect(src).toMatch(/ATTR\s*=\s*['"]data-theme['"]/);
        expect(src).toMatch(/setAttribute\(ATTR/);
    });

    it('resolves initial theme in the documented order: storage → media → dark', () => {
        expect(src).toMatch(/localStorage\.getItem\(STORAGE_KEY\)/);
        expect(src).toMatch(/prefers-color-scheme: light/);
        // Dark is the documented fallback.
        expect(src).toMatch(/return\s+['"]dark['"]/);
    });

    it('`useTheme()` is safe outside a provider (SSR-friendly no-op fallback)', () => {
        // The fallback branch returns a value object with a no-op setter.
        expect(src).toMatch(/setTheme:\s*\(\)\s*=>\s*\{\}/);
        expect(src).toMatch(/toggle:\s*\(\)\s*=>\s*\{\}/);
    });

    it('tolerates localStorage throwing (private/sandboxed contexts)', () => {
        // The module wraps both read and write in try/catch.
        expect(src).toMatch(/catch\s*\{/);
    });
});

describe('ThemeToggle — accessible control', () => {
    const src = read('src/components/theme/ThemeToggle.tsx');

    it('is a client button with an accessible label naming the action', () => {
        // The toggle cycles dark → light → sunlight (feat/delight-personality),
        // so it carries an aria-label that names the action rather than a
        // binary aria-pressed (which only models a two-state control).
        expect(src).toMatch(/^'use client'/);
        expect(src).toMatch(/aria-label=/);
        expect(src).toMatch(/sunlight/);
    });

    it('swaps the Sun/Moon icon based on the active theme', () => {
        // The component imports both icons from lucide-react and renders one
        // based on the `theme` state. Match both symbols anywhere in the file.
        expect(src).toMatch(/\bSun\b/);
        expect(src).toMatch(/\bMoon\b/);
        expect(src).toMatch(/lucide-react/);
    });

    it('uses the shared .icon-btn token-driven class', () => {
        expect(src).toMatch(/icon-btn/);
    });

    it('carries a deterministic id default and a testid for E2E', () => {
        expect(src).toMatch(/id:\s*string|id\?:\s*string/);
        expect(src).toMatch(/data-testid=["']theme-toggle["']/);
    });
});

describe('Providers wiring — ThemeProvider mounts inside the app shell', () => {
    const providers = read('src/app/providers.tsx');
    it('wraps the NextAuth session boundary', () => {
        expect(providers).toMatch(/from ['"]@\/components\/theme\/ThemeProvider['"]/);
        expect(providers).toMatch(/<ThemeProvider\b/);
    });

    it('root layout seeds data-theme="dark" for SSR / first paint', () => {
        const layout = read('src/app/layout.tsx');
        expect(layout).toMatch(/data-theme=["']dark["']/);
    });
});

describe('globals.css — legacy → semantic alias bridge', () => {
    const src = read('src/app/globals.css');

    it('delegates --bg-primary / --text-primary to the semantic tokens', () => {
        expect(src).toMatch(/--bg-primary:\s*var\(--bg-page\)/);
        expect(src).toMatch(/--text-primary:\s*var\(--content-emphasis\)/);
    });

    it('delegates --brand to the semantic brand token', () => {
        expect(src).toMatch(/--brand:\s*var\(--brand-default\)/);
    });

    it('.btn-* rules consume the shared palette (no raw slate/emerald/red numerics)', () => {
        // Capture the .btn block and assert it no longer uses raw
        // Tailwind color classes from the dark-only palette.
        const btnBlock = src.split(/\.btn-primary/)[1]?.split(/\/\* Inputs/)[0] ?? '';
        expect(btnBlock).toMatch(/var\(--/);
        // None of the old raw-class references should survive in the .btn block.
        expect(btnBlock).not.toMatch(/bg-slate-/);
        expect(btnBlock).not.toMatch(/bg-brand-600/);
    });

    it('.badge-* CSS classes are retired (PR-2 — every site migrated to <StatusBadge>)', () => {
        // The legacy `.badge` / `.badge-success` / `.badge-warning` /
        // `.badge-danger` / `.badge-info` / `.badge-neutral` CSS classes
        // were deleted from globals.css in PR-2. Every call site now
        // uses `<StatusBadge variant="…">` from
        // `src/components/ui/status-badge.tsx`. Forward enforcement
        // lives in `tests/guards/legacy-badge-eradication.test.ts`.
        expect(src).not.toMatch(/^\s*\.badge\s*\{/m);
        expect(src).not.toMatch(/^\s*\.badge-success\s*\{/m);
        expect(src).not.toMatch(/^\s*\.badge-danger\s*\{/m);
    });

    it('.glass-card picks up --glass-bg / --glass-border so theme toggle flips glass too', () => {
        expect(src).toMatch(/\.glass-card[^}]*background:\s*var\(--glass-bg\)/);
        expect(src).toMatch(/\.glass-card[^}]*border:\s*1px solid var\(--glass-border\)/);
    });
});
