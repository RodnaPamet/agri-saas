/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * WP-2 module gating — unit tests.
 *
 * Two surfaces in one file:
 *   1. `src/lib/modules.ts` — pure helpers (no DB). The default-all
 *      contract (`resolveEnabledModules(null)` → every module) is the
 *      load-bearing invariant: gating a route stays backward-compatible
 *      until a tenant explicitly opts into a restricted list.
 *   2. `src/app-layer/usecases/modules.ts` — the DB-backed gate. Mocks
 *      the repository + db-context + audit emitter; uses real policy
 *      helpers via the role on the RequestContext so the read/admin
 *      gates are exercised for real.
 *
 * Also satisfies the usecase-test-coverage guardrail (every usecase
 * file must be imported by a test).
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/ModuleSettingsRepository', () => ({
    ModuleSettingsRepository: {
        get: jest.fn(),
        upsert: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

// The plan dimension of gating goes through getTenantPlan (a DB read).
// Mock just that — `planAllowsModule` / `planModules` stay REAL (pure
// logic). Default is `null` (self-hosted / billing-unconfigured), which
// allows every module, so the tenant-toggle tests below behave exactly as
// they did before the plan dimension landed.
const mockGetTenantPlan = jest.fn();
jest.mock('@/lib/entitlements-server', () => ({
    getTenantPlan: (tenantId: string) => mockGetTenantPlan(tenantId),
}));

import { ModuleSettingsRepository } from '@/app-layer/repositories/ModuleSettingsRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    ALL_MODULES,
    MODULE_LABELS,
    resolveEnabledModules,
    isModuleEnabledIn,
    coerceModuleKeys,
} from '@/lib/modules';
import {
    getEnabledModules,
    getModuleSettings,
    setEnabledModules,
    isModuleEnabled,
    assertModuleEnabled,
    getAvailableModules,
    isModuleAvailable,
} from '@/app-layer/usecases/modules';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    // Default: no billing account → plan null → plan allows every module.
    mockGetTenantPlan.mockResolvedValue(null);
});

const adminCtx = makeRequestContext('ADMIN', { userId: 'user-admin' });
const readerCtx = makeRequestContext('READER');

// ─── src/lib/modules.ts — pure helpers ─────────────────────────────

describe('pure helpers', () => {
    it('ALL_MODULES enumerates the nine canonical module keys', () => {
        expect(ALL_MODULES).toEqual([
            'JOURNAL',
            'INVENTORY',
            'PLANNING',
            'CERTIFICATION',
            'AUTOMATION',
            'PROCESSES',
            'AI',
            'GRAIN',
            'EXCHANGE',
        ]);
    });

    it('MODULE_LABELS has a non-empty label for every module key', () => {
        for (const key of ALL_MODULES) {
            expect(MODULE_LABELS[key]).toBeTruthy();
            expect(typeof MODULE_LABELS[key]).toBe('string');
        }
        // No stray labels for non-existent keys.
        expect(Object.keys(MODULE_LABELS).sort()).toEqual([...ALL_MODULES].sort());
    });

    it('every module key has description copy IN BOTH LOCALES', () => {
        // `MODULE_DESCRIPTIONS` was a hardcoded English map in `lib/modules.ts`,
        // so a Bulgarian operator read English on the settings page whatever
        // their locale. The copy moved to next-intl; this assertion moved with
        // it, and gained the half that matters — the invariant is not "a
        // description exists" but "a description exists in every language the
        // product ships".
        const en = require('../../messages/en.json').admin.modules;
        const bg = require('../../messages/bg.json').admin.modules;
        for (const key of ALL_MODULES) {
            expect(en[`desc_${key}`]).toBeTruthy();
            expect(bg[`desc_${key}`]).toBeTruthy();
            // A Bulgarian value identical to the English one is an
            // untranslated string wearing a translation's clothes.
            expect(bg[`desc_${key}`]).not.toBe(en[`desc_${key}`]);
        }
    });

    it('resolveEnabledModules(null) returns ALL modules (default-on contract)', () => {
        expect(resolveEnabledModules(null)).toEqual([...ALL_MODULES]);
        expect(resolveEnabledModules(undefined)).toEqual([...ALL_MODULES]);
        // Returns a fresh array — callers must not mutate the constant.
        expect(resolveEnabledModules(null)).not.toBe(ALL_MODULES);
    });

    it('resolveEnabledModules(row) returns the row list verbatim', () => {
        expect(resolveEnabledModules({ enabledModules: ['JOURNAL', 'INVENTORY'] })).toEqual([
            'JOURNAL',
            'INVENTORY',
        ]);
        // An empty list is a real restriction, NOT a default-on trigger.
        expect(resolveEnabledModules({ enabledModules: [] })).toEqual([]);
    });

    it('isModuleEnabledIn membership test', () => {
        expect(isModuleEnabledIn(['JOURNAL', 'AI'], 'AI')).toBe(true);
        expect(isModuleEnabledIn(['JOURNAL', 'AI'], 'INVENTORY')).toBe(false);
        expect(isModuleEnabledIn([], 'JOURNAL')).toBe(false);
    });

    it('coerceModuleKeys filters unknown strings to known ModuleKeys', () => {
        expect(coerceModuleKeys(['JOURNAL', 'NONSENSE', 'AI', ''])).toEqual(['JOURNAL', 'AI']);
        expect(coerceModuleKeys([])).toEqual([]);
        expect(coerceModuleKeys(['journal'])).toEqual([]); // case-sensitive
    });
});

