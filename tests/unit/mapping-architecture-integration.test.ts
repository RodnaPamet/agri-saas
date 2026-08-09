/**
 * Mapping Architecture Integration Tests
 *
 * End-to-end validation of the full mapping migration stack:
 * YAML parsing → resolution engine → traceability → gap analysis
 *
 * These tests verify that all layers compose correctly without a database.
 * They use the mapping-set YAML parser + in-memory edge loaders to simulate
 * the full lifecycle from YAML definition to product-level gap analysis.
 *
 * Test scenarios:
 * 1. YAML parsing feeds resolution engine correctly
 * 2. Traceability report correctly interprets resolution output
 * 3. Gap analysis produces conservative, correct status for each requirement
 * 4. Deterministic output across the full pipeline
 * 5. Real YAML file validation (iso27001-to-nist-csf.yaml)
 * 6. Mapping strength semantics hold end-to-end
 */

import * as path from 'path';
import {
    parseMappingSetFile,
    parseMappingSetString,
    computeMappingSetHash,
    scanMappingSetDirectory,
    type StoredMappingSet,
} from '@/app-layer/services/mapping-set-importer';
import {
    resolveMapping,
    resolveMappingBatch,
    type MappingEdgeLoader,
} from '@/app-layer/services/mapping-resolution';
import {
    buildTraceabilityReport,
    analyzeGaps,
    strengthToConfidence,
    determineGapStatus,
    isActionableCoverage,
} from '@/app-layer/services/cross-framework-traceability';
import type { ResolvedMappingEdge, MappingStrengthValue } from '@/app-layer/domain/requirement-mapping.types';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeEdge(
    id: string,
    source: { reqId: string; code: string; title: string; fwKey: string; fwName: string },
    target: { reqId: string; code: string; title: string; fwKey: string; fwName: string },
    strength: MappingStrengthValue,
    rationale: string = '',
): ResolvedMappingEdge {
    return {
        id, strength, rationale,
        source: {
            requirementId: source.reqId, requirementCode: source.code,
            requirementTitle: source.title, frameworkId: `fw-${source.fwKey}`,
            frameworkKey: source.fwKey, frameworkName: source.fwName,
        },
        target: {
            requirementId: target.reqId, requirementCode: target.code,
            requirementTitle: target.title, frameworkId: `fw-${target.fwKey}`,
            frameworkKey: target.fwKey, frameworkName: target.fwName,
        },
    };
}

// ═════════════════════════════════════════════════════════════════════
// Integration Scenario: Multi-Framework Compliance Traceability
// ═════════════════════════════════════════════════════════════════════
//
// Scenario: A customer is ISO 27001 certified and wants to understand
// their readiness for NIST CSF 2.0. They also want to see how their
// NIST coverage might translate to SOC 2.
//
// Graph:
//   ISO A.5.1  ──EQUAL──▶   NIST GV.OC-01  ──SUPERSET──▶  SOC2 CC1
//   ISO A.5.2  ──SUBSET──▶  NIST GV.RM-01
//   ISO A.5.15 ──INTERSECT──▶ NIST PR.AA-01
//   ISO A.5.24 ──RELATED──▶ NIST RS.MA-01

const ISO = { fwKey: 'ISO27001', fwName: 'ISO 27001' };
const NIST = { fwKey: 'NIST-CSF', fwName: 'NIST CSF 2.0' };
const SOC2 = { fwKey: 'SOC2', fwName: 'SOC 2' };

const isoA51 = { reqId: 'iso-a51', code: 'A.5.1', title: 'Info Security Policies', ...ISO };
const isoA52 = { reqId: 'iso-a52', code: 'A.5.2', title: 'Info Security Roles', ...ISO };
const isoA515 = { reqId: 'iso-a515', code: 'A.5.15', title: 'Access Control', ...ISO };
const isoA524 = { reqId: 'iso-a524', code: 'A.5.24', title: 'Incident Planning', ...ISO };

