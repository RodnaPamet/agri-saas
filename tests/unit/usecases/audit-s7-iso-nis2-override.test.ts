/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks mirror the runtime contracts; per-line typing has poor
 * cost/benefit here (matches the codebase's standard test pattern).
 */
/**
 * Audit S7 — ISO27001 + NIS2 honour Tenant.readinessWeightsJson.
 *
 * Behavioural counterpart to `tests/guardrails/audit-s7-iso-nis2-weights.test.ts`
 * (the structural ratchet). This file exercises the runtime path:
 * a tenant with `readinessWeightsJson` set to a custom shape
 * produces a `breakdown` whose `weight` fields reflect the OVERRIDE,
 * not the hardcoded defaults — proving the seam actually moves
 * data end-to-end.
 *
 * The unit-test mock surface is minimal: stub
 * `runInTenantContext` with a deterministic call sequence, return
 * the override JSON from the tenant lookup, then assert the
 * returned breakdown.
 */

jest.mock("@/lib/db-context", () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock("../../../src/app-layer/events/audit", () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/app-layer/usecases/audit-readiness", () => ({
    addAuditPackItems: jest.fn().mockResolvedValue({ ok: true }),
}));

import {
    computeReadiness,
    ISO_WEIGHTS,
    NIS2_WEIGHTS,
} from "@/app-layer/usecases/audit-readiness-scoring";
import { runInTenantContext } from "@/lib/db-context";
import type { RequestContext } from "@/app-layer/types";

const mockRunInTx = runInTenantContext as jest.MockedFunction<
    typeof runInTenantContext
>;

function makeRequestContext(): RequestContext {
    // Test mock: the shape diverges from the production
    // RequestContext (role enum, permission-set shape), so the
    // double-cast through `unknown` is required by tsconfig's
    // strict overlap check.
    return {
        tenantId: "tenant-1",
        userId: "user-1",
        role: "ADMIN",
        permissions: ["audit.read", "audit.view_pack"],
        appPermissions: {
            policies: { read: true, write: true, delete: true, admin: true },
            practices: { read: true, write: true, delete: true, admin: true },
            risks: { read: true, write: true, delete: true, admin: true },
            evidence: { read: true, write: true, delete: true, admin: true },
            audits: { read: true, write: true, delete: true, admin: true, view_pack: true },
            settings: { read: true, write: true },
        },
    } as unknown as RequestContext;
}

beforeEach(() => {
    mockRunInTx.mockReset();
});

describe("Audit S7 — computeISO27001Readiness honours the override", () => {
    it("breakdown reports the override weights, not the hardcoded defaults", async () => {
        // Custom ISO27001 override — emphasises coverage + evidence,
        // de-emphasises everything else. Sum = 1.0 (validation gate).
        const override = {
            ISO27001: {
                coverage: 0.5,
                implementation: 0.1,
                evidence: 0.3,
                tasks: 0.05,
                issues: 0.05,
            },
        };

        // 1. cycle lookup
        mockRunInTx.mockImplementationOnce(async () =>
            ({ id: "c1", frameworkKey: "ISO27001" }) as never,
        );
        // 2. loadEffectiveWeights — returns the override.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                tenant: {
                    findUnique: jest.fn().mockResolvedValue({
                        readinessWeightsJson: override,
                    }),
                },
            } as never),
        );
        // 3. framework lookup
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                framework: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );
        // 4. practices lookup
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                practice: { findMany: jest.fn().mockResolvedValue([]) },
            } as never),
        );
        // 5. practicesWithEvidence
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                practice: { findMany: jest.fn().mockResolvedValue([]) },
            } as never),
        );
        // 6. overdue tasks
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        // 7. open issues
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        // 8. snapshot create (best-effort)
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                readinessSnapshot: { create: jest.fn().mockResolvedValue({}) },
            } as never),
        );
        // 9. logEvent
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({} as never),
        );

        const result = await computeReadiness(makeRequestContext(), "c1");

        // The breakdown's `weight` fields must equal the override, not
        // the hardcoded defaults.
        const b = result.breakdown as unknown as Record<string, { weight: number }>;
        expect(b.coverage.weight).toBe(0.5);
        expect(b.implementation.weight).toBe(0.1);
        expect(b.evidence.weight).toBe(0.3);
        expect(b.tasks.weight).toBe(0.05);
        expect(b.issues.weight).toBe(0.05);

        // Sanity — the hardcoded defaults differ from the override,
        // so the test is meaningful.
        expect(ISO_WEIGHTS.coverage).not.toBe(0.5);
        expect(ISO_WEIGHTS.implementation).not.toBe(0.1);
    });

    it("invalid override (sum != 1.0) falls back to defaults", async () => {
        // Sum = 0.9 — outside the loadEffectiveWeights validation
        // tolerance. The helper returns the defaults instead.
        const invalid = {
            ISO27001: {
                coverage: 0.5,
                implementation: 0.1,
                evidence: 0.2,
                tasks: 0.05,
                issues: 0.05, // sum = 0.9, not 1.0
            },
        };

        mockRunInTx.mockImplementationOnce(async () =>
            ({ id: "c1", frameworkKey: "ISO27001" }) as never,
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                tenant: {
                    findUnique: jest
                        .fn()
                        .mockResolvedValue({ readinessWeightsJson: invalid }),
                },
            } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                framework: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ practice: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ practice: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                readinessSnapshot: { create: jest.fn().mockResolvedValue({}) },
            } as never),
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({} as never),
        );

        const result = await computeReadiness(makeRequestContext(), "c1");
        const b = result.breakdown as unknown as Record<string, { weight: number }>;

        // Falls back to the hardcoded defaults.
        expect(b.coverage.weight).toBe(ISO_WEIGHTS.coverage);
        expect(b.implementation.weight).toBe(ISO_WEIGHTS.implementation);
        expect(b.evidence.weight).toBe(ISO_WEIGHTS.evidence);
        expect(b.tasks.weight).toBe(ISO_WEIGHTS.tasks);
        expect(b.issues.weight).toBe(ISO_WEIGHTS.issues);
    });
});

describe("Audit S7 — computeNIS2Readiness honours the override", () => {
    it("breakdown reports the NIS2 override weights", async () => {
        const override = {
            NIS2: {
                coverage: 0.5,
                evidence: 0.2,
                policies: 0.2,
                issues: 0.1,
            },
        };

        mockRunInTx.mockImplementationOnce(async () =>
            ({ id: "c1", frameworkKey: "NIS2" }) as never,
        );
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                tenant: {
                    findUnique: jest
                        .fn()
                        .mockResolvedValue({ readinessWeightsJson: override }),
                },
            } as never),
        );
        // framework lookup
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                framework: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );
        // practiceIds = [] → falls into all-practices branch
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ practice: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        // practicesWithEv (empty)
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ practice: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        // policies lookup
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ policy: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        // open issues
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { findMany: jest.fn().mockResolvedValue([]) } } as never),
        );
        // snapshot create
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                readinessSnapshot: { create: jest.fn().mockResolvedValue({}) },
            } as never),
        );
        // logEvent
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({} as never),
        );

        const result = await computeReadiness(makeRequestContext(), "c1");
        const b = result.breakdown as unknown as Record<string, { weight: number }>;

        expect(b.coverage.weight).toBe(0.5);
        expect(b.evidence.weight).toBe(0.2);
        expect(b.policies.weight).toBe(0.2);
        expect(b.issues.weight).toBe(0.1);

        // Sanity — the override differs from defaults so the assertion
        // would fail on a regression.
        expect(NIS2_WEIGHTS.coverage).not.toBe(0.5);
    });
});
