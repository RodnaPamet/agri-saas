/**
 * Framework Coverage Policies
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';
import { assertPlatformSupport } from '@/lib/auth/platform-support';

export function assertCanViewFrameworks(ctx: RequestContext) {
    // All roles can view frameworks and coverage
    if (!ctx.role) throw forbidden('Authentication required');
}

export function assertCanInstallFrameworkPack(ctx: RequestContext) {
    // Epic 1 — OWNER is a superset of ADMIN per CLAUDE.md RBAC.
    //
    // This gates INSTALLING a pack into the caller's own tenant — it creates
    // Practice rows and PracticeRequirementLink rows, both tenant-scoped. It is
    // NOT sufficient for writing the catalogue itself; see
    // `assertCanWriteCatalogue` below for why that distinction matters.
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can install framework packs');
    }
}

/**
 * Gate a write to the GLOBAL framework catalogue.
 *
 * `Framework` and `FrameworkRequirement` carry no `tenantId`, and correctly so:
 * a shared catalogue with a per-tenant link table is the right architecture for
 * standards every farm is audited against. The defect was that tenant-scoped
 * routes could WRITE to it.
 *
 * Two paths did. `upsertRequirements` gated on
 * `assertCanInstallFrameworkPack`, which admits the OWNER or ADMIN of ANY
 * tenant — and with `deprecateMissing: true` it stamps `deprecatedAt` across
 * every requirement of the whole global framework. Deprecated requirements are
 * excluded from coverage and from the Statement of Applicability, so one farm
 * calling that endpoint silently zeroed every other farm's coverage, readiness
 * and SoA. `createScheme` gated on `assertCanAdmin` and then wrote a row into
 * the global table, so one farm's scheme name, description and requirement
 * titles appeared on every other farm's page, and the globally-unique key was
 * burned platform-wide with no delete path to recover it.
 *
 * Neither is a tenant operation. Curating a shared catalogue is platform work,
 * which is exactly what `assertPlatformSupport` exists for — the same gate the
 * global promotions and companies catalogues already use. It 404s outside the
 * designated platform tenant rather than 403-ing, so an unrelated farm's owner
 * is not even told the surface is there.
 *
 * The role check is NOT dropped: `assertPlatformSupport` calls `assertCanAdmin`
 * itself, so a reader inside the platform tenant still cannot write.
 */
export function assertCanWriteCatalogue(ctx: RequestContext) {
    assertPlatformSupport(ctx);
}
