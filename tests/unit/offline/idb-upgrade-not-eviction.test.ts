/**
 * A schema upgrade is not an eviction.
 *
 * `wasRecreated()` is the app's only EXACT eviction signal, and it is armed
 * from `onupgradeneeded`. But that handler fires on ANY version bump, not only
 * when the database was absent — so an ungated `onCreated?.()` reports an
 * eviction to every existing device the moment a store is added.
 *
 * That is not hypothetical: adding the `delivered` receipt store required
 * version 1 → 2, and the consequence of getting this wrong is a sticky
 * "unsent work was deleted by this phone" banner shown to every operator on
 * upgrade, clearing only on explicit acknowledgement.
 *
 * `public/sw.js` has always gated this correctly. `idb-outbox.ts` did not.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const IDB = fs.readFileSync(path.join(ROOT, 'src/lib/offline/idb-outbox.ts'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

/**
 * Drive the real upgrade handler with a fake IDB request, so the assertion is
 * about what the code DOES rather than how it reads. The handler is inlined in
 * a module-private function, so it is reconstructed here from its own source —
 * if that source stops matching, the extraction throws rather than passing.
 */
function runUpgrade(existingStores: string[]): { created: boolean; madeStores: string[] } {
    const body = IDB.slice(IDB.indexOf('req.onupgradeneeded = () => {'), IDB.indexOf('req.onsuccess'));
    expect(body).toContain('queueWasAbsent');

    const madeStores: string[] = [];
    let created = false;
    const db = {
        objectStoreNames: { contains: (n: string) => existingStores.includes(n) },
        createObjectStore: (n: string) => void madeStores.push(n),
    };
    const fn = new Function(
        'req', 'OUTBOX_STORE_NAME', 'RECEIPT_STORE_NAME', 'onCreated',
        `${body.replace('req.onupgradeneeded = () => {', '(() => {').replace(/};\s*$/, '})();')}`,
    );
    fn({ result: db }, 'outbox', 'delivered', () => { created = true; });
    return { created, madeStores };
}

describe('the recreation signal fires only on a real recreation', () => {
    it('a FRESH database reports creation', () => {
        const { created, madeStores } = runUpgrade([]);
        expect(created).toBe(true);
        expect(madeStores).toEqual(expect.arrayContaining(['outbox', 'delivered']));
    });

    it('a VERSION BUMP with the queue intact does NOT report creation', () => {
        // The defect this file exists for. v1 → v2 adds `delivered` to a
        // database that already holds the queue; that is an upgrade, and every
        // existing device would otherwise be told its work was destroyed.
        const { created, madeStores } = runUpgrade(['outbox']);
        expect(created).toBe(false);
        expect(madeStores).toEqual(['delivered']);
    });

    it('an already-current database creates nothing and reports nothing', () => {
        const { created, madeStores } = runUpgrade(['outbox', 'delivered']);
        expect(created).toBe(false);
        expect(madeStores).toEqual([]);
    });

    it('the service worker gates it the same way, on the same version', () => {
        // The two sides open the SAME database. A version skew between them
        // makes one of them trigger an upgrade the other did not expect.
        expect(SW).toContain('const OUTBOX_DB_VERSION = 2;');
        expect(IDB).toContain('export const OUTBOX_DB_VERSION = 2;');
        expect(SW).toMatch(/if \(!db\.objectStoreNames\.contains\(OUTBOX_STORE\)\) \{\s*\n\s*created = true;/);
    });
});
