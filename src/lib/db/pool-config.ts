/**
 * How many Postgres connections ONE container may hold open at once.
 *
 * ## Why this had to become explicit
 *
 * Nothing set it. Prisma 7 runs through `@prisma/adapter-pg`, so the pool is
 * `pg`'s, not the query engine's — which means the `connection_limit` query
 * parameter that the Prisma docs describe is READ BY NOBODY on this stack, and
 * the production `DATABASE_URL`
 * (`deploy/docker-compose.vm.yml`) does not carry one anyway. The effective
 * ceiling was therefore `pg`'s own default of 10 per container: a number
 * nobody chose, in no file, that moves if `pg` ever changes its default.
 *
 * ## The arithmetic, against the thing that actually runs out
 *
 * Measured on the VM 2026-10-01 and declared in `deploy/docker-compose.vm.yml`:
 *
 *   POOL_MODE: transaction      ← a SERVER connection is bound for the whole
 *                                 of a transaction, not the whole session
 *   DEFAULT_POOL_SIZE: "25"     ← per (user, database); one pair here, so 25
 *   MAX_CLIENT_CONN: "200"      ← client side, cheap, not the constraint
 *
 * Two containers hold pooled connections: `app` and `worker`. (`watchtower`,
 * `caddy`, `redis` and `db` hold none, and migrations use
 * `DIRECT_DATABASE_URL`, which bypasses pgbouncer entirely — so they do not
 * compete for these 25.)
 *
 * In transaction mode the binding resource is a server connection held for the
 * duration of a transaction, so the worst case this must stay inside is every
 * client connection in every container being in a transaction at once:
 *
 *   PG_POOL_MAX × 2 containers + 1 reserved ≤ 25
 *
 * which gives 12. One slot is held back for an operator's `psql` through
 * pgbouncer during an incident — the moment you least want the pool to be
 * exactly full.
 *
 * `tests/guards/pg-pool-size-fits-pgbouncer.test.ts` re-derives this against
 * the compose file rather than trusting the comment, because the numbers above
 * are a quotation and quotations rot.
 *
 * ## What is deliberately NOT set here
 *
 * `connectionTimeoutMillis`. `pg` waits indefinitely for a free client, so
 * exhaustion presents as a hang rather than an error — unpleasant, but adding
 * a timeout converts a transient burst into 500s, and that is a different
 * change with a different failure mode; capping the wait is the answer to a
 * different question and belongs with its own measurement.
 *
 * ## One claim here was wrong, and it is worth keeping the correction
 *
 * This docblock used to say the Exchange nesting removal in #1224 "takes away
 * the ONLY known way to exhaust the pool DEADLOCKED (a transaction holding one
 * client while waiting for a second)". That was false when written, and the
 * same PR's own implementation note said so: it measured TWO other second-
 * connection users and filed them as #1223. Un-nesting the notify removed one
 * route to the deadlock, not the class.
 *
 * Of those two, the DEK read is fixed — `src/lib/db-context.ts` pre-resolves
 * the tenant's DEK pair before `$transaction` opens, see `prewarmTenantKeys`.
 * `appendAuditEntry` still opens its own `$transaction` on the global client
 * for every audited write, so an AUDITED write's supportable concurrency is
 * still `PG_POOL_MAX - 1`; past it the audit row is lost silently rather than
 * erroring, because the extension's `catch` is best-effort by contract. See
 * the CLAUDE.md pool section for the measurement.
 */

/** pgbouncer `DEFAULT_POOL_SIZE` for the runtime user/database pair. */
export const PGBOUNCER_DEFAULT_POOL_SIZE = 25;

/** Containers that connect THROUGH pgbouncer: `app` and `worker`. */
export const POOLED_CONTAINERS = 2;

/** Kept free for an operator session during an incident. */
export const RESERVED_SERVER_CONNECTIONS = 1;

/**
 * `max` for the `pg` pool behind `PrismaPg`, per container.
 *
 * Derived, not typed in: a reader who changes `DEFAULT_POOL_SIZE` on the VM
 * and in the compose file gets a number that follows, and the guard fails if
 * the two stop agreeing.
 */
export const PG_POOL_MAX = Math.floor(
    (PGBOUNCER_DEFAULT_POOL_SIZE - RESERVED_SERVER_CONNECTIONS) / POOLED_CONTAINERS,
);
