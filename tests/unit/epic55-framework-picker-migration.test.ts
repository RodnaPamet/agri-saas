/**
 * Epic 55 Prompt 4 — framework + taxonomy picker migration.
 *
 * Asserts that every targeted native `<select>` has been replaced with
 * the shared `<Combobox>` and wired through `<FormField>`.
 *
 * Scope:
 *   1. Framework selector  — /audits/cycles/page.tsx  (#fw-select)
 *   3. Practice linker      — UploadEvidenceModal.tsx  (#practice-select)
 *   4. Practice linker      — NewEvidenceTextModal.tsx (#text-evidence-practice-select)
 *
 * Per surface we verify:
 *   - <Combobox> is imported and rendered.
 *   - The surface no longer contains a native <select ...id="..."> for
 *     the migrated picker.
 *   - The Combobox carries the preserved id (for E2E selectors) and a
 *     `name` attribute (for native <form onSubmit> serialisation).
 *   - `matchTriggerWidth` + `caret` are set so the trigger feels like
 *     a form field rather than a floating button.
 *   - Inside modals the Combobox auto-renders as a portalled dropdown
 *     (not a nested Vaul Drawer) via OverlayDepthContext (P3.2) — no
 *     manual `forceDropdown` opt-in is needed anymore.
 *   - The surface composes <FormField> around the Combobox so labels /
 *     descriptions / errors stay consistent with the rest of Epic 55.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const CYCLES_SRC = read('src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx');
const UPLOAD_SRC = read(
    'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
);
const TEXT_EV_SRC = read(
    'src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx',
);

interface MigrationSurface {
    label: string;
    src: string;
    pickerId: string;
    name: string;
    insideModal: boolean;
}

const SURFACES: MigrationSurface[] = [
    {
        label: 'audits/cycles — framework picker',
        src: CYCLES_SRC,
        pickerId: 'fw-select',
        name: 'frameworkKey',
        insideModal: false,
    },
    {
        label: 'UploadEvidenceModal — practice linker',
        src: UPLOAD_SRC,
        pickerId: 'practice-select',
        name: 'practiceId',
        insideModal: true,
    },
    {
        label: 'NewEvidenceTextModal — practice linker',
        src: TEXT_EV_SRC,
        pickerId: 'text-evidence-practice-select',
        name: 'practiceId',
        insideModal: true,
    },
];

describe('Epic 55 — framework + taxonomy picker migration', () => {
    describe.each(SURFACES)('$label', (surface) => {
        it('imports <Combobox> + ComboboxOption', () => {
            expect(surface.src).toMatch(
                /from ["']@\/components\/ui\/combobox["']/,
            );
            expect(surface.src).toMatch(/<Combobox\b/);
            expect(surface.src).toMatch(/ComboboxOption/);
        });

        it('imports <FormField>', () => {
            expect(surface.src).toMatch(
                /from ["']@\/components\/ui\/form-field["']/,
            );
            expect(surface.src).toMatch(/<FormField\b/);
        });

        it(`no longer renders a native <select id="${surface.pickerId}">`, () => {
            const selectRe = new RegExp(
                `<select[^>]*\\bid=["']${surface.pickerId}["']`,
            );
            expect(surface.src).not.toMatch(selectRe);
        });

        it(`Combobox preserves id="${surface.pickerId}" for existing E2E selectors`, () => {
            const re = new RegExp(`id=["']${surface.pickerId}["']`);
            expect(surface.src).toMatch(re);
        });

        it(`Combobox carries name="${surface.name}" for native form serialisation`, () => {
            const re = new RegExp(`name=["']${surface.name}["']`);
            expect(surface.src).toMatch(re);
        });

        it('uses matchTriggerWidth + caret so it reads as a form field', () => {
            expect(surface.src).toMatch(/matchTriggerWidth/);
            expect(surface.src).toMatch(/caret\b/);
        });

        if (surface.insideModal) {
            it('renders inside <Modal> so nested Comboboxes auto-dropdown (P3.2) — no manual forceDropdown', () => {
                // P3.2 retired the per-call-site `forceDropdown` nesting
                // opt-in. A Combobox inside <Modal> now auto-renders as a
                // portalled dropdown (not a nested Vaul Drawer) because
                // <Modal> wraps its children in OverlayDepthProvider.
                expect(surface.src).toMatch(/<Modal[\s.]/);
                expect(surface.src).not.toMatch(/forceDropdown/);
            });
        }
    });
});

// ─── audits/cycles framework options ─────────────────────────────

describe('audits/cycles — FW_OPTIONS shape', () => {
    it('exposes a FW_OPTIONS constant typed as ComboboxOption<{ version: string }>[]', () => {
        expect(CYCLES_SRC).toMatch(/FW_OPTIONS:\s*ComboboxOption<\{\s*version:\s*string\s*\}>\[\]/);
    });

    it('carries ISO27001 and NIS2 entries with full-text labels', () => {
        expect(CYCLES_SRC).toMatch(/value:\s*['"]ISO27001['"]/);
        expect(CYCLES_SRC).toMatch(/value:\s*['"]NIS2['"]/);
        expect(CYCLES_SRC).toMatch(/ISO\/IEC 27001:2022/);
        expect(CYCLES_SRC).toMatch(/NIS2 Directive \(EU 2022\/2555\)/);
    });

    it('passes meta.version through for downstream payload shaping', () => {
        expect(CYCLES_SRC).toMatch(/meta:\s*\{\s*version:\s*['"]2022['"]/);
        expect(CYCLES_SRC).toMatch(
            /meta:\s*\{\s*version:\s*['"]EU_2022_2555['"]/,
        );
    });
});

// ─── Practice linker — UploadEvidenceModal ───────────────────────

describe('UploadEvidenceModal — practice linker', () => {
    it('drops the external practiceSearch state (Combobox owns search)', () => {
        // Word-anchored so it still catches a reintroduced `practiceSearch`
        // state identifier, but not the T08 i18n key name
        // `upload.practiceSearchHint{Singular,Plural}` (no word boundary
        // before "Hint"), which legitimately contains the substring.
        expect(UPLOAD_SRC).not.toMatch(/\bpracticeSearch\b/);
    });

    it('drops the external filteredPractices memo', () => {
        expect(UPLOAD_SRC).not.toMatch(/filteredPractices/);
    });

    it('projects practices into ComboboxOption with annex/code/name folded into label', () => {
        expect(UPLOAD_SRC).toMatch(/practiceOptions\s*=\s*useMemo/);
        expect(UPLOAD_SRC).toMatch(
            /`\$\{c\.code \|\| 'Custom'\}: \$\{c\.name\}`/,
        );
    });

    it('surfaces the practice count in the FormField description', () => {
        // The description copy was migrated to next-intl (T08 i18n batch):
        // the `practices.length === 0` ternary now branches between the
        // `upload.noPracticesToLink` and `upload.practiceSearchHint{Singular,Plural}`
        // message keys instead of inline "Search across …" template literals.
        expect(UPLOAD_SRC).toMatch(
            /practices\.length\s*===\s*0[\s\S]{0,200}upload\.practiceSearchHint/,
        );
    });
});

// ─── Practice linker — NewEvidenceTextModal ──────────────────────

describe('NewEvidenceTextModal — practice linker', () => {
    it('projects practices into ComboboxOption', () => {
        expect(TEXT_EV_SRC).toMatch(/practiceOptions\s*=\s*useMemo/);
        expect(TEXT_EV_SRC).toMatch(
            /`\$\{c\.code \|\| 'Custom'\}: \$\{c\.name\}`/,
        );
    });

    it('wires setSelected into the update(practiceId) reducer', () => {
        expect(TEXT_EV_SRC).toMatch(
            /setSelected=\{\(option\)\s*=>\s*[\s\S]{0,80}update\(['"]practiceId['"],\s*option\?\.value\s*\?\?\s*['"]['"]\)/,
        );
    });
});

// ─── Cross-cutting: no stale ids / no leftover native selects ───

describe('Epic 55 Prompt 4 — no stale native selects for the migrated pickers', () => {
    it('UploadEvidenceModal no longer has a practice-search-input', () => {
        expect(UPLOAD_SRC).not.toMatch(/id=["']practice-search-input["']/);
    });

    it('all four migrated surfaces reference the Combobox id for E2E parity', () => {
        for (const surface of SURFACES) {
            const re = new RegExp(`id=["']${surface.pickerId}["']`);
            expect(surface.src).toMatch(re);
        }
    });
});
