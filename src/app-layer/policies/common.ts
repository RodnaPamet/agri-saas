import { RequestContext } from '../types';
import { forbidden, codedForbidden } from '@/lib/errors/types';

/**
 * Asserts the user has READ permission in their current context.
 *
 * ## No CURRENT role is refused by this, and that is deliberate (#1766)
 *
 * `canRead` is `level >= 1` and the lowest of the six roles — READER and
 * MECHANISATOR — are both level 1, so every real role passes. Measured over
 * `ROLE_ORDER` in `src/lib/tenant-context.ts`; the set of roles this can
 * refuse is EMPTY. It has 126 call sites.
 *
 * It is a RESERVATION of level 0, not a live gate. The ladder leaves that
 * level unused, so a future read-restricted role placed below READER makes
 * every one of those call sites bite at once, without touching them.
 *
 * **What this means for anyone reading a usecase and asking whether its read
 * is permission-gated: this line is not the answer.** The gates that actually
 * refuse a reader are membership resolution (`getTenantCtx` gives no context
 * to a non-member), `requirePermission(...)` on privileged routes, and RLS,
 * which returns zero rows outside the bound tenant. Nothing is exposed by the
 * reservation — it is the reviewer's expectation that is at risk.
 *
 * It also means a test asserting "role X cannot read" has to invent a context
 * no HTTP request produces, and would then read as coverage of a gate that
 * does not gate. Do not write one. Deleting this call from a usecase changes
 * no test, in either direction, which is the tell.
 *
 * Contrast `assertCanWrite` below, which is `level >= 3` and genuinely
 * refuses READER, MECHANISATOR and AUDITOR.
 *
 * Giving MECHANISATOR level 0 — which would make all 126 sites meaningful and
 * arguably corrects a real inconsistency, since `getPermissionsForRole`
 * already sets every fine-grained domain false for that persona — was
 * considered and deliberately NOT done here (owner ruling 2026-10-14). It is a
 * live permission change needing the operator's own two screens re-verified
 * first, because their task data must still load.
 */
export function assertCanRead(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view records in this context.');
    }
}

/**
 * Asserts the user has WRITE permission in their current context.
 *
 * ## Why this one carries a code and its siblings here do not yet (#1767)
 *
 * `canWrite` is `level >= 3`, so it genuinely refuses three of the six roles —
 * READER, MECHANISATOR and AUDITOR — across 106 call sites. Measured, and the
 * contrast is the point: `assertCanRead` above is `level >= 1` and can refuse
 * NOBODY (#1766), so coding it would advertise a distinction no request can
 * reach.
 *
 * Until now the refusal was uncoded, which left a client nothing to switch on.
 * `agrent-ios` asked for this directly: with no code the phone shows its
 * generic «Нямате права за това действие.» — correct and useless, because the
 * operator cannot tell "this farm's role does not allow it, ask an
 * administrator" from "this action is not available here". Only one of those
 * is actionable by the person holding the phone.
 *
 * ## ONE code with `params.role`, not three per-role codes
 *
 * #1767's recommended option, and the reason is that the three refused roles
 * differ only in which screens they otherwise see — the refusal is the same
 * condition. A client that wants to name the role reads `params.role`; three
 * codes for one condition would be a distinction the server asserts and no
 * client needs.
 *
 * ## The English sentence STAYS
 *
 * A bare code with no `message` regresses a Bulgarian farmer to an
 * untranslated string on any client that has no entry for it — the
 * `coded-message-is-displayed-copy` rule. The sentence is unchanged, so this
 * adds a switchable code without taking anything away from a client that
 * renders `message`. It also makes this one of #1712's server-authored-copy
 * sites fixable in ONE place behind 106 call sites.
 *
 * `assertCanAdmin` below was the same gap at 51 sites and is coded now too
 * (#1779), with its OWN code rather than this one or the Edge's — see its
 * docblock for why the three conditions have to stay distinguishable.
 */
