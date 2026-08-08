/**
 * Epic 54 — cross-surface consistency guard.
 *
 * Every CRUD flow migrated in Epic 54 must share the same interaction
 * vocabulary so contributors learn the pattern once. This suite walks
 * the known migrated surfaces and asserts each one:
 *
 *   - imports the shared primitive (Modal or Sheet)
 *   - composes Header / Body / Actions (no bespoke layout)
 *   - guards close during in-flight mutation via `preventDefaultClose`
 *   - surfaces errors in an `alert`-role region
 *   - invalidates the relevant React-Query cache on success
 *
 * Adding a new modal? Add the file path to `MODAL_SURFACES` below — the
 * shared assertions run automatically. This keeps the consistency bar
 * visible instead of relying on review vigilance.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

interface ModalSurface {
    label: string;
    file: string;
    /**
     * The react-query key the surface invalidates on success. Empty
     * string means "N/A" (e.g. a local-only confirm dialog); in that
     * case the invalidation assertion is skipped.
     */
    cacheKey: string;
    /**
     * The size variant the surface is expected to use. Keeps modal
     * footprints uniform (sm for confirm, md for quick edit, lg for
     * CRUD forms).
     */
    expectedSize: 'sm' | 'md' | 'lg' | 'xl';
}

const MODAL_SURFACES: ModalSurface[] = [
    {
        label: 'Create Control',
        file: 'src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx',
        cacheKey: 'queryKeys.controls.all',
        expectedSize: 'lg',
    },
    {
        label: 'Upload Evidence',
        file: 'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
        // Epic 69 migrated this surface from React Query to
        // `useTenantMutation` + `swrMutate(matcher)` for sibling
        // filter fan-out. The `queryKeys.evidence.all` literal that
        // the consistency test pinned is gone — the modal now reads
        // from `CACHE_KEYS.evidence.list()`. Empty string disables
        // the invalidation assertion below; the SWR equivalent is
        // covered by `tests/unit/evidence-risks-swr-migration.test.ts`.
        cacheKey: '',
        expectedSize: 'lg',
    },
    {
        label: 'Add Text Evidence',
        file: 'src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx',
        cacheKey: 'queryKeys.evidence.all',
        expectedSize: 'lg',
    },
];

describe('Epic 54 — modal surface consistency', () => {
    describe.each(MODAL_SURFACES)('$label', (surface) => {
        const src = read(surface.file);

        it('is a client component', () => {
            expect(src).toMatch(/^'use client'/);
        });

        it('imports the shared <Modal> primitive', () => {
            expect(src).toMatch(/from ['"]@\/components\/ui\/modal['"]/);
            expect(src).not.toMatch(/fixed\s+inset-0[^"'`]*bg-black/);
        });

        it('composes Modal.Form + Modal.Body + Modal.Actions', () => {
            expect(src).toMatch(/<Modal\.Form\b/);
            expect(src).toMatch(/<Modal\.Body\b/);
            expect(src).toMatch(/<Modal\.Actions\b/);
        });

        it(`uses size="${surface.expectedSize}"`, () => {
            expect(src).toMatch(
                new RegExp(`size=["']${surface.expectedSize}["']`),
            );
        });

        it('guards close during an in-flight mutation', () => {
            expect(src).toMatch(/preventDefaultClose=\{/);
        });

        it('surfaces errors in a role="alert" region', () => {
            expect(src).toMatch(/role=["']alert["']/);
        });

        if (surface.cacheKey) {
            it(`invalidates ${surface.cacheKey} on success`, () => {
                const keyRe = new RegExp(
                    surface.cacheKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                );
                expect(src).toMatch(keyRe);
                expect(src).toMatch(/invalidateQueries/);
            });
        }
    });
});

// ─── Sheet surface(s) ────────────────────────────────────────────────

interface SheetSurface {
    label: string;
    file: string;
    expectedSize: 'sm' | 'md' | 'lg' | 'xl';
    cacheKey: string;
}

const SHEET_SURFACES: SheetSurface[] = [
    {
        label: 'Control detail sheet',
        file: 'src/app/t/[tenantSlug]/(app)/controls/ControlDetailSheet.tsx',
        expectedSize: 'md',
        cacheKey: 'queryKeys.controls.all',
    },
];

describe('Epic 54 — sheet surface consistency', () => {
    describe.each(SHEET_SURFACES)('$label', (surface) => {
        const src = read(surface.file);

        it('is a client component', () => {
            expect(src).toMatch(/^'use client'/);
        });

        it('imports the shared <Sheet> primitive', () => {
            expect(src).toMatch(/from ['"]@\/components\/ui\/sheet['"]/);
        });

        it('composes Sheet.Header + Sheet.Body + Sheet.Actions', () => {
            expect(src).toMatch(/<Sheet\.Header\b/);
            expect(src).toMatch(/<Sheet\.Body\b/);
            expect(src).toMatch(/<Sheet\.Actions\b/);
        });

        it(`uses size="${surface.expectedSize}"`, () => {
            expect(src).toMatch(
                new RegExp(`size=["']${surface.expectedSize}["']`),
            );
        });

        if (surface.cacheKey) {
            it(`invalidates ${surface.cacheKey} on save`, () => {
                const keyRe = new RegExp(
                    surface.cacheKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                );
                expect(src).toMatch(keyRe);
                expect(src).toMatch(/invalidateQueries/);
            });
        }
    });
});

// ─── Redirect shims ──────────────────────────────────────────────────
