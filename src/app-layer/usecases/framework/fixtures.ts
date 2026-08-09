import { RequestContext } from '../../types';
import { assertCanViewFrameworks, assertCanWriteCatalogue } from '../../policies/framework.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';

// в”Ђв”Ђв”Ђ Fixture Upsert (Versioning & Updates) в”Ђв”Ђв”Ђ

export interface RequirementFixture {
    code: string;
    title: string;
    description?: string;
    section?: string;
    category?: string;
    theme?: string;
    themeNumber?: number;
    sortOrder?: number;
}

export async function upsertRequirements(
    ctx: RequestContext,
    frameworkKey: string,
    requirements: RequirementFixture[],
    options: { deprecateMissing?: boolean } = {}
) {
    // PLATFORM gate, not a tenant one. This writes the GLOBAL catalogue: with
    // `deprecateMissing` it stamps `deprecatedAt` across every requirement of
    // the framework, and deprecated requirements are excluded from coverage
    // (coverage.ts) and from the Statement of Applicability (soa.ts). Under
    // the previous `assertCanInstallFrameworkPack` gate — OWNER or ADMIN of
    // ANY tenant — one farm could zero every other farm's readiness and SoA
    // with a single call, silently.
    assertCanWriteCatalogue(ctx);
    const db = prisma;

    const fw = await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    if (!requirements || requirements.length === 0) throw badRequest('At least one requirement required');

    // Validate unique codes within the fixture
    const codes = requirements.map((r) => r.code);
    const uniqueCodes = new Set(codes);
    if (uniqueCodes.size !== codes.length) {
        const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
        throw badRequest(`Duplicate requirement codes in fixture: ${[...new Set(dupes)].join(', ')}`);
    }

    let created = 0;
    let updated = 0;
    let deprecated = 0;

    // Upsert each requirement
    for (const req of requirements) {
        const existing = await db.frameworkRequirement.findUnique({
            where: { frameworkId_code: { frameworkId: fw.id, code: req.code } },
        });

        if (existing) {
            await db.frameworkRequirement.update({
                where: { id: existing.id },
                data: {
                    title: req.title,
                    description: req.description,
                    section: req.section,
                    category: req.category,
                    theme: req.theme,
                    themeNumber: req.themeNumber,
                    sortOrder: req.sortOrder ?? existing.sortOrder,
                    deprecatedAt: null, // Un-deprecate if previously deprecated
                },
            });
            updated++;
        } else {
            await db.frameworkRequirement.create({
                data: {
                    frameworkId: fw.id,
                    code: req.code,
                    title: req.title,
                    description: req.description,
                    section: req.section,
                    category: req.category,
                    theme: req.theme,
                    themeNumber: req.themeNumber,
                    sortOrder: req.sortOrder ?? 0,
                },
            });
            created++;
        }
    }

    // Soft-delete requirements not in the fixture
    if (options.deprecateMissing) {
        const result = await db.frameworkRequirement.updateMany({
            where: {
                frameworkId: fw.id,
                code: { notIn: codes },
                deprecatedAt: null,
            },
            data: { deprecatedAt: new Date() },
        });
        deprecated = result.count;
    }

    // Audit. There was NO audit anywhere in this file, so the most
    // destructive operation in the catalogue left no trace of who ran it or
    // what it removed. `deprecated` is the number that matters: it is the
    // count of practice points that just stopped counting for every tenant.
    await logEvent(prisma, ctx, {
        action: 'FRAMEWORK_REQUIREMENTS_UPSERTED',
        entityType: 'Framework',
        entityId: fw.id,
        details: `Catalogue requirements upserted for "${frameworkKey}"`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'Framework',
            operation: 'updated',
            after: {
                frameworkKey,
                created,
                updated,
                deprecated,
                deprecateMissing: options.deprecateMissing === true,
            },
            summary:
                `Catalogue "${frameworkKey}": ${created} created, ${updated} updated, ` +
                `${deprecated} deprecated`,
        },
    });

    return { frameworkKey, created, updated, deprecated };
}

// в”Ђв”Ђв”Ђ Diff Computation в”Ђв”Ђв”Ђ

export async function computeRequirementsDiff(
    ctx: RequestContext,
    frameworkKeyFrom: string,
    frameworkKeyTo: string
) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fwFrom = await db.framework.findFirst({ where: { key: frameworkKeyFrom } });
    const fwTo = await db.framework.findFirst({ where: { key: frameworkKeyTo } });
    if (!fwFrom) throw notFound(`Framework "${frameworkKeyFrom}" not found`);
    if (!fwTo) throw notFound(`Framework "${frameworkKeyTo}" not found`);

    const reqsFrom = await db.frameworkRequirement.findMany({
        where: { frameworkId: fwFrom.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });
    const reqsTo = await db.frameworkRequirement.findMany({
        where: { frameworkId: fwTo.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });

    const fromMap = new Map(reqsFrom.map((r) => [r.code, r]));
    const toMap = new Map(reqsTo.map((r) => [r.code, r]));

    const added: Array<{ code: string; title: string; section: string | null | undefined }> = [];
    const removed: Array<{ code: string; title: string; section: string | null | undefined }> = [];
    const changed: Array<{ code: string; changes: string[]; from: { title: string; section: string | null | undefined }; to: { title: string; section: string | null | undefined } }> = [];

    // Added in "to" but not in "from"
    for (const [code, req] of toMap) {
        if (!fromMap.has(code)) {
            added.push({ code, title: req.title, section: req.section || req.category });
        }
    }

    // Removed from "from" but not in "to"
    for (const [code, req] of fromMap) {
        if (!toMap.has(code)) {
            removed.push({ code, title: req.title, section: req.section || req.category });
        }
    }

    // Changed (title or section differ)
    for (const [code, reqTo] of toMap) {
        const reqFrom = fromMap.get(code);
        if (reqFrom) {
            const changes: string[] = [];
            if (reqFrom.title !== reqTo.title) changes.push('title');
            if ((reqFrom.section || reqFrom.category) !== (reqTo.section || reqTo.category)) changes.push('section');
            if (reqFrom.description !== reqTo.description) changes.push('description');
            if (changes.length > 0) {
                changed.push({
                    code,
                    changes,
                    from: { title: reqFrom.title, section: reqFrom.section || reqFrom.category },
                    to: { title: reqTo.title, section: reqTo.section || reqTo.category },
                });
            }
        }
    }

    // Compute impact: how many new requirements are unmapped for this tenant
    let unmappedNewCount = 0;
    if (added.length > 0) {
        const newReqIds = added.map((a) => {
            const req = toMap.get(a.code);
            return req?.id;
        }).filter((id): id is string => id !== undefined);

        const existingMappings = await runInTenantContext(ctx, (tdb) =>
            tdb.practiceRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirementId: { in: newReqIds } },
                select: { requirementId: true },
            })
        );
        const mappedIds = new Set(existingMappings.map((l) => l.requirementId));
        unmappedNewCount = newReqIds.filter((id) => !mappedIds.has(id)).length;
    }

    return {
        from: { key: fwFrom.key, name: fwFrom.name, version: fwFrom.version },
        to: { key: fwTo.key, name: fwTo.name, version: fwTo.version },
        added,
        removed,
        changed,
        summary: {
            added: added.length,
            removed: removed.length,
            changed: changed.length,
            unmappedNewRequirements: unmappedNewCount,
        },
    };
}
