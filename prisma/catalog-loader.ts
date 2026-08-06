/**
 * seed-catalog YAML/JSON ingestion boundary.
 *
 * Replaces the per-framework `require('./fixtures/*.json')` + inline
 * TS-array fragments scattered across `prisma/seed-catalog.ts`. One
 * loader, one Zod schema, one canonical internal representation —
 * `seed-catalog.ts` and the `framework:import` CLI both consume the
 * same shape.
 *
 * ## Format support
 *
 *   • `.yaml` / `.yml` — parsed with `js-yaml` (already a dep, used
 *     by the cross-framework `library-loader.ts`).
 *   • `.json` — parsed with `JSON.parse`.
 *
 * Dispatch is by file extension (case-insensitive). Anything else
 * throws `CatalogParseError` with an actionable message.
 *
 * ## Schema (CatalogFileSchema)
 *
 *   framework:
 *     key: ISO27001                # PK against `Framework.key`
 *     name: ISO/IEC 27001          # human-readable
 *     version: "2022"              # optional, used in `key_version` upsert
 *     kind: ISO_STANDARD           # optional, FrameworkKind enum
 *     description: ...             # optional
 *
 *   requirements:                  # required, ≥ 1
 *     - code: A.5.1
 *       title: Information security policies
 *       summary: ...               # → FrameworkRequirement.description
 *       theme: Organizational      # optional
 *       themeNumber: 5             # optional
 *       sortOrder: 1               # optional, default = array index
 *       section: A.5               # optional, fallback to `theme` when null
 *       category: ...              # optional, fallback to theme/section
 *
 *   templates:                     # optional, may be []
 *     - code: A-A.5.1              # PK against `ControlTemplate.code`
 *       title: ...
 *       category: Organizational
 *       defaultFrequency: QUARTERLY  # ControlFrequency enum, default QUARTERLY
 *       requirementCodes: [A.5.1]    # codes — resolved to FrameworkRequirement IDs
 *
 *   pack:                          # optional, single pack per file
 *     key: ISO27001_2022_BASE      # PK against `FrameworkPack.key`
 *     name: ...
 *     version: ...
 *     description: ...
 *     templateCodes: [A-A.5.1, …]  # subset of `templates[*].code`; defaults
 *                                  # to ALL templates in this file
 *
 * ## Validation contract
 *
 *   • Malformed YAML/JSON → `CatalogParseError` (carries file + cause).
 *   • Schema-invalid content → `CatalogValidationError` (carries file
 *     + Zod issue list with `path` and `message`).
 *   • Both error types subclass `Error` so `try/catch (err)` callers
 *     can `instanceof` discriminate.
 *
 * Validation happens BEFORE the seed-catalog ever touches the DB.
 * A bad file is rejected at the boundary, not halfway through a
 * partial upsert.
 *
 * @module prisma/catalog-loader
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as yaml from 'js-yaml';

// ─── Errors ─────────────────────────────────────────────────────────

export class CatalogParseError extends Error {
    readonly file: string;
    readonly cause?: unknown;
    constructor(file: string, message: string, cause?: unknown) {
        super(`Catalog parse error in ${path.relative(process.cwd(), file) || file}: ${message}`);
        this.name = 'CatalogParseError';
        this.file = file;
        this.cause = cause;
    }
}

export class CatalogValidationError extends Error {
    readonly file: string;
    readonly issues: ReadonlyArray<{ path: string; message: string }>;
    constructor(file: string, issues: ReadonlyArray<{ path: string; message: string }>) {
        const summary = issues
            .map((i) => `  ‒ ${i.path || '<root>'}: ${i.message}`)
            .join('\n');
        super(
            `Catalog validation failed in ${path.relative(process.cwd(), file) || file}:\n${summary}`,
        );
        this.name = 'CatalogValidationError';
        this.file = file;
        this.issues = issues;
    }
}

// ─── Zod schema ─────────────────────────────────────────────────────

const FRAMEWORK_KINDS = [
    'ISO_STANDARD',
    'NIST_FRAMEWORK',
    'SOC_CRITERIA',
    'EU_DIRECTIVE',
    'REGULATION',
    'INDUSTRY_STANDARD',
    'CUSTOM',
    // Phase-7 — agriculture certification schemes (Organic, GlobalG.A.P., …)
    // are global Frameworks with kind = AG_SCHEME. The scheme catalogs under
    // prisma/catalogs/*-demo.yaml import through this same loader/applier.
    'AG_SCHEME',
] as const;

const CONTROL_FREQUENCIES = [
    'AD_HOC',
    'DAILY',
    'WEEKLY',
    'MONTHLY',
    'QUARTERLY',
    'ANNUALLY',
] as const;

export const CatalogFrameworkSchema = z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    kind: z.enum(FRAMEWORK_KINDS).optional(),
    description: z.string().optional(),
    /**
     * Is this catalogue a DEMO/PARTIAL subset rather than the full standard?
     *
     * Every YAML shipped today says so honestly in its header comment — and a
     * header comment reaches no user. Declaring it as DATA is what lets the
     * scheme list badge it, so a farmer who maps their practices to 7 control
     * points is told those 7 are not GlobalG.A.P.
     */
    isDemo: z.boolean().optional(),
    /** e.g. "7 of ~200 control points" — free text, rendered verbatim. */
    coverageNote: z.string().optional(),
    /**
     * Where this catalogue came from. `contentHash` and `sourceUrn` have
     * existed on the model since it was created and NOTHING ever set them, so
     * there was zero provenance on any catalogue — no way to answer "which
     * revision of the standard is this, and where did it come from" about a
     * document a certifier is being handed.
     */
    sourceUrn: z.string().optional(),
});

