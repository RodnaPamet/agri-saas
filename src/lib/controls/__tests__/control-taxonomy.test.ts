import {
    categorizeControl,
    parseIsoClause,
    iso27001Domain,
    ISO27001_CLAUSE_DOMAIN,
    ISO27001_DOMAIN_ORDER,
    ISO27001_DOMAIN,
    FRAMEWORK_LABELS,
} from '../control-taxonomy';

describe('control-taxonomy', () => {
    describe('parseIsoClause', () => {
        it('parses the control-code forms the codebase uses', () => {
            expect(parseIsoClause('A.5.15')).toBe('5.15');
            expect(parseIsoClause('A-5.15')).toBe('5.15');
            expect(parseIsoClause('5.15')).toBe('5.15');
            expect(parseIsoClause('A.8.34')).toBe('8.34');
            expect(parseIsoClause('8.1')).toBe('8.1');
        });

        it('does NOT match non-ISO codes (SOC2 / NIS2 / nullish)', () => {
            expect(parseIsoClause('CC5.1')).toBeNull();
            expect(parseIsoClause('NIS2-3')).toBeNull();
            expect(parseIsoClause('QMS-1')).toBeNull();
            expect(parseIsoClause('AC-01')).toBeNull();
            expect(parseIsoClause('')).toBeNull();
            expect(parseIsoClause(null)).toBeNull();
            expect(parseIsoClause(undefined)).toBeNull();
        });
    });

    describe('ISO 27001 clause coverage', () => {
        it('maps every one of the 93 Annex A clauses to a granular domain', () => {
            const clauses = Object.keys(ISO27001_CLAUSE_DOMAIN);
            expect(clauses.length).toBe(93);
            for (const clause of clauses) {
                const domain = ISO27001_CLAUSE_DOMAIN[clause];
                expect(typeof domain).toBe('string');
                expect(domain.length).toBeGreaterThan(0);
                // Every domain used must appear in the display order list.
                expect(ISO27001_DOMAIN_ORDER).toContain(domain);
            }
        });

        it('every ordered domain is actually used by at least one clause', () => {
            const used = new Set(Object.values(ISO27001_CLAUSE_DOMAIN));
            for (const domain of ISO27001_DOMAIN_ORDER) {
                expect(used.has(domain)).toBe(true);
            }
        });

        it('classifies the user-referenced exemplar domains correctly', () => {
            expect(iso27001Domain('A.5.15')).toBe(ISO27001_DOMAIN.ACCESS_CONTROL);
            expect(iso27001Domain('A.7.1')).toBe(ISO27001_DOMAIN.PHYSICAL);
            expect(iso27001Domain('A.8.24')).toBe(ISO27001_DOMAIN.CRYPTO);
        });
    });

    describe('categorizeControl — framework detection', () => {
        it('tags an ISO 27001 control via a dotted Annex code', () => {
            expect(categorizeControl({ code: 'A.5.15' })).toEqual({
                frameworkKey: 'iso27001',
                frameworkLabel: 'ISO 27001',
                category: ISO27001_DOMAIN.ACCESS_CONTROL,
            });
        });

        it('tags an ISO 27001 control via the hyphenated Annex code form', () => {
            expect(categorizeControl({ code: 'A-7.7' })).toEqual({
                frameworkKey: 'iso27001',
                frameworkLabel: 'ISO 27001',
                category: ISO27001_DOMAIN.PHYSICAL,
            });
        });

        it('tags a SOC 2 control by code prefix, surfacing its persisted category', () => {
            expect(
                categorizeControl({ code: 'CC6.1', category: 'Logical Access' }),
            ).toEqual({
                frameworkKey: 'soc2',
                frameworkLabel: 'SOC 2',
                category: 'Logical Access',
            });
        });

        it('falls back to the framework label when SOC 2 has no persisted category', () => {
            expect(categorizeControl({ code: 'CC1.1', category: null })).toEqual({
                frameworkKey: 'soc2',
                frameworkLabel: 'SOC 2',
                category: 'SOC 2',
            });
        });

        it('detects the section-based frameworks by prefix', () => {
            expect(categorizeControl({ code: 'NIS2-3', category: 'Risk Management' })?.frameworkKey).toBe('nis2');
            expect(categorizeControl({ code: 'QMS-1', category: 'Context' })?.frameworkKey).toBe('iso9001');
            expect(categorizeControl({ code: 'SCS-2', category: 'Planning' })?.frameworkKey).toBe('iso28000');
            expect(categorizeControl({ code: 'RTS-4', category: 'Leadership' })?.frameworkKey).toBe('iso39001');
        });

        it('detects NIST 800-53 family prefixes', () => {
            const r = categorizeControl({ code: 'AC-01', category: 'Access Control' });
            expect(r?.frameworkKey).toBe('nist80053');
            expect(r?.frameworkLabel).toBe(FRAMEWORK_LABELS.nist80053);
        });

        it('returns an untagged bucket for a persisted category with no detectable framework', () => {
            expect(categorizeControl({ code: 'CUSTOM-1', category: 'My Domain' })).toEqual({
                frameworkKey: 'other',
                frameworkLabel: '',
                category: 'My Domain',
            });
        });

        it('returns null when there is nothing to group on', () => {
            expect(categorizeControl({ code: 'CUSTOM-1', category: null })).toBeNull();
            expect(categorizeControl({ code: null })).toBeNull();
        });
    });

    describe('multi-framework grouping', () => {
        it('keeps ISO and SOC 2 controls in distinct framework-tagged buckets', () => {
            const iso = categorizeControl({ code: 'A.5.15' });
            const soc2 = categorizeControl({ code: 'CC6.1', category: 'Logical Access' });
            expect(iso?.frameworkKey).not.toBe(soc2?.frameworkKey);
            expect(`${iso?.frameworkKey}::${iso?.category}`).not.toBe(
                `${soc2?.frameworkKey}::${soc2?.category}`,
            );
        });
    });
});