const nistGvOc = { reqId: 'nist-gvoc01', code: 'GV.OC-01', title: 'Org Context', ...NIST };
const nistGvRm = { reqId: 'nist-gvrm01', code: 'GV.RM-01', title: 'Risk Management', ...NIST };
const nistPrAa = { reqId: 'nist-praa01', code: 'PR.AA-01', title: 'Access Auth', ...NIST };
const nistRsMa = { reqId: 'nist-rsma01', code: 'RS.MA-01', title: 'Incident Mgmt', ...NIST };

const soc2Cc1 = { reqId: 'soc2-cc1', code: 'CC1', title: 'Practice Environment', ...SOC2 };

const INTEGRATION_EDGES: Record<string, ResolvedMappingEdge[]> = {
    'iso-a51':    [makeEdge('e1', isoA51, nistGvOc, 'EQUAL', 'Equivalent governance')],
    'iso-a52':    [makeEdge('e2', isoA52, nistGvRm, 'SUBSET', 'Partial risk coverage')],
    'iso-a515':   [makeEdge('e3', isoA515, nistPrAa, 'INTERSECT', 'Overlapping access scope')],
    'iso-a524':   [makeEdge('e4', isoA524, nistRsMa, 'RELATED', 'Conceptual link')],
    'nist-gvoc01': [makeEdge('e5', nistGvOc, soc2Cc1, 'SUPERSET', 'NIST broader than SOC2')],
};

const integrationLoader: MappingEdgeLoader = async (id) => INTEGRATION_EDGES[id] ?? [];

// ═════════════════════════════════════════════════════════════════════

