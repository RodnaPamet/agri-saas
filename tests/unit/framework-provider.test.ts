/**
 * Tests for the Framework Provider — Runtime YAML-backed framework consumption.
 *
 * Verifies:
 * 1. YAML-backed lookups work (by refId, by URN, by node URN)
 * 2. Legacy-compatible providers return correct shapes
 * 3. Framework listing and tree traversal work
 * 4. Cache invalidation/reload works
 * 5. SOC2 requirements are loaded from YAML
 * 6. Cross-framework mapping structure is preserved
 * 7. No regression in data shapes expected by consumers
 */
import {
    getLibraryByRefId,
    getLibraryByUrn,
    getAllLibraries,
    findNodeByUrn,
    findNodeByRefId,
    getSOC2Requirements,
    getNIS2Requirements,
    getISO27001Clauses,
    getFrameworkMappings,
    getAssessableNodes,
    getFrameworkTree,
    listAvailableFrameworks,
    reloadLibraries,
    isYamlBackedAvailable,
} from '@/app-layer/libraries';

// ─── YAML Library Availability ──────────────────────────────────────

describe('YAML Library Availability', () => {
    it('should report YAML-backed libraries as available', () => {
        reloadLibraries(); // Clear cache to force fresh load
        expect(isYamlBackedAvailable()).toBe(true);
    });

    it('should load at least 4 libraries (ISO, NIST, SOC2, NIS2)', () => {
        const libs = getAllLibraries();
        expect(libs.length).toBeGreaterThanOrEqual(4);
    });
});

// ─── Library Lookup by refId ────────────────────────────────────────

describe('getLibraryByRefId', () => {
    it('should find ISO27001-2022 library', () => {
        const lib = getLibraryByRefId('ISO27001-2022');
        expect(lib).toBeDefined();
        expect(lib!.name).toContain('ISO');
        expect(lib!.kind).toBe('ISO_STANDARD');
    });

    it('should find NIST-CSF-2.0 library', () => {
        const lib = getLibraryByRefId('NIST-CSF-2.0');
        expect(lib).toBeDefined();
        expect(lib!.kind).toBe('NIST_FRAMEWORK');
    });

    it('should find SOC2-2017 library', () => {
        const lib = getLibraryByRefId('SOC2-2017');
        expect(lib).toBeDefined();
        expect(lib!.kind).toBe('SOC_CRITERIA');
    });

    it('should return undefined for unknown refId', () => {
        expect(getLibraryByRefId('UNKNOWN-FRAMEWORK')).toBeUndefined();
    });

    it('should find NIS2-2022 library', () => {
        const lib = getLibraryByRefId('NIS2-2022');
        expect(lib).toBeDefined();
        expect(lib!.kind).toBe('EU_DIRECTIVE');
        expect(lib!.name).toContain('NIS2');
    });
});

// ─── Library Lookup by URN ──────────────────────────────────────────

describe('getLibraryByUrn', () => {
    it('should find library by URN', () => {
        const lib = getLibraryByUrn('urn:inflect:library:iso27001-2022');
        expect(lib).toBeDefined();
        expect(lib!.refId).toBe('ISO27001-2022');
    });

    it('should return undefined for unknown URN', () => {
        expect(getLibraryByUrn('urn:inflect:library:nonexistent')).toBeUndefined();
    });
});

// ─── Node Lookup by URN ─────────────────────────────────────────────

describe('findNodeByUrn', () => {
    it('should find a requirement node across all libraries', () => {
        const node = findNodeByUrn('urn:inflect:req:iso27001-2022:a.5.1');
        expect(node).toBeDefined();
        expect(node!.refId).toBe('A.5.1');
    });

    it('should find NIST node', () => {
        const node = findNodeByUrn('urn:inflect:req:nist-csf-2.0:gv');
        expect(node).toBeDefined();
    });

    it('should return undefined for unknown URN', () => {
        expect(findNodeByUrn('urn:inflect:req:unknown:x.y.z')).toBeUndefined();
    });
});

// ─── Node Lookup by refId ───────────────────────────────────────────

describe('findNodeByRefId', () => {
    it('should find ISO 27001 node by refId', () => {
        const node = findNodeByRefId('ISO27001-2022', 'A.5.1');
        expect(node).toBeDefined();
        expect(node!.name).toContain('Information Security Polic');
    });

    it('should find SOC2 node by refId', () => {
        const node = findNodeByRefId('SOC2-2017', 'CC1');
        expect(node).toBeDefined();
    });

    it('should return undefined for wrong framework', () => {
        expect(findNodeByRefId('ISO27001-2022', 'CC1')).toBeUndefined();
    });
});

// ─── SOC2 Requirements (Legacy Shape) ───────────────────────────────