// ─── getEnabledModules / isModuleEnabled ───────────────────────────

describe('getEnabledModules', () => {
    it('returns ALL modules when the tenant has no settings row', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        expect(await getEnabledModules(readerCtx)).toEqual([...ALL_MODULES]);
    });

    it('returns the saved list when a settings row exists', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL', 'PLANNING'],
        });
        expect(await getEnabledModules(readerCtx)).toEqual(['JOURNAL', 'PLANNING']);
    });
});

describe('isModuleEnabled', () => {
    it('true when present in the resolved set', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['CERTIFICATION'],
        });
        expect(await isModuleEnabled(readerCtx, 'CERTIFICATION')).toBe(true);
    });

    it('false when the tenant has restricted it away', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL'],
        });
        expect(await isModuleEnabled(readerCtx, 'CERTIFICATION')).toBe(false);
    });

    it('true by default (no row) — gating is backward-compatible', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        expect(await isModuleEnabled(readerCtx, 'CERTIFICATION')).toBe(true);
    });
});

// ─── assertModuleEnabled ───────────────────────────────────────────

describe('assertModuleEnabled', () => {
    it('passes silently when the module is enabled', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['CERTIFICATION'],
        });
        await expect(assertModuleEnabled(readerCtx, 'CERTIFICATION')).resolves.toBeUndefined();
    });

    it('refuses with reason "tenant" when the FARM turned it off', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL'],
        });
        await expect(assertModuleEnabled(readerCtx, 'CERTIFICATION')).rejects.toMatchObject({
            status: 403,
            code: 'MODULE_DISABLED',
            // `reason` is the half that decides what a client may truthfully
            // say. This is the half where "ask your farm administrator" is
            // true.
            params: { module: 'CERTIFICATION', reason: 'tenant' },
        });
    });

    it('refuses with reason "plan" when the PLAN excludes it, even if the farm enabled it', async () => {
        // FREE cannot reach CERTIFICATION (PRO). The plan half fails first,
        // regardless of the tenant toggle — and here NO administrator can turn
        // it on, which is why the two cannot share one answer. Collapsing them
        // is the agrent-ios#241 shape: a farmer sent to an admin who cannot
        // help. Found by agrent-ios reading the conjunction in
        // `isModuleAvailable` against #1679's first spec text, which claimed an
        // administrator could always lift it.
        mockGetTenantPlan.mockResolvedValue('FREE');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['CERTIFICATION'],
        });
        await expect(assertModuleEnabled(readerCtx, 'CERTIFICATION')).rejects.toMatchObject({
            status: 403,
            code: 'MODULE_DISABLED',
            params: { module: 'CERTIFICATION', reason: 'plan' },
        });
    });

    it('the two reasons are DIFFERENT — the control', async () => {
        // Without this, a `reason` hardcoded to one value would satisfy one of
        // the two assertions above and read as covered.
        const reasonFor = async (plan: string | null, enabled: string[]) => {
            mockGetTenantPlan.mockResolvedValue(plan);
            (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
                enabledModules: enabled,
            });
            try {
                await assertModuleEnabled(readerCtx, 'CERTIFICATION');
                return 'allowed';
            } catch (e) {
                return (e as { params?: { reason?: string } }).params?.reason ?? 'none';
            }
        };
        expect(await reasonFor('FREE', ['CERTIFICATION'])).toBe('plan');
        expect(await reasonFor(null, ['JOURNAL'])).toBe('tenant');
        // And the happy path still passes, so neither branch fires always.
        expect(await reasonFor(null, ['CERTIFICATION'])).toBe('allowed');
    });

    it('names the module in the thrown message on BOTH halves', async () => {
        // The legacy `module_disabled:` prefix is gone (#1677) — agrent-ios
        // confirmed its only installed build reads the code. What still has to
        // hold is that the module is NAMED, on both throw sites: the plan half
        // is the newer one and a new site is exactly where a detail gets
        // forgotten. The reader-facing sentence comes from the catalogue, keyed
        // on the code and its `reason`; this is the developer-facing fallback.
        mockGetTenantPlan.mockResolvedValue('FREE');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['CERTIFICATION'],
        });
        await expect(assertModuleEnabled(readerCtx, 'CERTIFICATION')).rejects.toThrow(
            /CERTIFICATION/,
        );
        mockGetTenantPlan.mockResolvedValue(null);
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL'],
        });
        await expect(assertModuleEnabled(readerCtx, 'CERTIFICATION')).rejects.toThrow(
            /CERTIFICATION/,
        );
    });
});

