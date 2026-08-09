/**
 * Entitlement mapping unit tests.
 * Tests feature-to-plan gating logic — no DB required.
 */

// Import entitlement functions directly (they're pure functions)
// We need to mock the prisma import since it's used by getTenantPlan
jest.mock('@/lib/prisma', () => ({}));

import {
    hasFeature,
    getAvailableFeatures,
    getRequiredPlan,
    FEATURES,
    planAllowsModule,
    planModules,
    getModuleMinPlan,
} from '@/lib/entitlements';

describe('Entitlements', () => {
    describe('hasFeature', () => {
        test('FREE plan has no premium features', () => {
            expect(hasFeature('FREE', FEATURES.PDF_EXPORTS)).toBe(false);
            expect(hasFeature('FREE', FEATURES.AUDIT_PACK_SHARING)).toBe(false);
            expect(hasFeature('FREE', FEATURES.ADVANCED_VENDOR_MGMT)).toBe(false);
            expect(hasFeature('FREE', FEATURES.CUSTOM_INTEGRATIONS)).toBe(false);
        });

        test('TRIAL plan has PDF_EXPORTS only', () => {
            expect(hasFeature('TRIAL', FEATURES.PDF_EXPORTS)).toBe(true);
            expect(hasFeature('TRIAL', FEATURES.AUDIT_PACK_SHARING)).toBe(false);
            expect(hasFeature('TRIAL', FEATURES.ADVANCED_VENDOR_MGMT)).toBe(false);
            expect(hasFeature('TRIAL', FEATURES.CUSTOM_INTEGRATIONS)).toBe(false);
        });

        test('PRO plan has PDF + sharing + vendor but not integrations', () => {
            expect(hasFeature('PRO', FEATURES.PDF_EXPORTS)).toBe(true);
            expect(hasFeature('PRO', FEATURES.AUDIT_PACK_SHARING)).toBe(true);
            expect(hasFeature('PRO', FEATURES.ADVANCED_VENDOR_MGMT)).toBe(true);
            expect(hasFeature('PRO', FEATURES.CUSTOM_INTEGRATIONS)).toBe(false);
        });

        test('ENTERPRISE plan has all features', () => {
            expect(hasFeature('ENTERPRISE', FEATURES.PDF_EXPORTS)).toBe(true);
            expect(hasFeature('ENTERPRISE', FEATURES.AUDIT_PACK_SHARING)).toBe(true);
            expect(hasFeature('ENTERPRISE', FEATURES.ADVANCED_VENDOR_MGMT)).toBe(true);
            expect(hasFeature('ENTERPRISE', FEATURES.CUSTOM_INTEGRATIONS)).toBe(true);
        });

        test('unknown plan defaults to no features', () => {
            expect(hasFeature('UNKNOWN', FEATURES.PDF_EXPORTS)).toBe(false);
        });
    });

    describe('getAvailableFeatures', () => {
        test('FREE has 0 features', () => {
            expect(getAvailableFeatures('FREE')).toHaveLength(0);
        });

        test('TRIAL has 1 feature', () => {
            expect(getAvailableFeatures('TRIAL')).toHaveLength(1);
            expect(getAvailableFeatures('TRIAL')).toContain('PDF_EXPORTS');
        });

        test('PRO has 3 features', () => {
            expect(getAvailableFeatures('PRO')).toHaveLength(3);
        });

        test('ENTERPRISE has 4 features', () => {
            expect(getAvailableFeatures('ENTERPRISE')).toHaveLength(4);
        });
    });

    describe('getRequiredPlan', () => {
        test('PDF_EXPORTS requires TRIAL', () => {
            expect(getRequiredPlan(FEATURES.PDF_EXPORTS)).toBe('TRIAL');
        });

        test('AUDIT_PACK_SHARING requires PRO', () => {
            expect(getRequiredPlan(FEATURES.AUDIT_PACK_SHARING)).toBe('PRO');
        });

        test('CUSTOM_INTEGRATIONS requires ENTERPRISE', () => {
            expect(getRequiredPlan(FEATURES.CUSTOM_INTEGRATIONS)).toBe('ENTERPRISE');
        });
    });

    // ─── Plan dimension of module gating ───
    //
    // A module is AVAILABLE when (plan allows) ∧ (tenant enabled). These
    // tests cover the PLAN half only — the tenant-toggle half lives in
    // tests/unit/modules.test.ts. The persona contract: agriculture core
    // (journal/inventory/planning) is FREE; the enterprise GRC + automation
    // modules are PRO; AI is ENTERPRISE; a null plan (self-hosted) allows all.

    describe('planAllowsModule', () => {
        test('null plan (self-hosted / unconfigured) allows every module', () => {
            expect(planAllowsModule(null, 'JOURNAL')).toBe(true);
            expect(planAllowsModule(null, 'CERTIFICATION')).toBe(true);
            expect(planAllowsModule(null, 'AI')).toBe(true);
        });

        test('FREE plan allows only the agriculture core (simple mode)', () => {
            expect(planAllowsModule('FREE', 'JOURNAL')).toBe(true);
            expect(planAllowsModule('FREE', 'INVENTORY')).toBe(true);
            expect(planAllowsModule('FREE', 'PLANNING')).toBe(true);
            // GRC + automation are gated above FREE.
            expect(planAllowsModule('FREE', 'CERTIFICATION')).toBe(false);
            expect(planAllowsModule('FREE', 'VENDORS')).toBe(false);
            expect(planAllowsModule('FREE', 'PROCESSES')).toBe(false);
            expect(planAllowsModule('FREE', 'AUTOMATION')).toBe(false);
            expect(planAllowsModule('FREE', 'AI')).toBe(false);
        });

        test('TRIAL plan still cannot reach the GRC tier (PRO)', () => {
            expect(planAllowsModule('TRIAL', 'JOURNAL')).toBe(true);
            expect(planAllowsModule('TRIAL', 'CERTIFICATION')).toBe(false);
            expect(planAllowsModule('TRIAL', 'AI')).toBe(false);
        });

        test('PRO plan unlocks the GRC + automation modules but not AI', () => {
            expect(planAllowsModule('PRO', 'CERTIFICATION')).toBe(true);
            expect(planAllowsModule('PRO', 'VENDORS')).toBe(true);
            expect(planAllowsModule('PRO', 'PROCESSES')).toBe(true);
            expect(planAllowsModule('PRO', 'AUTOMATION')).toBe(true);
            expect(planAllowsModule('PRO', 'AI')).toBe(false);
        });

        test('ENTERPRISE plan allows every module', () => {
            expect(planAllowsModule('ENTERPRISE', 'CERTIFICATION')).toBe(true);
            expect(planAllowsModule('ENTERPRISE', 'AI')).toBe(true);
        });

        test('unknown plan string is treated as the lowest tier', () => {
            // Unknown → level 0; only FREE-tier (level 0) modules pass.
            expect(planAllowsModule('UNKNOWN', 'JOURNAL')).toBe(true);
            expect(planAllowsModule('UNKNOWN', 'CERTIFICATION')).toBe(false);
        });
    });

    describe('planModules', () => {
        test('FREE → the core ag modules + the network-effect Exchange', () => {
            // Exchange is FREE by design (network-effect product) — so the
            // FREE tier is the three simple-mode modules PLUS Exchange.
            expect(planModules('FREE').sort()).toEqual(
                ['EXCHANGE', 'INVENTORY', 'JOURNAL', 'PLANNING'],
            );
        });

        test('PRO is a superset of FREE and includes CERTIFICATION', () => {
            const free = planModules('FREE');
            const pro = planModules('PRO');
            expect(free.every((m) => pro.includes(m))).toBe(true);
            expect(pro).toContain('CERTIFICATION');
            // AI + GRAIN are ENTERPRISE-tier — never unlocked at PRO.
            expect(pro).not.toContain('AI');
            expect(pro).not.toContain('GRAIN');
        });

        test('null plan returns the full module set', () => {
            expect(planModules(null)).toHaveLength(10);
            expect(planModules(null)).toContain('AI');
            expect(planModules(null)).toContain('GRAIN');
        });

        test('ENTERPRISE returns the full module set', () => {
            expect(planModules('ENTERPRISE')).toHaveLength(10);
            expect(planModules('ENTERPRISE')).toContain('GRAIN');
        });
    });

    describe('getModuleMinPlan', () => {
        test('agriculture core is FREE', () => {
            expect(getModuleMinPlan('JOURNAL')).toBe('FREE');
            expect(getModuleMinPlan('INVENTORY')).toBe('FREE');
            expect(getModuleMinPlan('PLANNING')).toBe('FREE');
        });

        test('CERTIFICATION (the GRC umbrella) is PRO', () => {
            expect(getModuleMinPlan('CERTIFICATION')).toBe('PRO');
        });

        test('AI is ENTERPRISE', () => {
            expect(getModuleMinPlan('AI')).toBe('ENTERPRISE');
        });

        test('GRAIN (enterprise-grain) is ENTERPRISE', () => {
            expect(getModuleMinPlan('GRAIN')).toBe('ENTERPRISE');
        });
    });
});