export function assertCanWrite(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw codedForbidden(
            'WRITE_FORBIDDEN_FOR_ROLE',
            'You do not have permission to modify records in this context.',
            { role: ctx.role },
        );
    }
}

/**
 * Asserts the user has ADMIN permission in their current context.
 *
 * ## Why its own code, and not `ADMIN_REQUIRED` (#1779)
 *
 * THREE conditions mean "admin" in this product and a client may want to tell
 * them apart:
 *
 *   • `ADMIN_REQUIRED` — raised by `src/middleware.ts` at the **Edge**: the
 *     ROUTE is admin-only and this role is not admin. "This whole area is not
 *     for you."
 *   • `ADMIN_FORBIDDEN_FOR_ROLE` — raised HERE, from a usecase: the route is
 *     NOT admin-only, the caller reached the handler legitimately, and this
 *     particular operation needs admin. "This action, within an area you can
 *     use, is not for you."
 *   • `WRITE_FORBIDDEN_FOR_ROLE` — the same shape one level down (#1767).
 *
 * A role can pass the Edge and still meet this check, so collapsing the first
 * two would make them indistinguishable on the wire. A client showing one
 * sentence for both would tell an EDITOR they lack access to a screen they are
 * currently looking at.
 *
 * Renaming the Edge code to `ADMIN_ROUTE_REQUIRED` and taking `ADMIN_REQUIRED`
 * for this would read better and was rejected: `ADMIN_REQUIRED` is one of the
 * four codes the spec singles out as reachable on EVERY route and worth
 * switching on, which makes it the most likely of all of them to be live in a
 * shipped client. A nicer name is not worth a breaking change to the one code
 * most likely already in use.
 *
 * Symmetric with `WRITE_FORBIDDEN_FOR_ROLE`, `params.role` included for the
 * same reason: a client can name the role the person actually holds instead of
 * guessing.
 *
 * The English `message` STAYS. A bare code regresses a Bulgarian farmer to an
 * untranslated string on any client with no entry for it — the
 * `coded-message-is-displayed-copy` rule, and the reason #1767 kept its
 * sentence. It also makes this one of #1712's server-authored-copy sites
 * fixable in ONE place behind 51 call sites.
 */
export function assertCanAdmin(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin) {
        throw codedForbidden(
            'ADMIN_FORBIDDEN_FOR_ROLE',
            'You do not have permission to perform administrative actions in this context.',
            { role: ctx.role },
        );
    }
}

/**
 * Asserts the user has AUDIT permission in their current context.
 *
 * ONE call site, and coded in the same change as `assertCanAdmin` (#1779) for
 * consistency rather than on its own merits: three sibling helpers raising two
 * coded refusals and one bare string is the state that invites the next reader
 * to assume the bare one is deliberate. It refuses EDITOR, READER and
 * MECHANISATOR.
 */
export function assertCanAudit(ctx: RequestContext) {
    if (!ctx.permissions.canAudit) {
        throw codedForbidden(
            'AUDIT_FORBIDDEN_FOR_ROLE',
            'You do not have permission to perform audit actions in this context.',
            { role: ctx.role },
        );
    }
}

/**
 * Asserts the user may verify a stored file's integrity hash.
 *
 * Moved here from `audit-readiness.policies.ts` in GRC teardown phase 2,
 * with its role set PRESERVED VERBATIM. The set is deliberately narrower
 * than `assertCanRead`: file-integrity verification returns a SHA-256 and a
 * size for a given file, and a `matches` boolean turns the endpoint into an
 * oracle. `verifyFileIntegrity` was once gated on a check that admitted
 * every role including an external auditor; narrowing it to
 * OWNER / ADMIN / AUDITOR is what closed that. Widening this back to a
 * permission flag (`canAudit` admits AUDITOR but the role list is the
 * documented contract) would re-open it, so the literal list stays.
 */
export function assertCanVerifyIntegrity(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'AUDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN or AUDITOR can verify file integrity');
    }
}