describe('Mapping Architecture Integration', () => {
    // ─── YAML → Resolution Pipeline ─────────────────────────────
    describe('YAML parsing → resolution engine', () => {
        it('parses the real iso27001-to-nist-csf.yaml file without error', () => {
            const yamlPath = path.resolve(__dirname, '../../src/data/libraries/mappings/iso27001-to-nist-csf.yaml');
            const stored = parseMappingSetFile(yamlPath);

            expect(stored.urn).toBe('urn:inflect:mappingset:iso27001-to-nist-csf');
            expect(stored.source_framework_ref).toBe('ISO27001-2022');
            expect(stored.target_framework_ref).toBe('NIST-CSF-2.0');
            expect(stored.mapping_entries.length).toBeGreaterThan(0);
        });

        it('all entries in the real YAML have valid strengths', () => {
            const yamlPath = path.resolve(__dirname, '../../src/data/libraries/mappings/iso27001-to-nist-csf.yaml');
            const stored = parseMappingSetFile(yamlPath);

            const validStrengths = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];
            for (const entry of stored.mapping_entries) {
                expect(validStrengths).toContain(entry.strength);
            }
        });

        it('produces stable content hash for the real YAML', () => {
            const yamlPath = path.resolve(__dirname, '../../src/data/libraries/mappings/iso27001-to-nist-csf.yaml');
            const stored = parseMappingSetFile(yamlPath);

            const hash1 = computeMappingSetHash(stored);
            const hash2 = computeMappingSetHash(stored);
            expect(hash1).toBe(hash2);
            expect(hash1).toHaveLength(64); // SHA-256 hex
        });

        it('scans the mappings directory and finds all mapping files', () => {
            const mappingsDir = path.resolve(__dirname, '../../src/data/libraries/mappings');
            const results = scanMappingSetDirectory(mappingsDir);

            expect(results.length).toBeGreaterThanOrEqual(4);
            expect(results.find(r => r.stored.urn === 'urn:inflect:mappingset:iso27001-to-nist-csf')).toBeDefined();
            expect(results.find(r => r.stored.urn === 'urn:inflect:mappingset:iso27001-to-soc2')).toBeDefined();
            expect(results.find(r => r.stored.urn === 'urn:inflect:mappingset:nist-csf-to-soc2')).toBeDefined();
            expect(results.find(r => r.stored.urn === 'urn:inflect:mappingset:nis2-to-iso27001')).toBeDefined();
        });
    });

    // ─── ISO 27001 → SOC 2 YAML Validation ──────────────────────
    describe('ISO 27001 → SOC 2 YAML', () => {
        const yamlPath = path.resolve(__dirname, '../../src/data/libraries/mappings/iso27001-to-soc2.yaml');
        let stored: StoredMappingSet;

        beforeAll(() => {
            stored = parseMappingSetFile(yamlPath);
        });

        it('parses successfully with correct metadata', () => {
            expect(stored.urn).toBe('urn:inflect:mappingset:iso27001-to-soc2');
            expect(stored.source_framework_ref).toBe('ISO27001-2022');
            expect(stored.target_framework_ref).toBe('SOC2-2017');
            expect(stored.version).toBe(1);
        });

        it('has substantial mapping coverage', () => {
            expect(stored.mapping_entries.length).toBeGreaterThanOrEqual(20);
        });

        it('all entries have valid strengths', () => {
            const validStrengths = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];
            for (const entry of stored.mapping_entries) {
                expect(validStrengths).toContain(entry.strength);
            }
        });

        it('all entries have rationale', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.rationale).toBeTruthy();
                expect(entry.rationale!.length).toBeGreaterThan(10);
            }
        });

        it('uses conservative strengths (no EQUAL — ISO prescriptive vs SOC 2 principle-based)', () => {
            // ISO and SOC 2 have fundamentally different structures, so EQUAL should not appear
            const equalEntries = stored.mapping_entries.filter(e => e.strength === 'EQUAL');
            expect(equalEntries).toHaveLength(0);
        });

        it('all source refs look like ISO practices', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.source_ref).toMatch(/^A\.\d+\.\d+$/);
            }
        });

        it('all target refs look like SOC 2 criteria', () => {
            const soc2Pattern = /^(CC\d+\.\d+|A1|C1|PI1|P1)$/;
            for (const entry of stored.mapping_entries) {
                expect(entry.target_ref).toMatch(soc2Pattern);
            }
        });

        it('produces stable content hash', () => {
            const h1 = computeMappingSetHash(stored);
            const h2 = computeMappingSetHash(stored);
            expect(h1).toBe(h2);
            expect(h1).toHaveLength(64);
        });

        it('covers key SOC 2 criteria', () => {
            const targetRefs = new Set(stored.mapping_entries.map(e => e.target_ref));
            expect(targetRefs.has('CC6.1')).toBe(true);  // Logical Access
            expect(targetRefs.has('CC7.1')).toBe(true);  // System Monitoring
            expect(targetRefs.has('CC8.1')).toBe(true);  // Change Management
            expect(targetRefs.has('A1')).toBe(true);     // Availability
        });
    });

    // ─── NIST CSF → SOC 2 YAML Validation ───────────────────────
    describe('NIST CSF 2.0 → SOC 2 YAML', () => {
        const yamlPath = path.resolve(__dirname, '../../src/data/libraries/mappings/nist-csf-to-soc2.yaml');
        let stored: StoredMappingSet;

        beforeAll(() => {
            stored = parseMappingSetFile(yamlPath);
        });

        it('parses successfully with correct metadata', () => {
            expect(stored.urn).toBe('urn:inflect:mappingset:nist-csf-to-soc2');
            expect(stored.source_framework_ref).toBe('NIST-CSF-2.0');
            expect(stored.target_framework_ref).toBe('SOC2-2017');
            expect(stored.version).toBe(1);
        });

        it('has meaningful mapping coverage', () => {
            expect(stored.mapping_entries.length).toBeGreaterThanOrEqual(10);
        });

        it('all entries have valid strengths', () => {
            const validStrengths = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];
            for (const entry of stored.mapping_entries) {
                expect(validStrengths).toContain(entry.strength);
            }
        });

        it('all entries have rationale', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.rationale).toBeTruthy();
                expect(entry.rationale!.length).toBeGreaterThan(10);
            }
        });

        it('all source refs look like NIST subcategories', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.source_ref).toMatch(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/);
            }
        });

        it('covers all NIST CSF functions', () => {
            const sourceRefs = stored.mapping_entries.map(e => e.source_ref);
            // GV (Govern), ID (Identify), PR (Protect), DE (Detect), RS (Respond), RC (Recover)
            expect(sourceRefs.some(r => r.startsWith('GV.'))).toBe(true);
            expect(sourceRefs.some(r => r.startsWith('ID.'))).toBe(true);
            expect(sourceRefs.some(r => r.startsWith('PR.'))).toBe(true);
            expect(sourceRefs.some(r => r.startsWith('DE.'))).toBe(true);
            expect(sourceRefs.some(r => r.startsWith('RS.'))).toBe(true);
            expect(sourceRefs.some(r => r.startsWith('RC.'))).toBe(true);
        });

        it('produces stable content hash', () => {
            const h1 = computeMappingSetHash(stored);
            const h2 = computeMappingSetHash(stored);
            expect(h1).toBe(h2);
            expect(h1).toHaveLength(64);
        });
    });

    // ─── NIS2 → ISO 27001 YAML Validation ────────────────────────
    describe('NIS2 → ISO 27001 YAML', () => {
        const yamlPath = path.resolve(__dirname, '../../src/data/libraries/mappings/nis2-to-iso27001.yaml');
        let stored: StoredMappingSet;

        beforeAll(() => {
            stored = parseMappingSetFile(yamlPath);
        });

        it('parses successfully with correct metadata', () => {
            expect(stored.urn).toBe('urn:inflect:mappingset:nis2-to-iso27001');
            expect(stored.source_framework_ref).toBe('NIS2-2022');
            expect(stored.target_framework_ref).toBe('ISO27001-2022');
            expect(stored.version).toBe(1);
        });

        it('has substantial mapping coverage', () => {
            expect(stored.mapping_entries.length).toBeGreaterThanOrEqual(15);
        });

        it('all entries have valid strengths', () => {
            const validStrengths = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];
            for (const entry of stored.mapping_entries) {
                expect(validStrengths).toContain(entry.strength);
            }
        });

        it('all entries have rationale', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.rationale).toBeTruthy();
                expect(entry.rationale!.length).toBeGreaterThan(10);
            }
        });

        it('all source refs look like NIS2 requirement codes', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.source_ref).toMatch(/^NIS2-[A-Z]{2,3}$/);
            }
        });

        it('all target refs look like ISO Annex A practices', () => {
            for (const entry of stored.mapping_entries) {
                expect(entry.target_ref).toMatch(/^A\.\d+\.\d+$/);
            }
        });

        it('covers key NIS2 Article 21 areas', () => {
            const sourceRefs = new Set(stored.mapping_entries.map(e => e.source_ref));
            expect(sourceRefs.has('NIS2-RM')).toBe(true);  // Risk Management
            expect(sourceRefs.has('NIS2-IR')).toBe(true);  // Incident Response
            expect(sourceRefs.has('NIS2-BC')).toBe(true);  // Business Continuity
            expect(sourceRefs.has('NIS2-SC')).toBe(true);  // Supply Chain
            expect(sourceRefs.has('NIS2-AM')).toBe(true);  // Access Management
            expect(sourceRefs.has('NIS2-GOV')).toBe(true); // Governance
        });

        it('includes NIS2-specific SUPERSET mapping for incident handling', () => {
            // NIS2-IR → A.5.24 should be SUPERSET (NIS2 incident requirements are broader)
            const irToPlanning = stored.mapping_entries.find(
                e => e.source_ref === 'NIS2-IR' && e.target_ref === 'A.5.24',
            );
            expect(irToPlanning).toBeDefined();
            expect(irToPlanning!.strength).toBe('SUPERSET');
        });

        it('produces stable content hash', () => {
            const h1 = computeMappingSetHash(stored);
            const h2 = computeMappingSetHash(stored);
            expect(h1).toBe(h2);
            expect(h1).toHaveLength(64);
        });
    });

    // ─── Cross-File Consistency ──────────────────────────────────
    describe('Cross-file consistency', () => {
        const mappingsDir = path.resolve(__dirname, '../../src/data/libraries/mappings');

        it('all files have unique URNs', () => {
            const results = scanMappingSetDirectory(mappingsDir);
            const urns = results.map(r => r.stored.urn);
            expect(new Set(urns).size).toBe(urns.length);
        });

        it('all files target distinct framework pairs', () => {
            const results = scanMappingSetDirectory(mappingsDir);
            const pairs = results.map(r => `${r.stored.source_framework_ref}|${r.stored.target_framework_ref}`);
            expect(new Set(pairs).size).toBe(pairs.length);
        });

        it('all files have unique content hashes', () => {
            const results = scanMappingSetDirectory(mappingsDir);
            const hashes = results.map(r => r.contentHash);
            expect(new Set(hashes).size).toBe(hashes.length);
        });

        it('no file uses invalid strength values', () => {
            const results = scanMappingSetDirectory(mappingsDir);
            const validStrengths = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];
            for (const { stored } of results) {
                for (const entry of stored.mapping_entries) {
                    expect(validStrengths).toContain(entry.strength);
                }
            }
        });

        it('every entry across all files has a rationale', () => {
            const results = scanMappingSetDirectory(mappingsDir);
            for (const { stored } of results) {
                for (let i = 0; i < stored.mapping_entries.length; i++) {
                    const entry = stored.mapping_entries[i];
                    expect(entry.rationale).toBeTruthy();
                }
            }
        });

        it('total mapping entries across all files is substantial', () => {
            const results = scanMappingSetDirectory(mappingsDir);
            const totalEntries = results.reduce((sum, r) => sum + r.stored.mapping_entries.length, 0);
            expect(totalEntries).toBeGreaterThanOrEqual(60);
        });
    });

    // ─── Full Traceability Pipeline ──────────────────────────────
    describe('Resolution → Traceability report', () => {
        it('EQUAL mapping produces FULL confidence report', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'iso-a51', targetFrameworkKeys: ['NIST-CSF'], maxDepth: 1 },
                integrationLoader,
            );
            const report = buildTraceabilityReport(trace, 'NIST-CSF');

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].confidence).toBe('FULL');
            expect(report.findings[0].isActionable).toBe(true);
            expect(report.summary.bestConfidence).toBe('FULL');
        });

        it('SUBSET mapping produces PARTIAL confidence (not actionable)', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'iso-a52', targetFrameworkKeys: ['NIST-CSF'], maxDepth: 1 },
                integrationLoader,
            );
            const report = buildTraceabilityReport(trace, 'NIST-CSF');

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].confidence).toBe('PARTIAL');
            expect(report.findings[0].isActionable).toBe(false);
            expect(report.findings[0].explanation.actionRequired).toBe(true);
        });

        it('RELATED mapping produces INFORMATIONAL confidence', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'iso-a524', targetFrameworkKeys: ['NIST-CSF'], maxDepth: 1 },
                integrationLoader,
            );
            const report = buildTraceabilityReport(trace, 'NIST-CSF');

            expect(report.findings).toHaveLength(1);
            expect(report.findings[0].confidence).toBe('INFORMATIONAL');
            expect(report.findings[0].isActionable).toBe(false);
        });

        it('transitive EQUAL→SUPERSET produces HIGH confidence', async () => {
            const trace = await resolveMapping(
                { sourceRequirementId: 'iso-a51', targetFrameworkKeys: ['SOC2'], maxDepth: 3 },
                integrationLoader,
            );
            const report = buildTraceabilityReport(trace, 'SOC2');

            expect(report.findings).toHaveLength(1);
            const finding = report.findings[0];
            expect(finding.confidence).toBe('HIGH');
            expect(finding.isActionable).toBe(true);
            expect(finding.isDirect).toBe(false);
            expect(finding.depth).toBe(2);
            expect(finding.edgeChain).toHaveLength(2);
        });
    });

    // ─── Full Gap Analysis Pipeline ──────────────────────────────
    describe('Resolution → Gap analysis', () => {
        const nistTargets = [
            { requirementId: 'nist-gvoc01', requirementCode: 'GV.OC-01', requirementTitle: 'Org Context', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
            { requirementId: 'nist-gvrm01', requirementCode: 'GV.RM-01', requirementTitle: 'Risk Management', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
            { requirementId: 'nist-praa01', requirementCode: 'PR.AA-01', requirementTitle: 'Access Auth', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
            { requirementId: 'nist-rsma01', requirementCode: 'RS.MA-01', requirementTitle: 'Incident Mgmt', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
            { requirementId: 'nist-idra01', requirementCode: 'ID.RA-01', requirementTitle: 'Risk Assessment', frameworkKey: 'NIST-CSF', frameworkName: 'NIST CSF 2.0' },
        ];

        it('produces correct gap status across all strength levels', async () => {
            const result = await analyzeGaps(
                ['iso-a51', 'iso-a52', 'iso-a515', 'iso-a524'],
                nistTargets,
                'ISO27001',
                'NIST-CSF',
                integrationLoader,
                { maxDepth: 1 },
            );

            // GV.OC-01: EQUAL → COVERED
            const gvoc = result.entries.find(e => e.targetRequirement.requirementCode === 'GV.OC-01');
            expect(gvoc!.status).toBe('COVERED');
            expect(gvoc!.bestConfidence).toBe('FULL');

            // GV.RM-01: SUBSET → PARTIALLY_COVERED
            const gvrm = result.entries.find(e => e.targetRequirement.requirementCode === 'GV.RM-01');
            expect(gvrm!.status).toBe('PARTIALLY_COVERED');
            expect(gvrm!.bestConfidence).toBe('PARTIAL');

            // PR.AA-01: INTERSECT → PARTIALLY_COVERED
            const praa = result.entries.find(e => e.targetRequirement.requirementCode === 'PR.AA-01');
            expect(praa!.status).toBe('PARTIALLY_COVERED');
            expect(praa!.bestConfidence).toBe('OVERLAP');

            // RS.MA-01: RELATED → REVIEW_NEEDED
            const rsma = result.entries.find(e => e.targetRequirement.requirementCode === 'RS.MA-01');
            expect(rsma!.status).toBe('REVIEW_NEEDED');

            // ID.RA-01: no mapping → NOT_COVERED
            const idra = result.entries.find(e => e.targetRequirement.requirementCode === 'ID.RA-01');
            expect(idra!.status).toBe('NOT_COVERED');
        });

        it('computes correct coverage percentages', async () => {
            const result = await analyzeGaps(
                ['iso-a51', 'iso-a52', 'iso-a515', 'iso-a524'],
                nistTargets,
                'ISO27001',
                'NIST-CSF',
                integrationLoader,
                { maxDepth: 1 },
            );

            expect(result.summary.totalTargetRequirements).toBe(5);
            expect(result.summary.covered).toBe(1);           // GV.OC-01
            expect(result.summary.partiallyCovered).toBe(2);   // GV.RM-01, PR.AA-01
            expect(result.summary.reviewNeeded).toBe(1);       // RS.MA-01
            expect(result.summary.notCovered).toBe(1);         // ID.RA-01
            expect(result.summary.coveragePercent).toBe(20);   // 1/5
            expect(result.summary.inclusiveCoveragePercent).toBe(60); // 3/5
        });

        it('sorts gap entries with NOT_COVERED first', async () => {
            const result = await analyzeGaps(
                ['iso-a51', 'iso-a52', 'iso-a515', 'iso-a524'],
                nistTargets,
                'ISO27001',
                'NIST-CSF',
                integrationLoader,
                { maxDepth: 1 },
            );

            const statuses = result.entries.map(e => e.status);
            const notCoveredIdx = statuses.indexOf('NOT_COVERED');
            const coveredIdx = statuses.indexOf('COVERED');
            expect(notCoveredIdx).toBeLessThan(coveredIdx);
        });

        it('includes explanations for every entry', async () => {
            const result = await analyzeGaps(
                ['iso-a51', 'iso-a52', 'iso-a515', 'iso-a524'],
                nistTargets,
                'ISO27001',
                'NIST-CSF',
                integrationLoader,
                { maxDepth: 1 },
            );

            for (const entry of result.entries) {
                expect(entry.explanation).toBeTruthy();
                expect(typeof entry.explanation).toBe('string');
                expect(entry.explanation.length).toBeGreaterThan(10);
            }
        });
    });

    // ─── Deterministic Output ────────────────────────────────────
    describe('Deterministic pipeline output', () => {
        it('produces identical results across multiple runs', async () => {
            const run = async () => {
                const traces = await resolveMappingBatch(
                    [
                        { sourceRequirementId: 'iso-a51', maxDepth: 3 },
                        { sourceRequirementId: 'iso-a52', maxDepth: 3 },
                    ],
                    integrationLoader,
                );
                return traces.map(t => ({
                    source: t.source.requirementCode,
                    paths: t.paths.map(p => ({
                        target: p.target.requirementCode,
                        depth: p.depth,
                        strength: p.effectiveStrength,
                    })),
                }));
            };

            const r1 = await run();
            const r2 = await run();
            const r3 = await run();

            expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
            expect(JSON.stringify(r2)).toBe(JSON.stringify(r3));
        });
    });

    // ─── End-to-End Strength Semantics ───────────────────────────
    describe('Strength semantics hold end-to-end', () => {
        const strengths: MappingStrengthValue[] = ['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED'];

        it.each(strengths)('%s → confidence → gap status is conservative', (strength) => {
            const confidence = strengthToConfidence(strength);
            const gapStatus = determineGapStatus(confidence);
            const actionable = isActionableCoverage(confidence);

            // Only EQUAL and SUPERSET should be actionable
            if (strength === 'EQUAL' || strength === 'SUPERSET') {
                expect(actionable).toBe(true);
                expect(gapStatus).toBe('COVERED');
            } else if (strength === 'SUBSET' || strength === 'INTERSECT') {
                expect(actionable).toBe(false);
                expect(gapStatus).toBe('PARTIALLY_COVERED');
            } else {
                // RELATED
                expect(actionable).toBe(false);
                expect(gapStatus).toBe('REVIEW_NEEDED');
            }
        });
    });

    // ─── YAML Schema Validation ──────────────────────────────────
    describe('YAML schema validation hardening', () => {
        it('rejects mapping set with missing required fields', () => {
            expect(() => parseMappingSetString(`
                urn: test
                name: Test
            `)).toThrow();
        });

        it('rejects mapping set with empty entries', () => {
            expect(() => parseMappingSetString(`
urn: test
name: Test
version: 1
source_framework_ref: A
target_framework_ref: B
mapping_entries: []
            `)).toThrow();
        });

        it('accepts well-formed inline mapping set', () => {
            const stored = parseMappingSetString(`
urn: urn:inflect:mappingset:test
name: "Test Mapping"
version: 1
source_framework_ref: FW-A
target_framework_ref: FW-B
mapping_entries:
  - source_ref: REQ-1
    target_ref: REQ-2
    strength: EQUAL
    rationale: Test
            `);

            expect(stored.urn).toBe('urn:inflect:mappingset:test');
            expect(stored.mapping_entries).toHaveLength(1);
            expect(stored.mapping_entries[0].strength).toBe('EQUAL');
        });
    });
});
