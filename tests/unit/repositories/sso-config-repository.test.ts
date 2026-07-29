/**
 * Coverage wave 22 — `SsoConfigRepository`.
 *
 * 8 uncovered functions at 20% (52.17% lines). Unlike its neighbours
 * this module talks to the global `prisma` singleton rather than an
 * injected `db`, so the singleton is mocked and the assertions are on the
 * emitted query.
 *
 * Three contracts here are security-relevant rather than merely correct:
 *
 *   - `findByDomain` is the pre-authentication SSO discovery path. It is
 *     GLOBAL by design (an e-mail address carries no tenant), and it
 *     lower-cases before matching, because the domain arrives from
 *     whatever the user typed into the login box.
 *   - a newly created IdP must land DISABLED and UNENFORCED. Enforcement
 *     on create would lock a tenant out of their own account the instant
 *     they saved a half-finished SAML config.
 *   - `remove` / `setEnabled` / `setEnforced` carry the tenant in the
 *     `where` themselves, so a leaked provider id is not enough to toggle
 *     or delete another tenant's IdP.
 */
const prismaMock = {
    tenantIdentityProvider: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'idp-1' }),
        create: jest.fn().mockResolvedValue({ id: 'idp-1' }),
        update: jest.fn().mockResolvedValue({ id: 'idp-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock }));

import * as SsoConfigRepo from '@/app-layer/repositories/SsoConfigRepository';

const idp = prismaMock.tenantIdentityProvider;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

beforeEach(() => {
    jest.clearAllMocks();
    idp.findMany.mockResolvedValue([]);
    idp.findFirst.mockResolvedValue(null);
    idp.findFirstOrThrow.mockResolvedValue({ id: 'idp-1' });
    idp.updateMany.mockResolvedValue({ count: 1 });
});

describe('SsoConfigRepository — tenant-scoped reads', () => {
    it('lists a tenant’s providers oldest first', async () => {
        // Break: dropping `tenantId`. The admin SSO page would render
        // every customer's IdP configuration — including their entity ids
        // and ACS URLs.
        await SsoConfigRepo.findByTenantId('tenant-1');

        expect(whereOf(idp.findMany)).toEqual({ tenantId: 'tenant-1' });
        expect(argOf(idp.findMany).orderBy).toEqual({ createdAt: 'asc' });
    });

    it('requires id AND tenant to read one provider', async () => {
        // This is the ownership check `usecases/sso.ts` performs before
        // calling `upsert` with an id — see the upsert tests below.
        await SsoConfigRepo.findById('tenant-1', 'idp-1');

        expect(whereOf(idp.findFirst)).toEqual({ id: 'idp-1', tenantId: 'tenant-1' });
    });

    it('narrows to enabled providers for the sign-in surface', async () => {
        // Break: dropping `isEnabled`. A half-configured IdP saved but not
        // switched on would appear as a live "Sign in with…" button and
        // fail at the identity provider.
        await SsoConfigRepo.findEnabledByTenantId('tenant-1');

        expect(whereOf(idp.findMany)).toEqual({ tenantId: 'tenant-1', isEnabled: true });
    });
});

describe('SsoConfigRepository.findByDomain', () => {
    it('lower-cases the domain before matching the stored list', async () => {
        // Break: passing the raw domain through. Domains are stored
        // lower-cased, so a user typing "Ada@ACME.com" would not be
        // discovered onto their IdP and would silently fall back to the
        // password form — the classic "SSO doesn't work for some people"
        // report that is nearly impossible to reproduce.
        await SsoConfigRepo.findByDomain('ACME.com');

        expect(whereOf(idp.findFirst)).toEqual({
            isEnabled: true,
            emailDomains: { has: 'acme.com' },
        });
    });

    it('only discovers ENABLED providers, and does so globally', async () => {
        // The global shape is deliberate: this runs BEFORE authentication,
        // from an e-mail address that carries no tenant. `isEnabled` is
        // therefore the only gate — dropping it would route users to a
        // disabled IdP with no way back.
        await SsoConfigRepo.findByDomain('acme.com');

        expect(whereOf(idp.findFirst).isEnabled).toBe(true);
        expect(whereOf(idp.findFirst)).not.toHaveProperty('tenantId');
    });
});

describe('SsoConfigRepository.upsert — create branch', () => {
    it('stamps the tenant from the argument, not from the payload', async () => {
        await SsoConfigRepo.upsert('tenant-1', { name: 'Okta', type: 'SAML' });

        expect(dataOf(idp.create)).toMatchObject({
            tenantId: 'tenant-1',
            name: 'Okta',
            type: 'SAML',
        });
        expect(idp.update).not.toHaveBeenCalled();
    });

    it('creates a provider DISABLED and UNENFORCED by default', async () => {
        // Break: defaulting either flag to true. `isEnforced` in
        // particular turns password sign-in off for the whole tenant — an
        // admin who saves a draft SAML config would lock every member of
        // their organisation out, themselves included.
        await SsoConfigRepo.upsert('tenant-1', { name: 'Okta', type: 'SAML' });

        expect(dataOf(idp.create)).toMatchObject({
            isEnabled: false,
            isEnforced: false,
            emailDomains: [],
            configJson: {},
        });
    });

    it('honours explicitly supplied flags and domains', async () => {
        await SsoConfigRepo.upsert('tenant-1', {
            name: 'Okta',
            type: 'OIDC',
            isEnabled: true,
            isEnforced: true,
            emailDomains: ['acme.com'],
            configJson: { issuer: 'https://idp.example.invalid' },
        });

        expect(dataOf(idp.create)).toMatchObject({
            isEnabled: true,
            isEnforced: true,
            emailDomains: ['acme.com'],
            configJson: { issuer: 'https://idp.example.invalid' },
        });
    });

    it('preserves an explicit `false` rather than falling back to the default', async () => {
        // `?? false` and `|| false` agree here, but `isEnabled: false`
        // must survive a future switch to a truthy default.
        await SsoConfigRepo.upsert('tenant-1', {
            name: 'Okta',
            type: 'SAML',
            isEnabled: false,
            isEnforced: false,
        });

        expect(dataOf(idp.create)).toMatchObject({ isEnabled: false, isEnforced: false });
    });
});

describe('SsoConfigRepository.upsert — update branch', () => {
    it('updates by id, and does not create a second row', async () => {
        await SsoConfigRepo.upsert('tenant-1', { id: 'idp-1', name: 'Okta v2', type: 'SAML' });

        expect(argOf(idp.update).where).toEqual({ id: 'idp-1' });
        expect(idp.create).not.toHaveBeenCalled();
    });

    it('never writes the id into the row body', async () => {
        // Break: spreading `data` instead of the destructured `fields`.
        // Writing the primary key back is at best a no-op and at worst a
        // caller-controlled id reassignment.
        await SsoConfigRepo.upsert('tenant-1', { id: 'idp-1', name: 'Okta v2', type: 'SAML' });

        expect(dataOf(idp.update)).not.toHaveProperty('id');
        expect(dataOf(idp.update)).toMatchObject({ name: 'Okta v2', type: 'SAML' });
    });

    it('leaves the stored config untouched when the patch omits it', async () => {
        // Break: `configJson: fields.configJson ?? {}`. Renaming a
        // provider would blank its SAML certificate and ACS URL — SSO
        // breaks for the whole tenant on a cosmetic edit.
        await SsoConfigRepo.upsert('tenant-1', { id: 'idp-1', name: 'Renamed', type: 'SAML' });

        expect(dataOf(idp.update).configJson).toBeUndefined();
    });

    it('writes the config when one is supplied', async () => {
        await SsoConfigRepo.upsert('tenant-1', {
            id: 'idp-1',
            name: 'Okta',
            type: 'SAML',
            configJson: { entityId: 'urn:acme' },
        });

        expect(dataOf(idp.update).configJson).toEqual({ entityId: 'urn:acme' });
    });

    it('addresses the row by id alone — the tenant gate is upstream', async () => {
        // Pinned deliberately. `usecases/sso.ts::upsertTenantSsoConfig`
        // resolves the provider through the tenant-scoped `findById`
        // before it ever calls this. A new caller that skips that step
        // turns this into a cross-tenant IdP takeover, which is why the
        // absence of `tenantId` here is recorded rather than assumed.
        await SsoConfigRepo.upsert('tenant-1', { id: 'idp-1', name: 'X', type: 'SAML' });

        expect(argOf(idp.update).where).toEqual({ id: 'idp-1' });
    });
});

describe('SsoConfigRepository — tenant-scoped mutations', () => {
    it('deletes only within the calling tenant, and tolerates a miss', async () => {
        // Break: `delete({ where: { id } })`. That both removes another
        // tenant's provider on a leaked id and throws P2025 on a
        // double-click; `deleteMany` with the tenant arm does neither.
        await SsoConfigRepo.remove('tenant-1', 'idp-1');

        expect(whereOf(idp.deleteMany)).toEqual({ id: 'idp-1', tenantId: 'tenant-1' });
    });

    it('toggles enablement tenant-scoped, then returns the refreshed row', async () => {
        const res = await SsoConfigRepo.setEnabled('tenant-1', 'idp-1', true);

        expect(whereOf(idp.updateMany)).toEqual({ id: 'idp-1', tenantId: 'tenant-1' });
        expect(dataOf(idp.updateMany)).toEqual({ isEnabled: true });
        // Break: re-reading by id alone. The write is tenant-scoped but
        // the read-back would not be, so a foreign id would return
        // someone else's provider row to the admin UI.
        expect(whereOf(idp.findFirstOrThrow)).toEqual({ id: 'idp-1', tenantId: 'tenant-1' });
        expect(res).toEqual({ id: 'idp-1' });
    });

    it('toggles enforcement tenant-scoped, then returns the refreshed row', async () => {
        // Enforcement is the flag that disables password sign-in for the
        // tenant — the most consequential single boolean in this file.
        await SsoConfigRepo.setEnforced('tenant-1', 'idp-1', true);

        expect(whereOf(idp.updateMany)).toEqual({ id: 'idp-1', tenantId: 'tenant-1' });
        expect(dataOf(idp.updateMany)).toEqual({ isEnforced: true });
        expect(whereOf(idp.findFirstOrThrow)).toEqual({ id: 'idp-1', tenantId: 'tenant-1' });
    });

    it('can turn both flags back off', async () => {
        await SsoConfigRepo.setEnabled('tenant-1', 'idp-1', false);
        expect(dataOf(idp.updateMany)).toEqual({ isEnabled: false });

        jest.clearAllMocks();
        idp.updateMany.mockResolvedValue({ count: 1 });
        idp.findFirstOrThrow.mockResolvedValue({ id: 'idp-1' });

        await SsoConfigRepo.setEnforced('tenant-1', 'idp-1', false);
        expect(dataOf(idp.updateMany)).toEqual({ isEnforced: false });
    });

    it('surfaces the not-found throw when the row is not the caller’s', async () => {
        // `updateMany` matches nothing for a foreign id, so the read-back
        // is what turns a silent no-op into an error the API can map to a
        // 404 instead of reporting a successful toggle.
        idp.updateMany.mockResolvedValue({ count: 0 });
        idp.findFirstOrThrow.mockRejectedValue(new Error('No TenantIdentityProvider found'));

        await expect(SsoConfigRepo.setEnabled('tenant-1', 'idp-9', true)).rejects.toThrow(
            /No TenantIdentityProvider found/,
        );
    });
});