export const CatalogRequirementSchema = z.object({
    code: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    theme: z.string().optional(),
    themeNumber: z.number().int().nonnegative().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    section: z.string().optional(),
    category: z.string().optional(),
});

export const CatalogTemplateSchema = z.object({
    code: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    category: z.string().min(1),
    defaultFrequency: z.enum(CONTROL_FREQUENCIES).default('QUARTERLY'),
    requirementCodes: z.array(z.string().min(1)).default([]),
});

export const CatalogPackSchema = z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    /** When omitted, the pack includes every template in this file. */
    templateCodes: z.array(z.string().min(1)).optional(),
});

export const CatalogFileSchema = z.object({
    framework: CatalogFrameworkSchema,
    requirements: z.array(CatalogRequirementSchema).min(1),
    templates: z.array(CatalogTemplateSchema).default([]),
    pack: CatalogPackSchema.optional(),
});

export type CatalogFile = z.infer<typeof CatalogFileSchema>;
export type CatalogFramework = z.infer<typeof CatalogFrameworkSchema>;
export type CatalogRequirement = z.infer<typeof CatalogRequirementSchema>;
export type CatalogTemplate = z.infer<typeof CatalogTemplateSchema>;
export type CatalogPack = z.infer<typeof CatalogPackSchema>;

// ─── Loader ─────────────────────────────────────────────────────────

const YAML_EXT = new Set(['.yaml', '.yml']);
const JSON_EXT = new Set(['.json']);

function detectFormat(filePath: string): 'yaml' | 'json' {
    const ext = path.extname(filePath).toLowerCase();
    if (YAML_EXT.has(ext)) return 'yaml';
    if (JSON_EXT.has(ext)) return 'json';
    throw new CatalogParseError(
        filePath,
        `Unsupported file extension '${ext}'. Use .yaml/.yml or .json.`,
    );
}

/**
 * Parse + validate a catalog file. Returns the canonical internal
 * shape that `seed-catalog` and the framework-import CLI both
 * consume.
 *
 * @throws CatalogParseError    Unsupported extension, malformed YAML/JSON.
 * @throws CatalogValidationError The parsed content didn't match
 *                                CatalogFileSchema. The thrown error
 *                                carries the full Zod issue list with
 *                                paths so reviewers can pinpoint the
 *                                offending field.
 */
export function loadCatalogFile(filePath: string): CatalogFile {
    const absPath = path.resolve(filePath);

    let raw: string;
    try {
        raw = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
        throw new CatalogParseError(absPath, 'failed to read file', err);
    }

    const format = detectFormat(absPath);

    let parsed: unknown;
    try {
        parsed = format === 'yaml' ? yaml.load(raw) : JSON.parse(raw);
    } catch (err) {
        throw new CatalogParseError(
            absPath,
            `failed to parse ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
            err,
        );
    }

    if (parsed === null || parsed === undefined) {
        throw new CatalogParseError(absPath, 'file is empty after parsing');
    }

    const result = CatalogFileSchema.safeParse(parsed);
    if (!result.success) {
        throw new CatalogValidationError(
            absPath,
            result.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
            })),
        );
    }

    return result.data;
}

/**
 * Cross-validate a parsed catalog file: every templateCode listed in
 * the pack must exist in `templates[*].code`, and every
 * requirementCode listed on a template must exist in
 * `requirements[*].code`. Catches typos that the per-field schema
 * can't.
 *
 * Throws CatalogValidationError on the first issue found.
 */
export function assertCatalogConsistency(file: CatalogFile, sourcePath: string): void {
    const issues: Array<{ path: string; message: string }> = [];

    const requirementCodes = new Set(file.requirements.map((r) => r.code));
    const templateCodes = new Set(file.templates.map((t) => t.code));

    file.templates.forEach((t, i) => {
        for (const reqCode of t.requirementCodes) {
            if (!requirementCodes.has(reqCode)) {
                issues.push({
                    path: `templates[${i}].requirementCodes`,
                    message: `requirement code '${reqCode}' not found in requirements[*].code`,
                });
            }
        }
    });

    if (file.pack?.templateCodes) {
        file.pack.templateCodes.forEach((tc, i) => {
            if (!templateCodes.has(tc)) {
                issues.push({
                    path: `pack.templateCodes[${i}]`,
                    message: `template code '${tc}' not found in templates[*].code`,
                });
            }
        });
    }

    if (issues.length > 0) {
        throw new CatalogValidationError(sourcePath, issues);
    }
}

/** Convenience — load + cross-validate in one call. */
export function loadAndValidateCatalogFile(filePath: string): CatalogFile {
    const file = loadCatalogFile(filePath);
    assertCatalogConsistency(file, filePath);
    return file;
}
