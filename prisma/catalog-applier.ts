import { createHash } from 'crypto';
/**
 * Catalog applier — the write-side of the YAML/JSON ingestion
 * boundary in `prisma/catalog-loader.ts`.
 *
 * Given a parsed `CatalogFile` (the output of `loadCatalogFile`),
 * upsert the rows into the global catalog tables in the same order
 * `seed-catalog.ts` already does:
 *
 *   1. Framework               (upsert on `key_version`)
 *   2. FrameworkRequirement[]  (upsert on `frameworkId_code`)
 *   3. ControlTemplate[]       (create-if-missing on `code`)
 *   4. ControlTemplateTask[]   (default 5-task playbook per template)
 *   5. ControlTemplateRequirementLink[]  (template ↔ requirement edges)
 *   6. FrameworkPack           (upsert on `key`)
 *   7. PackTemplateLink[]      (upsert on composite key)
 *
 * Idempotent — safe to re-run. Rows are upsert-or-skip-if-exists, so
 * a re-run of the same catalog file is a no-op apart from updating
 * mutable fields (titles, descriptions, sortOrder).
 *
 * @module prisma/catalog-applier
 */
import type { PrismaClient } from '@prisma/client';
import {
    type CatalogFile,
    assertCatalogConsistency,
} from './catalog-loader';

export interface ApplyCatalogResult {
    framework: { id: string; key: string; created: boolean };
    requirements: { upserted: number };
    templates: { created: number; existing: number };
    pack?: { id: string; key: string; created: boolean; templatesLinked: number };
}

/**
 * Apply a validated CatalogFile to the database. Mirrors the upsert
 * sequence in seed-catalog.ts so the on-disk YAML/JSON shape lands
 * exactly what the legacy seed produces.
 *
 * Cross-validation runs first (`assertCatalogConsistency`) so a
 * typo in `templateCodes`/`requirementCodes` aborts BEFORE any DB
 * writes — never half-applied.
 *
 * @param prisma  The Prisma client to write through.
 * @param file    Parsed + schema-validated catalog data.
 * @param filePath Original source path, used in error messages from
 *                 the consistency check.
 */
/**
 * A stable fingerprint of a catalogue's CONTENT.
 *
 * Hashes the framework identity plus every requirement's code, title and
 * ordering — not the raw file — so reformatting a YAML or reordering its
 * comments does not look like a revision, while adding, removing or retitling
 * a control point does.
 *
 * `Framework.contentHash` has existed since the model was created and nothing
 * ever set it. With it, "has this catalogue changed since we ingested it" is
 * one comparison rather than a diff nobody runs.
 */
function contentHashOf(file: CatalogFile): string {
    const canonical = JSON.stringify({
        key: file.framework.key,
        version: file.framework.version ?? null,
        requirements: [...file.requirements]
            .map((r) => ({ code: r.code, title: r.title, sortOrder: r.sortOrder ?? null }))
            .sort((a, b) => a.code.localeCompare(b.code)),
    });
    return createHash('sha256').update(canonical).digest('hex');
}