describe('getSOC2Requirements (YAML-backed)', () => {
    it('should return SOC2 requirements with correct shape', () => {
        const reqs = getSOC2Requirements();
        expect(reqs.length).toBeGreaterThan(0);

        for (const req of reqs) {
            expect(req).toHaveProperty('code');
            expect(req).toHaveProperty('title');
            expect(req).toHaveProperty('description');
            expect(req).toHaveProperty('category');
            expect(typeof req.code).toBe('string');
            expect(typeof req.title).toBe('string');
        }
    });

    it('should include CC-prefixed codes for Security criteria', () => {
        const reqs = getSOC2Requirements();
        const codes = reqs.map(r => r.code);
        // YAML SOC2 uses sub-criteria codes (CC1.1, CC1.2, etc.)
        const ccCodes = codes.filter(c => c.startsWith('CC'));
        expect(ccCodes.length).toBeGreaterThanOrEqual(9);
    });

    it('should include availability, confidentiality, processing integrity, and privacy', () => {
        const reqs = getSOC2Requirements();
        const codes = reqs.map(r => r.code);
        expect(codes).toContain('A1');
        expect(codes).toContain('C1');
        expect(codes).toContain('PI1');
        expect(codes).toContain('P1');
    });
});

// ─── NIS2 Requirements (YAML-backed) ───────────────────────────────

describe('getNIS2Requirements (YAML-backed)', () => {
    it('should return NIS2 requirements with correct shape', () => {
        const reqs = getNIS2Requirements();
        expect(reqs.length).toBeGreaterThan(0);

        for (const req of reqs) {
            expect(req).toHaveProperty('code');
            expect(req).toHaveProperty('title');
            expect(req).toHaveProperty('description');
            expect(req).toHaveProperty('category');
        }
    });

    it('should include NIS2 area codes', () => {
        const reqs = getNIS2Requirements();
        const codes = reqs.map(r => r.code);
        expect(codes).toContain('NIS2-RM');
        expect(codes).toContain('NIS2-IR');
        expect(codes).toContain('NIS2-GOV');
    });

    it('should have 12 assessable requirement areas', () => {
        const reqs = getNIS2Requirements();
        expect(reqs.length).toBe(12);
    });

    it('should have meaningful descriptions and categories', () => {
        const reqs = getNIS2Requirements();
        for (const req of reqs) {
            expect(req.description.length).toBeGreaterThan(20);
            expect(req.category.length).toBeGreaterThan(0);
        }
    });
});

// ─── ISO 27001 Clauses (YAML-backed) ───────────────────────────────

describe('getISO27001Clauses (YAML-backed with enriched fields)', () => {
    it('should return clauses 4–10', () => {
        const clauses = getISO27001Clauses();
        expect(clauses.length).toBe(7);

        const numbers = clauses.map(c => c.number);
        expect(numbers).toEqual(['4', '5', '6', '7', '8', '9', '10']);
    });

    it('should include artifacts and checklist fields', () => {
        const clauses = getISO27001Clauses();
        for (const clause of clauses) {
            expect(clause).toHaveProperty('artifacts');
            expect(clause).toHaveProperty('checklist');
            expect(Array.isArray(clause.checklist)).toBe(true);
            expect(clause.artifacts.length).toBeGreaterThan(0);
            expect(clause.checklist.length).toBeGreaterThan(0);
        }
    });

    it('clause 4 should have context-related artifacts', () => {
        const clauses = getISO27001Clauses();
        const clause4 = clauses.find(c => c.number === '4');
        expect(clause4).toBeDefined();
        expect(clause4!.artifacts).toContain('Context analysis');
        expect(clause4!.artifacts).toContain('ISMS scope');
    });

    it('clause 6 should have risk-related checklist items', () => {
        const clauses = getISO27001Clauses();
        const clause6 = clauses.find(c => c.number === '6');
        expect(clause6).toBeDefined();
        expect(clause6!.checklist).toEqual(
            expect.arrayContaining([
                expect.stringContaining('risk'),
            ])
        );
    });
});

// ─── Framework Mappings (YAML-backed) ───────────────────────────────

