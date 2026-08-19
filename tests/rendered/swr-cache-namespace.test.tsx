/**
 * @jest-environment jsdom
 *
 * The cache bucket is namespaced by USER, not just tenant.
 *
 * ## The leak
 *
 * The bucket was keyed on the tenant slug alone. On a shared farm device:
 * operator A (ADMIN) opens a list, the rows land in
 * `agrent-swr:v*:<slug>`. A signs out. Operator B (READER) signs into the
 * SAME tenant — same slug, same bucket — and SWR paints A's rows from disk
 * before any request leaves the device.
 *
 * The second half is what makes it more than cosmetic: if the API then
 * refuses B, this codebase's own error convention is to render the error
 * only when there is nothing to show (`isError && rows.length === 0`). B
 * has rows — A's rows — so the refusal never renders and the stale data
 * stays on screen.
 *
 * No TTL closes that, and neither does a sign-out purge: B may simply sign
 * in after A closed the tab. Only the namespace does.
 */
import { cacheNamespace, tenantNamespaceFromPath } from '@/components/providers/SWRPersistenceProvider';
import { createPersistentCacheProvider, storageKey } from '@/lib/swr/persistent-cache';

const JOURNAL = '/api/t/acme-corp/journal';

beforeEach(() => window.localStorage.clear());

describe('namespace composition', () => {
    it('separates two users of the SAME tenant', () => {
        expect(cacheNamespace('usr_admin', 'acme-corp')).not.toBe(
            cacheNamespace('usr_reader', 'acme-corp'),
        );
    });

    it('still separates two tenants for the same user', () => {
        expect(cacheNamespace('usr_1', 'acme-corp')).not.toBe(
            cacheNamespace('usr_1', 'other-farm'),
        );
    });

    it('gives a signed-out visitor their own bucket rather than sharing one', () => {
        expect(cacheNamespace(null, 'acme-corp')).toBe(cacheNamespace(undefined, 'acme-corp'));
        expect(cacheNamespace(null, 'acme-corp')).not.toBe(
            cacheNamespace('usr_1', 'acme-corp'),
        );
    });

    it('still derives the tenant from the path', () => {
        expect(tenantNamespaceFromPath('/t/acme-corp/journal')).toBe('acme-corp');
        expect(tenantNamespaceFromPath('/login')).toBe('global');
        expect(tenantNamespaceFromPath(null)).toBe('global');
    });
});

describe('the leak itself', () => {
    it("a second user on the same device cannot read the first user's bucket", () => {
        const adminNs = cacheNamespace('usr_admin', 'acme-corp');
        const readerNs = cacheNamespace('usr_reader', 'acme-corp');

        // Admin caches a list and the tab is hidden.
        const adminMap = createPersistentCacheProvider({ namespace: adminNs });
        adminMap.set(JOURNAL, { data: [{ id: 'j1', title: 'Admin-only entry' }] });
        Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(window.localStorage.getItem(storageKey(adminNs))).toContain('Admin-only entry');

        // Reader signs in to the same tenant on the same device.
        const readerMap = createPersistentCacheProvider({ namespace: readerNs });
        expect(readerMap.get(JOURNAL)).toBeUndefined();
        expect(readerMap.size).toBe(0);
    });

    it('would NOT hold if the namespace were the tenant alone', () => {
        // Mutation proof, in-test: with the old keying both sessions
        // resolve to one bucket and the second user reads the first's rows.
        const oldNs = 'acme-corp';
        const first = createPersistentCacheProvider({ namespace: oldNs });
        first.set(JOURNAL, { data: [{ id: 'j1', title: 'Admin-only entry' }] });
        Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));

        const second = createPersistentCacheProvider({ namespace: oldNs });
        expect(second.get(JOURNAL)).toBeDefined();
    });
});