// ─── isModuleAvailable — plan ∧ tenant ─────────────────────────────

describe('isModuleAvailable', () => {
    it('available when plan allows AND tenant enabled', async () => {
        mockGetTenantPlan.mockResolvedValue('PRO');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['CERTIFICATION'],
        });
        expect(await isModuleAvailable(readerCtx, 'CERTIFICATION')).toBe(true);
    });

    it('NOT available when the plan blocks it (FREE → CERTIFICATION)', async () => {
        mockGetTenantPlan.mockResolvedValue('FREE');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null); // all tenant-enabled
        expect(await isModuleAvailable(readerCtx, 'CERTIFICATION')).toBe(false);
        // FREE still reaches the agriculture core.
        expect(await isModuleAvailable(readerCtx, 'JOURNAL')).toBe(true);
    });

    it('NOT available when the tenant toggled it off (even on PRO)', async () => {
        mockGetTenantPlan.mockResolvedValue('PRO');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL'],
        });
        expect(await isModuleAvailable(readerCtx, 'CERTIFICATION')).toBe(false);
    });

    it('null plan (self-hosted) defers entirely to the tenant toggle', async () => {
        mockGetTenantPlan.mockResolvedValue(null);
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        expect(await isModuleAvailable(readerCtx, 'CERTIFICATION')).toBe(true);
    });
});

// ─── getAvailableModules — the intersection list ───────────────────

describe('getAvailableModules', () => {
    it('FREE plan + all-enabled tenant → the core ag modules + Exchange', async () => {
        mockGetTenantPlan.mockResolvedValue('FREE');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        // Exchange is FREE (network-effect product), so it joins the three
        // simple-mode modules in the FREE-plan availability set.
        expect((await getAvailableModules(readerCtx)).sort()).toEqual(
            ['EXCHANGE', 'INVENTORY', 'JOURNAL', 'PLANNING'],
        );
    });

    it('PRO plan + all-enabled tenant → core + CERTIFICATION, never AI', async () => {
        mockGetTenantPlan.mockResolvedValue('PRO');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        const available = await getAvailableModules(readerCtx);
        expect(available).toContain('CERTIFICATION');
        expect(available).toContain('JOURNAL');
        expect(available).not.toContain('AI');
    });

    it('intersects the two dimensions — PRO plan but tenant restricted to JOURNAL', async () => {
        mockGetTenantPlan.mockResolvedValue('PRO');
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL', 'CERTIFICATION'],
        });
        // Plan allows both; tenant enabled both → both available.
        expect((await getAvailableModules(readerCtx)).sort()).toEqual(['CERTIFICATION', 'JOURNAL']);
    });

    it('null plan defers to the tenant list verbatim', async () => {
        mockGetTenantPlan.mockResolvedValue(null);
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            enabledModules: ['JOURNAL', 'AI'],
        });
        expect((await getAvailableModules(readerCtx)).sort()).toEqual(['AI', 'JOURNAL']);
    });
});

