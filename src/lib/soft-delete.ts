/**
 * Soft-Delete Middleware for Prisma
 *
 * Transforms hard deletes into soft deletes (setting deletedAt) and
 * automatically filters out soft-deleted records from reads.
 *
 * ALLOWLIST: Only models listed in SOFT_DELETE_MODELS are affected.
 * All other models retain hard-delete semantics.
 */
import { getAuditContext } from './audit-context';
import { SOFT_DELETE_TARGETS } from './security/classification';

// ─── Models that support soft delete ───
// DERIVED from SOFT_DELETE_TARGETS, not a hand-copy. The two were
// "documented mirrors" maintained by hand, and a third copy lived in
// tests/integration/soft-delete.test.ts — the comments there record that
// `Risk` had to be removed from all three in one diff. A mirror nothing
// enforces is how these drift, so there is one list now.
export const SOFT_DELETE_MODELS = new Set<string>(
    SOFT_DELETE_TARGETS.map((t) => t.model),
);

// ─── Read actions that should filter out deleted records ───

// ─── Delete actions to intercept ───

// ─── Internal flag for opt-out ───
const INCLUDE_DELETED_KEY = '__includeDeleted';

/**
 * Helper to opt out of soft-delete read filtering.
 * Usage: db.asset.findMany(withDeleted({ where: { tenantId } }))
 *
 * Sets a magic key that the middleware strips before passing to Prisma.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withDeleted<T extends Record<string, any>>(args: T): T {
    return { ...args, [INCLUDE_DELETED_KEY]: true };
}

/**
 * @deprecated v5 mutating shape — Prisma 7 removed `$use`. Use
 * `withSoftDeleteExtension(client)` instead, which returns a new
 * extended client. This stub remains so existing test files that
 * import the legacy name continue to compile; on the production
 * singleton in `src/lib/prisma.ts` the extension is already wired
 * via `withSoftDeleteExtension`, so this call is a no-op there.
 *
 * FIXME — remove once all callers have migrated to the extension.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSoftDeleteMiddleware(_client: any): void {
    /* no-op — see docstring */
}

/**
 * Wire the soft-delete extension onto a Prisma 7 client.
 *
 * Migrated from `client.$use(...)` (removed in Prisma 7) to
 * `client.$extends({ query: { $allModels: ... } })`. The semantics
 * are identical:
 *
 *   - `delete` / `deleteMany` on allowlisted models → transformed
 *     to `update` / `updateMany` setting `deletedAt`.
 *   - Read actions (`findUnique` / `findFirst` / `findMany` / `count`
 *     / `aggregate` / `groupBy`) → injected `where.deletedAt = null`
 *     unless the caller used `withDeleted(...)` or explicitly set
 *     a `deletedAt` filter.
 *
 * Composition: this extension MUST sit OUTSIDE the audit extension
 * so audit logs the transformed `update` operation, not the original
 * `delete`. The chain in `src/lib/prisma.ts` enforces this.
 *
 * Returns the extended client so callers can chain further extensions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSoftDeleteExtension<T extends { $extends: any }>(
    client: T,
): T {
    // Internal alias — the extended client carries per-model query
    // methods (`client.asset.update`, `.updateMany`, …) but the
    // generic `T` doesn't expose them statically. Cast through
    // `unknown` to a keyed record once; per-action handlers
    // dispatch into it without restating `as any` at every call
    // site, which keeps the file under the `as any` ratchet.
    type ModelOps = {
        update: (a: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => Promise<unknown>;
        updateMany: (a: {
            where?: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => Promise<unknown>;
    };
    const c = client as unknown as Record<string, ModelOps>;
    const modelOps = (model: string): ModelOps =>
        c[model.charAt(0).toLowerCase() + model.slice(1)];

    return client.$extends({
        name: 'soft-delete',
        query: {
            $allModels: {
                async delete({ model, args, query }: { model: string; args: { where?: Record<string, unknown> }; query: (a: unknown) => Promise<unknown> }) {
                    if (!SOFT_DELETE_MODELS.has(model)) return query(args);
                    const ctx = getAuditContext();
                    const deletedByUserId = ctx?.actorUserId || null;
                    // Transform delete → update — switch to the
                    // sibling client method since `query` is bound
                    // to the original `delete` operation.
                    return modelOps(model).update({
                        where: args.where,
                        data: { deletedAt: new Date(), deletedByUserId },
                    });
                },
                async deleteMany({ model, args, query }: { model: string; args: { where?: Record<string, unknown> }; query: (a: unknown) => Promise<unknown> }) {
                    if (!SOFT_DELETE_MODELS.has(model)) return query(args);
                    const ctx = getAuditContext();
                    const deletedByUserId = ctx?.actorUserId || null;
                    return modelOps(model).updateMany({
                        where: args.where,
                        data: { deletedAt: new Date(), deletedByUserId },
                    });
                },
                async findUnique({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async findFirst({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async findMany({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async count({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async aggregate({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
                async groupBy({ model, args, query }: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
                    return runRead(model, args, query);
                },
            },
        },
    }) as T;
}

/**
 * Shared read-action helper — strips the opt-out flag, respects
 * caller-supplied `deletedAt` filters, otherwise injects
 * `where.deletedAt = null` on allowlisted models.
 */
async function runRead(
    model: string,
    args: Record<string, unknown>,
    query: (a: unknown) => Promise<unknown>,
): Promise<unknown> {
    if (!SOFT_DELETE_MODELS.has(model)) return query(args);

    // Caller used `withDeleted(...)` — strip the magic flag and
    // pass through unchanged. (We mutate a shallow clone so we
    // don't perturb the caller's args object.)
    if ((args as Record<string, unknown>)[INCLUDE_DELETED_KEY]) {
        const next = { ...args } as Record<string, unknown>;
        delete next[INCLUDE_DELETED_KEY];
        return query(next);
    }

    const where = (args as { where?: Record<string, unknown> })?.where;
    if (where?.deletedAt !== undefined) {
        // Caller explicitly practices deletedAt — don't override
        return query(args);
    }

    // Inject deletedAt: null filter
    const next = {
        ...args,
        where: {
            ...((args as Record<string, unknown>).where as Record<string, unknown> | undefined),
            deletedAt: null,
        },
    };
    return query(next);
}
