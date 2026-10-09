/**
 * Integration Test: Epic A.1 RLS enforcement end-to-end.
 *
 * Proves the three invariants that make the RLS story production-grade:
 *
 *   1. `runInTenantContext` sets the `app.tenant_id` session variable
 *      inside a transaction scoped to `app_user`, and queries inside
 *      it only see own-tenant rows.
 *   2. `SET LOCAL` is transaction-scoped: a second, independent
 *      transaction without SET LOCAL sees nothing under `app_user`.
 *   3. `runWithoutRls` bypasses (superuser_bypass policy matches) and
 *      sees every row regardless of tenant.
 *
 * Also covers the two shapes the plain direct-tenantId case does not:
 *   - Denorm-tenantId child bound to its parent by a composite FK —
 *     EvidenceReview.
 *   - Nullable tenantId — IntegrationWebhookEvent.
 *
 * This test runs against the live Postgres (DB_AVAILABLE gate). It is
 * the authoritative proof that the RLS migration + middleware wiring
 * together make cross-tenant access architecturally impossible.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { PrismaClient } from '@prisma/client';
import {
    runInTenantContext,
    runWithoutRls,
} from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { getAuditContext, runWithAuditContext } from '@/lib/audit-context';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function makeCtx(tenantId: string): RequestContext {
    return {
        requestId: 'req-rls-int',
        userId: 'user-int',
        tenantId,
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

const SUFFIX = `rls_mw_${Date.now()}`;

describeFn('RLS middleware — live PostgreSQL enforcement', () => {
    let prisma: PrismaClient;
    let tenantA: string;
    let tenantB: string;
    let ruleAId: string;
    let reviewerUserId: string;
    let evidenceAId: string;
    let evidenceReviewId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const [a, b] = await Promise.all([
            prisma.tenant.upsert({
                where: { slug: `a-${SUFFIX}` },
                update: {},
                create: { name: 'Tenant A', slug: `a-${SUFFIX}` },
            }),
            prisma.tenant.upsert({
                where: { slug: `b-${SUFFIX}` },
                update: {},
                create: { name: 'Tenant B', slug: `b-${SUFFIX}` },
            }),
        ]);
        tenantA = a.id;
        tenantB = b.id;

        // Seed with raw prisma (superuser bypass) so the fixture is
        // reliably in place regardless of RLS.
        const rule = await prisma.automationRule.create({
            data: {
                tenantId: tenantA,
                name: `mw-rule-${SUFFIX}`,
                triggerEvent: 'TASK_CREATED',
                actionType: 'NOTIFY_USER',
                actionConfigJson: {},
                status: 'ENABLED',
            },
        });
        ruleAId = rule.id;

        const reviewer = await prisma.user.create({
            data: { email: `reviewer-${SUFFIX}@example.test`, name: 'MW Reviewer' },
        });
        reviewerUserId = reviewer.id;

        const evidence = await prisma.evidence.create({
            data: {
                tenantId: tenantA,
                type: 'TEXT',
                title: `mw-evidence-${SUFFIX}`,
            },
        });
        evidenceAId = evidence.id;

        const review = await prisma.evidenceReview.create({
            data: {
                tenantId: tenantA,
                evidenceId: evidenceAId,
                reviewerId: reviewerUserId,
                action: 'APPROVED',
            },
        });
        evidenceReviewId = review.id;
    });

    afterAll(async () => {
        try {
            await prisma.evidenceReview.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await prisma.automationRule.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await prisma.evidence.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await prisma.integrationWebhookEvent.deleteMany({
                where: { provider: { startsWith: `mw-${SUFFIX}` } },
            });
            await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
            await prisma.user.deleteMany({ where: { id: reviewerUserId } });
        } catch {
            /* best effort */
        }
        await prisma.$disconnect();
    });

    describe('Direct tenantId — Class A (AutomationRule)', () => {
        test('tenant-A context sees its own rule', async () => {
            const rows = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.automationRule.findMany({
                    where: { id: ruleAId },
                });
            });
            expect(rows).toHaveLength(1);
            expect(rows[0].tenantId).toBe(tenantA);
        });

        test('tenant-B context sees ZERO rows (cross-tenant blocked)', async () => {
            const rows = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.automationRule.findMany({
                    where: { id: ruleAId },
                });
            });
            expect(rows).toHaveLength(0);
        });

        test('tenant-B context cannot INSERT carrying tenantA id', async () => {
            // Under app_user, the WITH CHECK on the INSERT policy must
            // reject a row whose tenantId mismatches the session var.
            await expect(
                runInTenantContext(makeCtx(tenantB), async (db) => {
                    return db.automationRule.create({
                        data: {
                            tenantId: tenantA, // forged!
                            name: `forge-${SUFFIX}`,
                            triggerEvent: 'TASK_CREATED',
                            actionType: 'NOTIFY_USER',
                            actionConfigJson: {},
                        },
                    });
                })
            ).rejects.toThrow();
        });

        test('tenant-B context cannot UPDATE a tenant-A row to change its tenantId', async () => {
            // Row is visible only via postgres bypass; under app_user
            // the tenantB session can't even see the row to update.
            const result = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.automationRule.updateMany({
                    where: { id: ruleAId },
                    data: { name: `hijack-${SUFFIX}` },
                });
            });
            expect(result.count).toBe(0);
        });
    });

    describe('SET LOCAL scoping — transaction boundary holds', () => {
        test('sequential transactions do not leak tenant context', async () => {
            // First: tenantA — sees its rule.
            const first = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.automationRule.count({ where: { id: ruleAId } });
            });
            // Second: tenantB — sees 0 (session var reset between txns).
            const second = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.automationRule.count({ where: { id: ruleAId } });
            });
            expect(first).toBe(1);
            expect(second).toBe(0);
        });

        test('concurrent transactions do not share tenant context', async () => {
            const [a, b] = await Promise.all([
                runInTenantContext(makeCtx(tenantA), async (db) =>
                    db.automationRule.count({ where: { id: ruleAId } })
                ),
                runInTenantContext(makeCtx(tenantB), async (db) =>
                    db.automationRule.count({ where: { id: ruleAId } })
                ),
            ]);
            expect(a).toBe(1);
            expect(b).toBe(0);
        });
    });

    describe('runWithoutRls — explicit bypass path', () => {
        test('sees every tenant\'s rows regardless of filter', async () => {
            const rows = await runWithoutRls(
                { reason: 'test' },
                async (db) => {
                    return db.automationRule.findMany({
                        where: { id: ruleAId },
                    });
                }
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].tenantId).toBe(tenantA);
        });

        test('can INSERT on behalf of any tenant (seeds, admin scripts)', async () => {
            const created = await runWithoutRls(
                { reason: 'test' },
                async (db) => {
                    return db.automationRule.create({
                        data: {
                            tenantId: tenantB,
                            name: `bypass-create-${SUFFIX}`,
                            triggerEvent: 'TASK_CREATED',
                            actionType: 'NOTIFY_USER',
                            actionConfigJson: {},
                        },
                    });
                }
            );
            expect(created.tenantId).toBe(tenantB);
        });

        test('a DECLARED bypass does not trip the missing-tenant warning (#1431)', async () => {
            /**
             * The two halves used to not know about each other.
             * `runWithoutRls({ reason })` validated the reason, logged
             * `bypass_invoked`, and set NO AsyncLocalStorage state — while the
             * warning decided "is this deliberate?" from `source`, which the
             * typed allowlist knows nothing about. So a correctly-declared
             * WRITE still warned, and the only way to quieten it was the other
             * vocabulary: #1368 carried two wrappers for one intent.
             *
             * Nothing caught it because no bypass call site wrote. Measured on
             * main at the time: five `runWithoutRls` sites, all reads, and a
             * read takes the `logger.debug` branch.
             *
             * The test immediately above this one is a writing bypass and
             * passed throughout, because it asserts on the returned row and
             * not on the log.
             */
            const warns: Array<{ msg: string }> = [];
            const infos: Array<{ msg: string; meta: Record<string, unknown> }> = [];
            const warnSpy = jest
                .spyOn(logger, 'warn')
                .mockImplementation(((m: string) => {
                    warns.push({ msg: String(m) });
                }) as never);
            const infoSpy = jest
                .spyOn(logger, 'info')
                .mockImplementation(((m: string, meta?: unknown) => {
                    infos.push({
                        msg: String(m),
                        meta: (meta ?? {}) as Record<string, unknown>,
                    });
                }) as never);
            try {
                await runWithoutRls({ reason: 'test' }, async (db) => {
                    await db.automationRule.create({
                        data: {
                            tenantId: tenantB,
                            name: `declared-bypass-${SUFFIX}`,
                            triggerEvent: 'TASK_CREATED',
                            actionType: 'NOTIFY_USER',
                            actionConfigJson: {},
                        },
                    });
                });

                // CONTROL FIRST. Without it, "no warning" is satisfied by a
                // write that never reached the middleware at all, or by a
                // logger tap that captured nothing — which is the shape this
                // repo keeps finding behind green assertions.
                const invoked = infos.filter(
                    (l) => l.msg === 'rls-middleware.bypass_invoked',
                );
                expect(invoked.length).toBeGreaterThan(0);
                expect(invoked[0]!.meta.reason).toBe('test');

                // The property: no warning, with NO `source` override in play.
                expect(
                    warns.filter(
                        (l) => l.msg === 'rls-middleware.missing_tenant_context',
                    ),
                ).toHaveLength(0);
            } finally {
                warnSpy.mockRestore();
                infoSpy.mockRestore();
            }
        });

        test('the bypass SPREADS the outer audit context rather than replacing it', async () => {
            /**
             * `runWithAuditContext` installs a whole new store, so setting only
             * the reason would drop `tenantId`, `actorUserId` and `requestId`
             * for everything inside the bypass — which is how an audit row
             * loses its actor. #1368 avoided exactly that by spreading, and
             * this asserts the same property now that `runWithoutRls` is the
             * one doing it.
             */
            const observed = await runWithAuditContext(
                { tenantId: 'outer-tenant', actorUserId: 'outer-actor', requestId: 'req-outer' },
                async () =>
                    runWithoutRls({ reason: 'test' }, async () => getAuditContext()),
            );
            expect(observed?.tenantId).toBe('outer-tenant');
            expect(observed?.actorUserId).toBe('outer-actor');
            expect(observed?.requestId).toBe('req-outer');
            expect(observed?.rlsBypassReason).toBe('test');
        });
    });

    describe('Denorm-tenantId child — Class E (EvidenceReview)', () => {
        test('tenant-A sees its EvidenceReview row', async () => {
            const rows = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.evidenceReview.findMany({
                    where: { id: evidenceReviewId },
                });
            });
            expect(rows).toHaveLength(1);
        });

        test('tenant-B sees ZERO EvidenceReview rows from tenant-A', async () => {
            const rows = await runInTenantContext(makeCtx(tenantB), async (db) => {
                return db.evidenceReview.findMany({
                    where: { id: evidenceReviewId },
                });
            });
            expect(rows).toHaveLength(0);
        });

        test('tenant-B cannot create an EvidenceReview linking to a tenant-A parent', async () => {
            // denorm-tenantId Phase 3: rejection here is structural
            // (composite FK from (evidenceId, tenantId) to Evidence(id,
            // tenantId)) rather than RLS WITH CHECK. The call below
            // declares tenantId: tenantB (matching the calling
            // session) but evidenceId belongs to tenantA — no parent
            // row matches (evidenceAId, tenantB) so the FK rejects the
            // insert. That is what makes the trivial direct-tenantId
            // policy on this table safe: a row's tenantId is guaranteed
            // by the FK to equal its parent's.
            await expect(
                runInTenantContext(makeCtx(tenantB), async (db) => {
                    return db.evidenceReview.create({
                        data: {
                            tenantId: tenantB,
                            evidenceId: evidenceAId,
                            reviewerId: reviewerUserId,
                            action: 'APPROVED',
                        },
                    });
                })
            ).rejects.toThrow();
        });
    });

    describe('Nullable tenantId — Class C (IntegrationWebhookEvent)', () => {
        test('tenant context sees own-tenant and NULL-tenant rows', async () => {
            // Seed via bypass: one NULL-tenant event, one tenant-A.
            const [nullEvt, ownEvt] = await runWithoutRls(
                { reason: 'test' },
                async (db) => {
                return Promise.all([
                    db.integrationWebhookEvent.create({
                        data: {
                            provider: `mw-${SUFFIX}-null`,
                            payloadJson: {},
                        },
                    }),
                    db.integrationWebhookEvent.create({
                        data: {
                            tenantId: tenantA,
                            provider: `mw-${SUFFIX}-own`,
                            payloadJson: {},
                        },
                    }),
                ]);
                }
            );

            const rows = await runInTenantContext(makeCtx(tenantA), async (db) => {
                return db.integrationWebhookEvent.findMany({
                    where: { id: { in: [nullEvt.id, ownEvt.id] } },
                });
            });
            // USING allows NULL-or-own-tenant — both visible.
            expect(rows).toHaveLength(2);
        });

        test('app_user cannot INSERT a NULL-tenant row (WITH CHECK strict)', async () => {
            await expect(
                runInTenantContext(makeCtx(tenantA), async (db) => {
                    return db.integrationWebhookEvent.create({
                        data: {
                            tenantId: null,
                            provider: `mw-${SUFFIX}-forge-null`,
                            payloadJson: {},
                        },
                    });
                })
            ).rejects.toThrow();
        });
    });
});
