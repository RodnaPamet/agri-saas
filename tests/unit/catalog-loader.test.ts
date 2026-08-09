/**
 * `prisma/catalog-loader.ts` — parser + validation contract.
 *
 * Covers:
 *   ✅ valid YAML round-trips through the schema
 *   ✅ valid JSON round-trips through the schema (regression for the
 *      legacy fixtures)
 *   ✅ extension dispatch (.yaml / .yml / .json)
 *   ✅ unsupported extension throws CatalogParseError
 *   ✅ malformed YAML throws CatalogParseError with a useful cause
 *   ✅ malformed JSON throws CatalogParseError
 *   ✅ schema-invalid content throws CatalogValidationError with
 *      issue paths
 *   ✅ cross-validation: pack.templateCodes referencing unknown
 *      template codes → CatalogValidationError with the precise path
 *   ✅ cross-validation: template.requirementCodes referencing
 *      unknown requirement codes → CatalogValidationError
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    loadCatalogFile,
    loadAndValidateCatalogFile,
    assertCatalogConsistency,
    CatalogParseError,
    CatalogValidationError,
} from '../../prisma/catalog-loader';

let tmpDir: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-loader-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

const VALID_YAML = `
framework:
  key: ISO27001
  name: ISO/IEC 27001
  version: "2022"
  kind: ISO_STANDARD
  description: Information Security Management
requirements:
  - code: A.5.1
    title: Information security policies
    summary: Establish, communicate, and review information security policies.
    theme: Organizational Practices
    themeNumber: 5
    sortOrder: 1
  - code: A.5.2
    title: Information security roles and responsibilities
    theme: Organizational Practices
    themeNumber: 5
    sortOrder: 2
templates:
  - code: A-A.5.1
    title: Information security policies
    category: Organizational
    requirementCodes: [A.5.1]
  - code: A-A.5.2
    title: Roles and responsibilities
    category: Organizational
    defaultFrequency: ANNUALLY
    requirementCodes: [A.5.2]
pack:
  key: ISO27001_2022_BASE
  name: ISO 27001:2022 Starter Pack
  version: "2022"
  description: Annex A baseline
`;

const VALID_JSON = JSON.stringify({
    framework: {
        key: 'SOC2',
        name: 'SOC 2',
        kind: 'SOC_CRITERIA',
    },
    requirements: [
        { code: 'CC1.1', title: 'Integrity and ethical values', category: 'Practice Environment' },
        { code: 'CC6.1', title: 'Logical access controls', category: 'Logical Access' },
    ],
});

describe('loadCatalogFile — happy path', () => {
    it('parses a valid YAML catalog file end-to-end', () => {
        const p = write('iso27001.yaml', VALID_YAML);
        const out = loadCatalogFile(p);
        expect(out.framework.key).toBe('ISO27001');
        expect(out.framework.kind).toBe('ISO_STANDARD');
        expect(out.requirements).toHaveLength(2);
        expect(out.requirements[0].code).toBe('A.5.1');
        expect(out.templates).toHaveLength(2);
        // Default applied
        expect(out.templates[0].defaultFrequency).toBe('QUARTERLY');
        // Explicit override preserved
        expect(out.templates[1].defaultFrequency).toBe('ANNUALLY');
        expect(out.pack?.key).toBe('ISO27001_2022_BASE');
    });

    it('parses .yml extension as YAML', () => {
        const p = write('iso27001.yml', VALID_YAML);
        const out = loadCatalogFile(p);
        expect(out.framework.key).toBe('ISO27001');
    });

    it('parses a valid JSON catalog file end-to-end', () => {
        const p = write('soc2.json', VALID_JSON);
        const out = loadCatalogFile(p);
        expect(out.framework.key).toBe('SOC2');
        expect(out.requirements).toHaveLength(2);
        // Optional sections default to []/undefined.
        expect(out.templates).toEqual([]);
        expect(out.pack).toBeUndefined();
    });
});

describe('loadCatalogFile — failure paths', () => {
    it('rejects unsupported extensions', () => {
        const p = write('catalog.txt', 'whatever');
        expect(() => loadCatalogFile(p)).toThrow(CatalogParseError);
        try {
            loadCatalogFile(p);
        } catch (err) {
            expect(err).toBeInstanceOf(CatalogParseError);
            expect((err as CatalogParseError).message).toMatch(/Unsupported file extension/);
        }
    });

    it('rejects malformed YAML with a parse error', () => {
        const p = write('bad.yaml', `framework:\n  key: ISO\n  unbalanced: [\n`);
        expect(() => loadCatalogFile(p)).toThrow(CatalogParseError);
        try {
            loadCatalogFile(p);
        } catch (err) {
            expect(err).toBeInstanceOf(CatalogParseError);
            expect((err as CatalogParseError).message).toMatch(/failed to parse YAML/);
        }
    });

    it('rejects malformed JSON with a parse error', () => {
        const p = write('bad.json', `{ "framework": { not-json }`);
        expect(() => loadCatalogFile(p)).toThrow(CatalogParseError);
        try {
            loadCatalogFile(p);
        } catch (err) {
            expect((err as CatalogParseError).message).toMatch(/failed to parse JSON/);
        }
    });

    it('rejects empty parsed result', () => {
        const p = write('empty.yaml', `# only comments\n`);
        expect(() => loadCatalogFile(p)).toThrow(CatalogParseError);
    });

    it('rejects schema-invalid content with field paths', () => {
        const p = write('invalid.yaml', `
framework:
  name: Missing Key
requirements: []
`);
        expect(() => loadCatalogFile(p)).toThrow(CatalogValidationError);
        try {
            loadCatalogFile(p);
        } catch (err) {
            expect(err).toBeInstanceOf(CatalogValidationError);
            const issues = (err as CatalogValidationError).issues;
            // At least two issues — missing framework.key + empty requirements (min 1).
            const paths = issues.map((i) => i.path);
            expect(paths).toContain('framework.key');
            expect(paths).toContain('requirements');
        }
    });

    it('rejects unknown enum values', () => {
        const p = write('enum.yaml', `
framework:
  key: ISO27001
  name: ISO 27001
  kind: NOT_A_REAL_KIND
requirements:
  - code: X.1
    title: X
`);
        expect(() => loadCatalogFile(p)).toThrow(CatalogValidationError);
    });
});

describe('assertCatalogConsistency — cross-field validation', () => {
    it('passes when every reference resolves', () => {
        const p = write('ok.yaml', VALID_YAML);
        const file = loadCatalogFile(p);
        expect(() => assertCatalogConsistency(file, p)).not.toThrow();
    });

    it('flags template.requirementCodes pointing at unknown codes', () => {
        const p = write('bad-req.yaml', `
framework: { key: X, name: X }
requirements:
  - { code: A.1, title: T }
templates:
  - code: T1
    title: Template
    category: C
    requirementCodes: [A.1, A.999]
`);
        const file = loadCatalogFile(p);
        try {
            assertCatalogConsistency(file, p);
            fail('expected CatalogValidationError');
        } catch (err) {
            expect(err).toBeInstanceOf(CatalogValidationError);
            const issue = (err as CatalogValidationError).issues[0];
            expect(issue.path).toBe('templates[0].requirementCodes');
            expect(issue.message).toMatch(/A\.999/);
        }
    });

    it('flags pack.templateCodes pointing at unknown templates', () => {
        const p = write('bad-pack.yaml', `
framework: { key: X, name: X }
requirements:
  - { code: A.1, title: T }
templates:
  - code: T1
    title: Template
    category: C
    requirementCodes: [A.1]
pack:
  key: P
  name: P
  templateCodes: [T1, T_MISSING]
`);
        const file = loadCatalogFile(p);
        try {
            assertCatalogConsistency(file, p);
            fail('expected CatalogValidationError');
        } catch (err) {
            const issue = (err as CatalogValidationError).issues[0];
            expect(issue.path).toBe('pack.templateCodes[1]');
            expect(issue.message).toMatch(/T_MISSING/);
        }
    });

    it('loadAndValidateCatalogFile combines both phases', () => {
        const p = write('combined-bad.yaml', `
framework: { key: X, name: X }
requirements:
  - { code: A.1, title: T }
templates:
  - code: T1
    title: Template
    category: C
    requirementCodes: [A.999]
`);
        expect(() => loadAndValidateCatalogFile(p)).toThrow(CatalogValidationError);
    });
});
