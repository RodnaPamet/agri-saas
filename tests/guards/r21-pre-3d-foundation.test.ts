/**
 * R21-PR-E — 3D foundation ratchet (STUB SCAFFOLD).
 *
 * ### Status
 *
 * PR-E originally shipped a live @react-three/fiber integration.
 * A compatibility deadlock between r3f's two release lines and
 * React 19 forced PR-E to land as a STUB SCAFFOLD instead:
 *
 *   - r3f v9 (React 19-compatible) augments global JSX in a way
 *     that breaks vanilla HTML JSX inference across 200+ files
 *     under our tsconfig.
 *   - r3f v8 (no JSX pollution) was built for React 18 and
 *     crashes at module load under React 19 (uses removed
 *     `ReactCurrentOwner` internal API).
 *
 * Real 3D rendering moves to a follow-up roadmap when r3f's
 * React 19 story stabilises. PR-E ships the API shape +
 * documentation so PR-F's `<BarField3D>` (and future 3D charts)
 * can target the eventual renderer without API churn.
 *
 * ### What this ratchet now locks
 *
 *   1. The stub `<Chart3D>` exists, is a client component, renders
 *      the FallbackComponent when supplied, otherwise a placeholder
 *      div. NO @react-three/fiber import (the deadlock).
 *
 *   2. `Chart3DProps` API contract is stable — every prop the
 *      eventual renderer will consume is documented here.
 *
 *   3. `tokenColor()` works today — resolves chart-series CSS
 *      vars to hex strings. Load-bearing for any future 3D
 *      renderer.
 *
 *   4. `dynamicChart3D()` SSR-safe wrapper returns the stub
 *      today; consumers use it now so the future swap is
 *      transparent.
 *
 *   5. The barrel re-exports the API surface so consumers import
 *      from a single entry.
 *
 *   6. Documentation: the stub's head matter explains the
 *      compatibility deadlock so a future engineer understands
 *      why r3f isn't a dependency yet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
);
const CHART_3D = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/chart-3d.tsx'),
    'utf8',
);
const CHART_3D_DYNAMIC = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/chart-3d-dynamic.ts'),
    'utf8',
);
const BARREL = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/charts/index.ts'),
    'utf8',
);

describe('R21-PR-E — 3D foundation (stub scaffold)', () => {
    describe('NO @react-three/fiber dependency yet', () => {
        // The compatibility deadlock blocks landing r3f in this
        // codebase under React 19. PR-E is a SCAFFOLD — when r3f's
        // React 19 story stabilises, a follow-up adds the dep
        // back and swaps Chart3D's inner branch.
        it('@react-three/fiber is NOT in dependencies', () => {
            expect(PKG.dependencies?.['@react-three/fiber']).toBeUndefined();
        });
        it('@react-three/drei is NOT in dependencies', () => {
            expect(PKG.dependencies?.['@react-three/drei']).toBeUndefined();
        });
        it('three is NOT in dependencies', () => {
            expect(PKG.dependencies?.['three']).toBeUndefined();
        });
    });

    describe('Chart3D stub primitive', () => {
        it('is a client component', () => {
            expect(CHART_3D.split('\n')[0]).toMatch(/^'use client'/);
        });

        it('does NOT import from @react-three/fiber (deadlock-blocked)', () => {
            // The deadlock explanation in the file head matter
            // matters — a future r3f import here without
            // reverting the deadlock would crash module load
            // under React 19.
            expect(CHART_3D).not.toMatch(/from\s+['"]@react-three\/fiber['"]/);
        });

        it('exposes Chart3DProps with the eventual renderer\'s contract', () => {
            // The API shape is the load-bearing part — when the
            // real renderer lands, it satisfies THIS interface.
            expect(CHART_3D).toMatch(/export\s+interface\s+Chart3DProps/);
            expect(CHART_3D).toMatch(/ariaLabel:\s*string;/);
            expect(CHART_3D).toMatch(/FallbackComponent\?:/);
            expect(CHART_3D).toMatch(/cameraPosition\?:/);
            expect(CHART_3D).toMatch(/idleRotateSpeed\?:/);
            expect(CHART_3D).toMatch(/minPolarAngle\?:/);
            expect(CHART_3D).toMatch(/maxPolarAngle\?:/);
        });

        it('renders FallbackComponent when supplied, placeholder otherwise', () => {
            // Stub branch: FallbackComponent → render it.
            // No fallback → data-attributed placeholder div.
            expect(CHART_3D).toMatch(/if\s*\(FallbackComponent\)/);
            expect(CHART_3D).toMatch(/<FallbackComponent\s*\/>/);
            expect(CHART_3D).toMatch(/data-chart-3d-fallback="true"/);
            expect(CHART_3D).toMatch(/data-chart-3d="true"/);
        });

        it('emits data-chart-3d-status="stub" so consumers can detect the scaffold state', () => {
            // A consumer (or rendered test) can read this attr to
            // know whether the real renderer or the stub is
            // mounted. When the real renderer lands, this attr
            // either changes value or goes away.
            expect(CHART_3D).toMatch(/data-chart-3d-status="stub"/);
        });

        it('exposes tokenColor() helper for chart-series → hex bridging', () => {
            // This piece WORKS today — pure CSS-var resolution, no
            // 3D dependency. Future renderer uses it; current 2D
            // consumers that need a resolved series colour can too.
            expect(CHART_3D).toMatch(/export\s+function\s+tokenColor/);
            expect(CHART_3D).toMatch(/--chart-series-/);
            expect(CHART_3D).toMatch(/getComputedStyle/);
            expect(CHART_3D).toMatch(/typeof window === 'undefined'/);
        });

        it('consults the SHARED reduced-motion hook', () => {
            // Re-aimed in #1471, at the condition this test's own comment set:
            // "promote to a shared hook when a second consumer lands". Three
            // landed — `popover`, `scroll-to-top`, and a third private copy in
            // `chart-motion` — so the inline hook was promoted away.
            //
            // The assertion now names the PROPERTY (this chart respects
            // reduced motion) rather than the MECHANISM (it defines an inline
            // function). The old form would have failed the promotion it
            // asked for, which is a guard aimed one level off its subject.
            expect(CHART_3D).toMatch(/useReducedMotion\(\)/);
            expect(CHART_3D).toMatch(/from '@\/components\/ui\/hooks'/);
            expect(CHART_3D).not.toMatch(/function\s+useReducedMotion/);
        });
    });

    describe('dynamicChart3D() SSR-safe wrapper', () => {
        it('imports next/dynamic', () => {
            expect(CHART_3D_DYNAMIC).toMatch(
                /from\s+['"]next\/dynamic['"]/,
            );
        });
        it('disables SSR — the eventual renderer will need this', () => {
            expect(CHART_3D_DYNAMIC).toMatch(/ssr:\s*false/);
        });
        it('lazy-imports the Chart3D component', () => {
            expect(CHART_3D_DYNAMIC).toMatch(
                /import\(['"]\.\/chart-3d['"]\)\.then\(\(m\)\s*=>\s*m\.Chart3D\)/,
            );
        });
    });

    describe('barrel re-exports', () => {
        it('re-exports Chart3D + Chart3DProps + tokenColor + dynamicChart3D', () => {
            expect(BARREL).toMatch(
                /export\s+\{\s*Chart3D,\s*tokenColor\s*\}/,
            );
            expect(BARREL).toMatch(/export\s+type\s+\{\s*Chart3DProps\s*\}/);
            expect(BARREL).toMatch(
                /export\s+\{\s*dynamicChart3D\s*\}/,
            );
        });
    });

    describe('documentation — the deadlock is documented at the file head', () => {
        // A future engineer reading chart-3d.tsx needs to know
        // WHY r3f isn't a dependency, or they'll re-add it and
        // re-trigger the deadlock.
        it('mentions the React 19 + r3f compatibility deadlock', () => {
            expect(CHART_3D).toMatch(/react-three\/fiber/);
            expect(CHART_3D).toMatch(/React 19/);
            expect(CHART_3D).toMatch(/STUB/i);
        });
    });
});
