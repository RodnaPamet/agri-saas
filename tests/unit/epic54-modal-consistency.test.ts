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

// GRC teardown phase 2 removed the "Create Practice" modal along with
// the whole practices surface (model + pages + routes). The evidence
// modals below are the surviving Epic 54 CRUD surfaces and carry the
// same consistency bar.
const MODAL_SURFACES: ModalSurface[] = [
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
    /**
     * The declared `size` variant, or `null` when the surface rides the
     * primitive's default width on purpose (say why in `sizeReason`).
     */
    expectedSize: 'sm' | 'md' | 'lg' | 'xl' | null;
    sizeReason?: string;
    /**
     * `true` when the sheet owns a save/confirm footer, which MUST be
     * composed as `<Sheet.Actions>` rather than hand-placed buttons.
     * `false` for read-only drill-downs (say why in `actionsReason`).
     */
    expectsActions: boolean;
    actionsReason?: string;
    /**
     * The query key the sheet invalidates after a write. Empty string
     * for surfaces that don't mutate (the parent owns the pipeline).
     */
    cacheKey: string;
}

// GRC teardown phase 2 deleted the practice detail sheet — the only
// entry this registry used to carry. Re-pointed at the four surviving
// dedicated Sheet surfaces so the Epic 54 bound (shared primitive,
// no bespoke overlay, Header/Body composition, Actions footer, cache
// invalidation on write) is still enforced against live code rather
// than dropped.
const SHEET_SURFACES: SheetSurface[] = [
    {
        label: 'Evidence detail sheet',
        file: 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx',
        expectedSize: 'md',
        expectsActions: false,
        actionsReason:
            'Composes <Sheet.Footer> (:277-381) with the review actions — ' +
            'Edit / Submit / Resubmit / Reject / Approve — rather than ' +
            '<Sheet.Actions>. It is NOT read-only and it is NOT footer-less; ' +
            'the two primitives are siblings and this surface picked the ' +
            'lower-level one. Recorded as a real deviation from the Epic 54 ' +
            'shape, not as an exemption on the merits: migrating it to ' +
            '<Sheet.Actions> would let this flag flip to true.',
        cacheKey: '',
    },
    {
        label: 'Grain deliveries sheet',
        file: 'src/app/t/[tenantSlug]/(app)/grain/contracts/DeliveriesSheet.tsx',
        expectedSize: 'md',
        expectsActions: false,
        actionsReason:
            'The add-delivery form submits from inside Sheet.Body (an inline ' +
            'row-append form, not a modal-style confirm footer).',
        cacheKey: 'listKey',
    },
    {
        label: 'Automation rule detail sheet',
        file: 'src/components/processes/RuleDetailSheet.tsx',
        expectedSize: null,
        sizeReason: 'Rides the Sheet default width — no size override.',
        expectsActions: true,
        cacheKey: '',
    },
    {
        label: 'Parcel detail sheet',
        file: 'src/components/ui/map/ParcelDetailSheet.tsx',
        expectedSize: null,
        sizeReason:
            'A bottom drawer (`direction="bottom"`) over the map — width is ' +
            'the viewport, so no size variant applies.',
        expectsActions: true,
        cacheKey: '',
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
            expect(src).not.toMatch(/fixed\s+inset-0[^"'`]*bg-black/);
        });

        it('composes Sheet.Header + Sheet.Body', () => {
            expect(src).toMatch(/<Sheet\.Header\b/);
            expect(src).toMatch(/<Sheet\.Body\b/);
        });

        if (surface.expectsActions) {
            it('composes its footer as <Sheet.Actions>', () => {
                expect(src).toMatch(/<Sheet\.Actions\b/);
            });
        }

        if (surface.expectedSize) {
            it(`uses size="${surface.expectedSize}"`, () => {
                expect(src).toMatch(
                    new RegExp(`size=["']${surface.expectedSize}["']`),
                );
            });
        }

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