export async function applyCatalogFile(
    prisma: PrismaClient,
    file: CatalogFile,
    filePath: string,
): Promise<ApplyCatalogResult> {
    assertCatalogConsistency(file, filePath);

    // ── 1. Framework ────────────────────────────────────────────
    const fwUpsertWhere = file.framework.version
        ? { key_version: { key: file.framework.key, version: file.framework.version } }
        : { key: file.framework.key };
    const fwBefore = await prisma.framework.findFirst({ where: { key: file.framework.key } });
    const framework = await prisma.framework.upsert({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Prisma type for compound `key_version` vs single `key` upsert keys is a discriminated union; the simple `key` form is valid but the static checker can't narrow `fwUpsertWhere` cleanly here
        where: fwUpsertWhere as any,
        update: {
            name: file.framework.name,
            // `version` is written on UPDATE too. It was create-only, so a
            // catalogue whose version changed left the row's version stale —
            // and combined with the key-only unique (now dropped) the upsert
            // could not reach the new version at all.
            ...(file.framework.version ? { version: file.framework.version } : {}),
            ...(file.framework.kind ? { kind: file.framework.kind } : {}),
            ...(file.framework.description !== undefined
                ? { description: file.framework.description }
                : {}),
            isDemo: file.framework.isDemo ?? false,
            coverageNote: file.framework.coverageNote ?? null,
            // Provenance. Both columns have existed since the model was
            // created and nothing ever wrote them, so no catalogue could say
            // which revision it was or where it came from.
            contentHash: contentHashOf(file),
            ...(file.framework.sourceUrn ? { sourceUrn: file.framework.sourceUrn } : {}),
        },
        create: {
            key: file.framework.key,
            name: file.framework.name,
            ...(file.framework.version ? { version: file.framework.version } : {}),
            ...(file.framework.kind ? { kind: file.framework.kind } : {}),
            ...(file.framework.description !== undefined
                ? { description: file.framework.description }
                : {}),
            isDemo: file.framework.isDemo ?? false,
            coverageNote: file.framework.coverageNote ?? null,
            contentHash: contentHashOf(file),
            ...(file.framework.sourceUrn ? { sourceUrn: file.framework.sourceUrn } : {}),
        },
    });

    // ── 2. Requirements ─────────────────────────────────────────
    const requirementMap: Record<string, string> = {};
    for (let i = 0; i < file.requirements.length; i++) {
        const req = file.requirements[i];
        const r = await prisma.frameworkRequirement.upsert({
            where: {
                frameworkId_code: { frameworkId: framework.id, code: req.code },
            },
            update: {
                title: req.title,
                description: req.summary ?? null,
                ...(req.theme !== undefined ? { theme: req.theme } : {}),
                ...(req.themeNumber !== undefined ? { themeNumber: req.themeNumber } : {}),
                ...(req.section !== undefined ? { section: req.section } : {}),
                sortOrder: req.sortOrder ?? i,
            },
            create: {
                frameworkId: framework.id,
                code: req.code,
                title: req.title,
                description: req.summary ?? null,
                category: req.category ?? req.theme ?? req.section ?? '',
                ...(req.theme !== undefined ? { theme: req.theme } : {}),
                ...(req.themeNumber !== undefined ? { themeNumber: req.themeNumber } : {}),
                ...(req.section !== undefined ? { section: req.section } : {}),
                sortOrder: req.sortOrder ?? i,
            },
        });
        requirementMap[req.code] = r.id;
    }

    // ── 3. Pack ────────────────────────────────────────────────
    // Control templates (and their tasks / requirement links / pack
    // links) were removed with the compliance uproot — a catalogue file
    // now seeds the framework and its requirements only.
    let packResult: ApplyCatalogResult['pack'];
    if (file.pack) {
        const packBefore = await prisma.frameworkPack.findUnique({
            where: { key: file.pack.key },
        });
        const pack = await prisma.frameworkPack.upsert({
            where: { key: file.pack.key },
            update: {
                name: file.pack.name,
                frameworkId: framework.id,
                ...(file.pack.version ? { version: file.pack.version } : {}),
                ...(file.pack.description !== undefined
                    ? { description: file.pack.description }
                    : {}),
            },
            create: {
                key: file.pack.key,
                name: file.pack.name,
                frameworkId: framework.id,
                ...(file.pack.version ? { version: file.pack.version } : {}),
                ...(file.pack.description !== undefined
                    ? { description: file.pack.description }
                    : {}),
            },
        });

        packResult = {
            id: pack.id,
            key: pack.key,
            created: !packBefore,
            templatesLinked: 0,
        };
    }

    return {
        framework: {
            id: framework.id,
            key: framework.key,
            created: !fwBefore,
        },
        requirements: { upserted: file.requirements.length },
        templates: { created: 0, existing: 0 },
        pack: packResult,
    };
}