describe('getFrameworkMappings (YAML-backed cross-framework guidance)', () => {
    it('should return guidance mappings with ISO↔SOC2↔NIS2 structure', () => {
        const mappings = getFrameworkMappings();
        expect(mappings.length).toBeGreaterThan(0);

        for (const mapping of mappings) {
            expect(mapping).toHaveProperty('isoControlId');
            expect(mapping).toHaveProperty('soc2Codes');
            expect(mapping).toHaveProperty('nis2Codes');
            expect(mapping).toHaveProperty('rationale');
            expect(Array.isArray(mapping.soc2Codes)).toBe(true);
            expect(Array.isArray(mapping.nis2Codes)).toBe(true);
        }
    });

    it('should include mappings for known ISO practices', () => {
        const mappings = getFrameworkMappings();
        const isoIds = mappings.map(m => m.isoControlId);
        expect(isoIds).toContain('A.5.1');
        expect(isoIds).toContain('A.8.25');
        expect(isoIds).toContain('A.5.20');
        expect(isoIds).toContain('A.5.23');
        expect(isoIds).toContain('A.5.26');
        expect(isoIds).toContain('A.5.30');
    });

    it('should have at least 20 ISO practice mappings', () => {
        const mappings = getFrameworkMappings();
        expect(mappings.length).toBeGreaterThanOrEqual(20);
    });

    it('A.5.1 should map to CC1, CC5 (SOC2) and NIS2-GOV (NIS2)', () => {
        const mappings = getFrameworkMappings();
        const a51 = mappings.find(m => m.isoControlId === 'A.5.1');
        expect(a51).toBeDefined();
        expect(a51!.soc2Codes).toContain('CC1');
        expect(a51!.soc2Codes).toContain('CC5');
        expect(a51!.nis2Codes).toContain('NIS2-GOV');
    });

    it('A.8.24 should map to CC6, C1 (SOC2) and NIS2-CR (NIS2)', () => {
        const mappings = getFrameworkMappings();
        const a824 = mappings.find(m => m.isoControlId === 'A.8.24');
        expect(a824).toBeDefined();
        expect(a824!.soc2Codes).toContain('CC6');
        expect(a824!.soc2Codes).toContain('C1');
        expect(a824!.nis2Codes).toContain('NIS2-CR');
    });

    it('A.5.26 should map to NIS2-RE (reporting obligation)', () => {
        const mappings = getFrameworkMappings();
        const a526 = mappings.find(m => m.isoControlId === 'A.5.26');
        expect(a526).toBeDefined();
        expect(a526!.nis2Codes).toContain('NIS2-RE');
    });

    it('all mappings should have non-empty rationale', () => {
        const mappings = getFrameworkMappings();
        for (const mapping of mappings) {
            expect(mapping.rationale.length).toBeGreaterThan(10);
        }
    });

    it('every ISO practice in mappings should exist in the ISO library', () => {
        const mappings = getFrameworkMappings();
        for (const mapping of mappings) {
            const node = findNodeByRefId('ISO27001-2022', mapping.isoControlId);
            expect(node).toBeDefined();
        }
    });
});

// ─── Assessable Node Lookups ────────────────────────────────────────

describe('getAssessableNodes', () => {
    it('should return only assessable nodes for ISO27001', () => {
        const nodes = getAssessableNodes('ISO27001-2022');
        expect(nodes).toBeDefined();
        expect(nodes!.length).toBeGreaterThan(0);
        for (const node of nodes!) {
            expect(node.assessable).toBe(true);
        }
    });

    it('should return undefined for unknown framework', () => {
        expect(getAssessableNodes('UNKNOWN')).toBeUndefined();
    });
});

// ─── Framework Tree ─────────────────────────────────────────────────

describe('getFrameworkTree', () => {
    it('should return root nodes for ISO27001', () => {
        const tree = getFrameworkTree('ISO27001-2022');
        expect(tree).toBeDefined();
        expect(tree!.length).toBeGreaterThan(0);
        // Root nodes should have depth=1 and no parent
        for (const node of tree!) {
            expect(node.depth).toBe(1);
            expect(node.parentUrn).toBeUndefined();
        }
    });
});

// ─── Framework Listing ──────────────────────────────────────────────

describe('listAvailableFrameworks', () => {
    it('should list all available YAML-backed frameworks', () => {
        const frameworks = listAvailableFrameworks();
        expect(frameworks.length).toBeGreaterThanOrEqual(4);

        for (const fw of frameworks) {
            expect(fw).toHaveProperty('refId');
            expect(fw).toHaveProperty('name');
            expect(fw).toHaveProperty('kind');
            expect(fw).toHaveProperty('version');
            expect(fw).toHaveProperty('nodeCount');
            expect(fw.nodeCount).toBeGreaterThan(0);
        }
    });

    it('should include ISO27001, NIST-CSF, SOC2, and NIS2', () => {
        const frameworks = listAvailableFrameworks();
        const refIds = frameworks.map(f => f.refId);
        expect(refIds).toContain('ISO27001-2022');
        expect(refIds).toContain('NIST-CSF-2.0');
        expect(refIds).toContain('SOC2-2017');
        expect(refIds).toContain('NIS2-2022');
    });
});

// ─── Cache Management ───────────────────────────────────────────────

describe('Cache management', () => {
    it('should reload libraries after cache invalidation', () => {
        reloadLibraries();
        // After reload, libraries should still be present
        expect(isYamlBackedAvailable()).toBe(true);
        expect(getAllLibraries().length).toBeGreaterThanOrEqual(4);
    });

    it('should return consistent results across multiple calls', () => {
        const libs1 = getAllLibraries();
        const libs2 = getAllLibraries();
        expect(libs1.length).toBe(libs2.length);
        expect(libs1.map(l => l.urn).sort()).toEqual(libs2.map(l => l.urn).sort());
    });
});
