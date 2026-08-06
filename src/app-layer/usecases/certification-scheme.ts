import { RequestContext } from '../types';
import { assertCanViewFrameworks, assertCanWriteCatalogue } from '../policies/framework.policies';
import { logEvent } from '../events/audit';
import { getFramework, getFrameworkRequirements, listFrameworkPacks } from './framework/catalog';
import { generateReadinessReport, computeCoverage } from './framework/coverage';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { prisma } from '@/lib/prisma';

/**
 * Agriculture Certification Schemes (Certification Reseat).
 *
 * A "certification scheme" is modelled as a GLOBAL `Framework` row with
 * `kind = 'AG_SCHEME'`, and its requirements are ordinary
 * `FrameworkRequirement` rows. Because the catalog is uniform across
 * framework kinds, every downstream surface (control↔requirement
 * mapping, readiness scoring, coverage) works against AG_SCHEME rows
 * verbatim — this module is a thin, kind-filtered facade over the
 * existing framework catalog usecases. No new tenant-scoped tables, no
 * new link endpoints.
 *
 * Reads gate with `assertCanViewFrameworks` (every role may browse the
 * catalog, mirroring `listFrameworks`). Creating a scheme writes a GLOBAL
 * catalog entry every tenant reads, so it gates with
 * `assertCanWriteCatalogue` — the platform-tenant gate, not a per-tenant
 * admin check. `assertCanAdmin` was the original gate and was not sufficient:
 * it resolves from Role, so every farm's owner held it.
 */

// ─── Sanitisation helper (Epic D three-state) ──────────────────────
//
// `sanitizePlainText` returns '' for null/undefined, which would turn
// an absent optional into an empty-string write. This guard preserves
// the undefined / null / string three-state contract for optional
// free-text columns, matching the finding/risk/vendor write paths.
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

// ─── Read paths ────────────────────────────────────────────────────

/**
 * List every certification scheme (global AG_SCHEME frameworks),
 * key-ascending, with a requirement + pack count. Mirrors
 * `listFrameworks` but narrowed to the AG_SCHEME kind.
 */
export async function listSchemes(ctx: RequestContext) {
    assertCanViewFrameworks(ctx);
    return prisma.framework.findMany({
        where: { kind: 'AG_SCHEME' },
        include: { _count: { select: { requirements: true, packs: true } } },
        orderBy: { key: 'asc' },
    });
}

/**
 * Fetch a single scheme + its requirements. Reuses the catalog
 * `getFramework` / `getFrameworkRequirements`, asserting the resolved
 * framework is actually an AG_SCHEME so a compliance framework key
 * can't be read through the scheme surface.
 */
export async function getScheme(ctx: RequestContext, key: string) {
    const framework = await getFramework(ctx, key);
    if (framework.kind !== 'AG_SCHEME') throw notFound('Scheme not found');
    const requirements = await getFrameworkRequirements(ctx, key);
    return { framework, requirements };
}

// ─── Create ────────────────────────────────────────────────────────

export interface CreateSchemeRequirementInput {
    code: string;
    title: string;
    description?: string;
}

export interface CreateSchemeInput {
    key: string;
    name: string;
    description?: string;
    requirements: CreateSchemeRequirementInput[];
}

/**
 * Create a certification scheme: a global AG_SCHEME `Framework` plus its
 * `FrameworkRequirement` rows. Admin-gated (global catalog write). All
 * user-supplied free text is sanitised on write so every downstream
 * renderer (UI, PDF, audit pack, SDK) inherits the safety.
 */
