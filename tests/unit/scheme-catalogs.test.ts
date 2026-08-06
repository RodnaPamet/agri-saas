/**
 * Validity of the concept-only certification-scheme catalogs that
 * `scripts/import-schemes.ts` (`npm run schemes:import`) applies.
 *
 * Loads + cross-validates each YAML against `CatalogFileSchema` (no DB),
 * and asserts the cross-links the schema alone can't (the
 * AUTO_EVIDENCE_RULES requirement codes really exist in the catalogs, the
 * frameworks are AG_SCHEME, the text is marked illustrative).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidateCatalogFile,
    CatalogValidationError,
} from '../../prisma/catalog-loader';
import { AUTO_EVIDENCE_RULES } from '@/app-layer/usecases/auto-evidence';

const CATALOG_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'catalogs');

/**
 * EVERY catalogue on disk, discovered rather than listed.
 *
 * A hardcoded list can only assert about the files someone remembered to add
 * to it — and the seeder had the same hardcoding, which is exactly how two of
 * the four shipped catalogues came to be loaded by nothing automated. Reading
 * the directory means a new YAML is tested the moment it lands.
 */
const SCHEME_FILES = fs
    .readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .filter((f) => {
        // ISO 27001 is a compliance framework, not an AG_SCHEME — the
        // AG-specific assertions below do not apply to it.
        const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, f));
        return file.framework.kind === 'AG_SCHEME';
    })
    .sort();

describe('scheme catalogs — load + validate', () => {
    test.each(SCHEME_FILES)('%s parses + cross-validates against CatalogFileSchema', (fileName) => {
        const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, fileName));

        // Each scheme is an AG_SCHEME framework with ≥1 requirement + a pack.
        expect(file.framework.kind).toBe('AG_SCHEME');
        expect(file.requirements.length).toBeGreaterThan(0);
        expect(file.pack).toBeDefined();

        // LICENSE hygiene. This used to be a prose match for
        // /illustrative|concept|paraphrased/ on the description — which is
        // English-only, and silently un-assertable for a Bulgarian catalogue
        // whose description is in Bulgarian. The marker is now STRUCTURED:
        // `isDemo` is a boolean the UI can badge, so the check is
        // language-independent and the thing it asserts is the thing users
        // actually see.
        expect(file.framework.isDemo).toBe(true);
        // The description still has to say so in its own language, because the
        // flag renders as a badge and the description is what a reader reads.
        expect(file.framework.description ?? '').toMatch(
            /illustrative|concept|paraphrased|демонстрац|илюстрат/i,
        );
    });

    it('GlobalG.A.P. catalog defines the CB.7 plant-protection requirement codes', () => {
        const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, 'globalgap-ifa-demo.yaml'));
        expect(file.framework.key).toBe('GLOBALGAP-IFA-DEMO');
        const codes = new Set(file.requirements.map((r) => r.code));
        for (const c of ['CB.7.1', 'CB.7.6', 'CB.7.9']) {
            expect(codes.has(c)).toBe(true);
        }
    });

    it('EU-Organic catalog defines the permitted-input + records codes', () => {
        const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, 'eu-organic-2018-848-demo.yaml'));
        expect(file.framework.key).toBe('EU-ORGANIC-2018-848-DEMO');
        const codes = new Set(file.requirements.map((r) => r.code));
        for (const c of ['EUO.2', 'EUO.3']) {
            expect(codes.has(c)).toBe(true);
        }
    });

    it('found catalogues to check (self-check)', () => {
        // A broken directory read would make every assertion above vacuous.
        expect(SCHEME_FILES.length).toBeGreaterThan(0);
    });

    it('every catalogue declares whether it is a demo subset', () => {
        // The YAMLs said so in header COMMENTS, which reach no user. Declared
        // as data, `isDemo` badges the scheme in the UI and `coverageNote`
        // says how partial it is — so a farmer mapping their practices to 7
        // control points is told those 7 are not the standard.
        for (const fileName of SCHEME_FILES) {
            const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, fileName));
            expect(typeof file.framework.isDemo).toBe('boolean');
            if (file.framework.isDemo) {
                expect((file.framework.coverageNote ?? '').length).toBeGreaterThan(0);
            }
        }
    });

    it('every catalogue carries a source URN (provenance)', () => {
        // `sourceUrn` and `contentHash` have existed on the model since it was
        // created and nothing ever set them — zero provenance on a document a
        // certifier is handed.
        for (const fileName of SCHEME_FILES) {
            const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, fileName));
            expect((file.framework.sourceUrn ?? '').length).toBeGreaterThan(0);
        }
    });

    it('every AUTO_EVIDENCE_RULES requirement code exists in its catalog', () => {
        // Index catalog codes by framework key.
        const byFramework = new Map<string, Set<string>>();
        for (const fileName of SCHEME_FILES) {
            const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, fileName));
            byFramework.set(file.framework.key, new Set(file.requirements.map((r) => r.code)));
        }

        for (const rules of Object.values(AUTO_EVIDENCE_RULES)) {
            for (const rule of rules ?? []) {
                const catalogCodes = byFramework.get(rule.frameworkKey);
                expect(catalogCodes).toBeDefined();
                for (const code of rule.requirementCodes) {
                    expect(catalogCodes!.has(code)).toBe(true);
                }
            }
        }
    });

    it('every catalogue advertising auto-evidence HAS an auto-evidence rule', () => {
        // The REVERSE direction, which was never asserted. The forward check
        // (rule → catalogue) only proves the codes a rule names exist; it is
        // silent when a catalogue promises "auto-evidence from farm records"
        // in its own description and no rule ever fires for it. Two shipped
        // catalogues did exactly that, carrying perfectly good
        // pre-harvest-interval and application-record control points that
        // nothing ever satisfied.
        const covered = new Set(
            Object.values(AUTO_EVIDENCE_RULES)
                .flatMap((rules) => rules ?? [])
                .map((r) => r.frameworkKey),
        );

        const advertising: string[] = [];
        for (const fileName of SCHEME_FILES) {
            const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, fileName));
            const text = `${file.framework.description ?? ''}`.toLowerCase();
            if (/auto-evidence|auto evidence|автоматич/.test(text)) {
                advertising.push(file.framework.key);
            }
        }

        for (const key of advertising) {
            expect(covered.has(key)).toBe(true);
        }
    });
});