// ─── getModuleSettings (admin read) ────────────────────────────────

describe('getModuleSettings', () => {
    it('returns the customised shape when a row exists', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue({
            id: 'tms-1',
            enabledModules: ['JOURNAL', 'INVENTORY'],
        });
        const out = await getModuleSettings(adminCtx);
        expect(out).toEqual({
            enabledModules: ['JOURNAL', 'INVENTORY'],
            customized: true,
            allModules: [...ALL_MODULES],
        });
    });

    it('reports customized:false and the default list when no row exists', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        const out = await getModuleSettings(adminCtx);
        expect(out.customized).toBe(false);
        expect(out.enabledModules).toEqual([...ALL_MODULES]);
    });

    it('READER passes the read gate (settings are readable to view the UI)', async () => {
        (ModuleSettingsRepository.get as jest.Mock).mockResolvedValue(null);
        await expect(getModuleSettings(readerCtx)).resolves.toBeDefined();
    });
});

// ─── setEnabledModules (admin write) ───────────────────────────────

describe('setEnabledModules', () => {
    it('upserts the list, audits, and returns the saved modules', async () => {
        (ModuleSettingsRepository.upsert as jest.Mock).mockResolvedValue({
            id: 'tms-1',
            enabledModules: ['JOURNAL', 'PLANNING'],
        });

        const out = await setEnabledModules(adminCtx, ['JOURNAL', 'PLANNING']);

        expect(ModuleSettingsRepository.upsert).toHaveBeenCalledWith(mockDb, adminCtx, [
            'JOURNAL',
            'PLANNING',
        ]);
        expect(out).toEqual({ enabledModules: ['JOURNAL', 'PLANNING'] });

        expect(logEvent).toHaveBeenCalledTimes(1);
        const [, , payload] = (logEvent as jest.Mock).mock.calls[0];
        expect(payload.action).toBe('TENANT_MODULES_UPDATED');
        expect(payload.entityType).toBe('TenantModuleSettings');
        expect(payload.entityId).toBe('tms-1');
        expect(payload.detailsJson.category).toBe('entity_lifecycle');
        expect(payload.detailsJson.after).toEqual({ enabledModules: ['JOURNAL', 'PLANNING'] });
    });

    it('READER is rejected by the admin gate before any write', async () => {
        await expect(setEnabledModules(readerCtx, [])).rejects.toThrow(/permission/i);
        expect(ModuleSettingsRepository.upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('an empty list is a valid restriction (records "(none)" in the audit detail)', async () => {
        (ModuleSettingsRepository.upsert as jest.Mock).mockResolvedValue({
            id: 'tms-1',
            enabledModules: [],
        });
        await setEnabledModules(adminCtx, []);
        const [, , payload] = (logEvent as jest.Mock).mock.calls[0];
        expect(payload.details).toContain('(none)');
    });

    it('normalizes the input — drops unknown keys and dedupes — before persisting', async () => {
        (ModuleSettingsRepository.upsert as jest.Mock).mockResolvedValue({
            id: 'tms-1',
            enabledModules: ['JOURNAL', 'INVENTORY'],
        });
        await setEnabledModules(adminCtx, ['JOURNAL', 'JOURNAL', 'NONSENSE', 'INVENTORY'] as never);
        // The upsert receives a deduped, known-only list.
        expect(ModuleSettingsRepository.upsert).toHaveBeenCalledWith(mockDb, adminCtx, ['JOURNAL', 'INVENTORY']);
    });
});