export async function createScheme(ctx: RequestContext, input: CreateSchemeInput) {
    // PLATFORM gate, not a tenant one. This writes a row into the GLOBAL
    // Framework table that `listSchemes` reads with no tenant filter, so under
    // the previous per-tenant `assertCanAdmin` one farm's scheme — its name,
    // description and every requirement title — appeared on every other farm's
    // /schemes page, and the globally-unique `key` was burned platform-wide
    // with no delete path to recover it.
    //
    // Farms adopt standards; they do not author them. Authoring stays, behind
    // the platform gate, because the catalogue still has to come from
    // somewhere — see docs/implementation-notes for the fork decision.
    assertCanWriteCatalogue(ctx);

    const key = input.key?.trim();
    if (!key) throw badRequest('Scheme key required');
    if (!input.requirements || input.requirements.length === 0) {
        throw badRequest('At least one requirement required');
    }

    // Validate unique requirement codes within the input.
    const codes = input.requirements.map((r) => r.code);
    if (new Set(codes).size !== codes.length) {
        const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
        throw badRequest(`Duplicate requirement codes: ${[...new Set(dupes)].join(', ')}`);
    }

    // Reject a key that already names a framework (AG_SCHEME or otherwise)
    // — the `key` column is globally unique.
    const existing = await prisma.framework.findFirst({ where: { key }, select: { id: true } });
    if (existing) throw badRequest(`A framework with key "${key}" already exists`);

    const name = sanitizePlainText(input.name);
    const description = sanitizeOptional(input.description) ?? undefined;

    const framework = await prisma.framework.create({
        data: {
            key,
            name,
            description,
            kind: 'AG_SCHEME',
        },
    });

    // Requirements are a create-only batch (no read in a loop → no N+1).
    await prisma.frameworkRequirement.createMany({
        data: input.requirements.map((r, i) => ({
            frameworkId: framework.id,
            code: r.code,
            title: sanitizePlainText(r.title),
            description: sanitizeOptional(r.description) ?? undefined,
            sortOrder: i,
        })),
    });

    // Audit. `logEvent` ignores the `db` arg (it routes through the
    // global advisory-locked appendAuditEntry), so the global `prisma`
    // client is the correct, consistent handle for this catalog write.
    await logEvent(prisma, ctx, {
        action: 'CERTIFICATION_SCHEME_CREATED',
        entityType: 'Framework',
        entityId: framework.id,
        details: `Certification scheme "${name}" created with ${input.requirements.length} requirement(s)`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'Framework',
            operation: 'created',
            after: { key, name, kind: 'AG_SCHEME' },
            summary: 'Certification scheme created',
        },
        metadata: { key, requirementCount: input.requirements.length },
    });

    return getScheme(ctx, key);
}

// ─── Readiness ─────────────────────────────────────────────────────
//
// `getSchemeReadiness` lived here as a one-line wrapper over
// `generateReadinessReport` with ZERO callers — no route, no page, no test —
// alongside a `CACHE_KEYS.schemes.readiness` key pointing at
// `/schemes/:key/readiness`, a route that has never existed. Both are gone.
// Readiness reaches the UI through `getSchemeDetail`'s coverage block and
// through the framework readiness export, which are real.

/**
 * Everything the scheme detail page needs, in one call.
 *
 * `/schemes` was a dead end: rows had no `onRowClick`, there was no
 * `[schemeKey]` route, and the only working adoption path — `installPack`,
 * which genuinely creates controls and requirement links — lived at
 * `/frameworks/[key]/install`, reachable only through the command palette. A
 * farmer looking at a list of standards could not open one.
 *
 * The shape answers the three questions someone actually has in front of a
 * standard: what does it require, how much of it have I got, and what next.
 */
export async function getSchemeDetail(ctx: RequestContext, key: string) {
    assertCanViewFrameworks(ctx);

    const { framework, requirements } = await getScheme(ctx, key);
    const [coverage, packs] = await Promise.all([
        computeCoverage(ctx, key),
        listFrameworkPacks(ctx, key),
    ]);

    const satisfiedCodes = new Set(coverage.satisfiedRequirementCodes);
    const mappedCodes = new Set(coverage.controlMappings.map((m) => m.requirementCode));

    return {
        framework,
        packs,
        coverage: {
            total: coverage.total,
            mapped: coverage.mapped,
            unmapped: coverage.unmapped,
            coveragePercent: coverage.coveragePercent,
            satisfiedRequirements: coverage.satisfiedRequirements,
            applicableRequirements: coverage.applicableRequirements,
            satisfiedPercent: coverage.satisfiedPercent,
        },
        requirements: requirements.map((r) => ({
            code: r.code,
            title: r.title,
            description: r.description ?? null,
            section: r.section ?? r.category ?? null,
            // Three states, not two: MAPPED is a promise that a control
            // exists, SATISFIED is approved evidence against it. Collapsing
            // them is what made a fresh pack install read as fully covered.
            mapped: mappedCodes.has(r.code),
            satisfied: satisfiedCodes.has(r.code),
            controls: coverage.controlMappings
                .filter((m) => m.requirementCode === r.code)
                .map((m) => ({ code: m.controlCode, name: m.controlName, status: m.controlStatus })),
        })),
        /** Has this farm adopted the scheme at all? Drives adopt vs. re-apply. */
        adopted: coverage.mapped > 0,
    };
}
