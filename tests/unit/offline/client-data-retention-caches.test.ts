/**
 * The retention sweep's Cache Storage half — executed, for the first time.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `sweepCaches()` deletes every `-pages` and `-fielddata` bucket. `PAGE_CACHE`
 * is what `public/sw.js` serves an offline navigation from. And until this
 * file, **no test had ever run it**: `grep -rln "globalThis.caches" tests/`
 * returned nothing, jsdom defines no `caches`, so the function returned 0 at
 * its `typeof caches === 'undefined'` guard in every suite that touched it.
 * `tests/guardrails/offline-pwa-coverage.test.ts` asserts *about* the deletion
 * by reading source text and has never executed one.
 *
 * ── The defect, which is NOT a forgotten age gate ──
 *
 * The unconditional whole-bucket delete is deliberate, and the docblock says
 * why:
 *
 *   "Whole-bucket delete rather than per-entry ageing: Cache Storage responses
 *    carry no write timestamp we control, and the SW repopulates on next use."
 *
 * That reasoning is sound — while there is a network. **`sweepClientStores()`
 * runs once per launch** (`ClientDataRetentionSweep` in the root layout), and
 * an offline cold launch is exactly the case where "the SW repopulates on next
 * use" is false.
 *
 * Sequence, on a phone in a field with no signal:
 *
 *   1. the SW serves the shell from PAGE_CACHE — the launch succeeds
 *   2. React hydrates, the sweep fires, PAGE_CACHE and DATA_CACHE are deleted
 *   3. still offline, so nothing repopulates
 *   4. the NEXT cold launch has nothing to serve
 *
 * So offline cold launch works exactly once per online session. That is K2 in
 * the Capacitor spike — its own #1 predicted kill — failing for a reason that
 * has nothing to do with iOS.
 *
 * ── What this file pins ──
 *
 * That the sweep still clears tenant data when it CAN be repopulated, and
 * spares it when it cannot. Both directions, because a fix that simply stopped
 * sweeping would trade a privacy control for an availability one: PAGE_CACHE
 * holds every server-rendered tenant document, and DATA_CACHE holds
 * `Task.description` / `Task.resolution` — Epic B encrypted at rest and cached
 * here DECRYPTED — on a phone that may be lost, sold, or handed to another
 * worker.
 */
import { sweepClientStores } from '@/lib/offline/client-data-retention';

/** Minimal in-memory CacheStorage. jsdom has none, which is why this was never executed. */
class FakeCacheStorage {
    constructor(private names: string[]) {}
    async keys(): Promise<string[]> {
        return [...this.names];
    }
    async delete(name: string): Promise<boolean> {
        const i = this.names.indexOf(name);
        if (i < 0) return false;
        this.names.splice(i, 1);
        return true;
    }
    get remaining(): string[] {
        return [...this.names];
    }
}

/** The four real buckets, verbatim from public/sw.js:26-34. */
const ALL = [
    'agrent-v1-static',
    'agrent-v1-pages',
    'agrent-v1-fielddata',
    'agrent-v1-basemap',
];

function install(names: string[]): FakeCacheStorage {
    const fake = new FakeCacheStorage([...names]);
    (globalThis as unknown as { caches: unknown }).caches = fake;
    return fake;
}

function setOnline(value: boolean): void {
    Object.defineProperty(globalThis.navigator, 'onLine', {
        value,
        configurable: true,
    });
}

const originalCaches = (globalThis as unknown as { caches?: unknown }).caches;

afterEach(() => {
    if (originalCaches === undefined) delete (globalThis as unknown as { caches?: unknown }).caches;
    else (globalThis as unknown as { caches: unknown }).caches = originalCaches;
    setOnline(true);
});

describe('sweepCaches — tenant data is cleared when it can be repopulated', () => {
    it('deletes PAGE_CACHE and DATA_CACHE when ONLINE', async () => {
        setOnline(true);
        const fake = install(ALL);

        const result = await sweepClientStores();

        expect(result.cachesRemoved).toBe(2);
        expect(fake.remaining.sort()).toEqual(['agrent-v1-basemap', 'agrent-v1-static']);
    });

    it('leaves STATIC and BASEMAP alone — they hold no tenant data', async () => {
        // BASEMAP is public-domain geometry with its own byte budget in sw.js;
        // STATIC is the app shell. Sweeping either would be a availability cost
        // with no privacy benefit.
        setOnline(true);
        const fake = install(ALL);

        await sweepClientStores();

        expect(fake.remaining).toContain('agrent-v1-static');
        expect(fake.remaining).toContain('agrent-v1-basemap');
    });

    it('matches on the SUFFIX, so a future cache-version bump is still swept', async () => {
        setOnline(true);
        const fake = install(['agrent-v2-pages', 'agrent-v2-fielddata', 'agrent-v2-static']);

        const result = await sweepClientStores();

        expect(result.cachesRemoved).toBe(2);
        expect(fake.remaining).toEqual(['agrent-v2-static']);
    });
});

describe('sweepCaches — tenant data is SPARED when it cannot be repopulated', () => {
    it('does not delete PAGE_CACHE while OFFLINE — the second cold launch depends on it', async () => {
        // The defect this file was written for. The sweep's own justification is
        // "the SW repopulates on next use"; offline, it cannot, and deleting the
        // bucket leaves the next cold launch with nothing to serve.
        setOnline(false);
        const fake = install(ALL);

        const result = await sweepClientStores();

        expect(result.cachesRemoved).toBe(0);
        expect(fake.remaining.sort()).toEqual(ALL.slice().sort());
    });

    it('sweeps on the next ONLINE launch — the data is deferred, not kept forever', async () => {
        // Deferral, not exemption. Without this, "spare it offline" would become
        // an unbounded retention hole on a device that rarely sees signal.
        setOnline(false);
        const fake = install(ALL);
        await sweepClientStores();
        expect(fake.remaining).toContain('agrent-v1-pages');

        setOnline(true);
        const result = await sweepClientStores();

        expect(result.cachesRemoved).toBe(2);
        expect(fake.remaining).not.toContain('agrent-v1-pages');
        expect(fake.remaining).not.toContain('agrent-v1-fielddata');
    });
});

describe('sweepCaches — never breaks the app it protects', () => {
    it('returns 0 rather than throwing when Cache Storage is absent', async () => {
        delete (globalThis as unknown as { caches?: unknown }).caches;
        await expect(sweepClientStores()).resolves.toMatchObject({ cachesRemoved: 0 });
    });

    it('survives a CacheStorage that throws', async () => {
        setOnline(true);
        (globalThis as unknown as { caches: unknown }).caches = {
            keys: async () => {
                throw new Error('SecurityError: storage disabled');
            },
        };
        await expect(sweepClientStores()).resolves.toMatchObject({ cachesRemoved: 0 });
    });
});


/**
 * The other half of the same defect (#851).
 *
 * The header above says offline cold launch "works exactly once per online
 * session". Measured on a real phone, it works ZERO times: the sweep runs on
 * every document load and fires AFTER the SW has cached the document being
 * loaded, so online the order is SW-caches → hydrate → sweep-deletes, and
 * PAGE_CACHE is empty at rest.
 *
 * The fix keeps the whole-bucket delete for fielddata and empties the page
 * bucket of everything EXCEPT the offline shell — the start_url a Home Screen
 * launch requests, and the document on screen.
 *
 * A first attempt deleted the bucket and re-fetched the shell back. It worked
 * and it cost a `/tenants` request on every document load, which for a
 * single-tenant user redirects into a full dashboard render; it pushed the
 * mobile drift E2E past its 180s budget. Not deleting what you need costs
 * nothing, which is why these tests assert entries rather than requests.
 */

const ORIGIN = 'https://app.example';
const CURRENT = `${ORIGIN}/t/acme/my-work`;
const OTHER = `${ORIGIN}/t/acme/journal/123`;

/** Cache with real entries, so keep-vs-delete is observable. */
class EntryCache {
    constructor(public urls: string[]) {}
    async keys(): Promise<{ url: string }[]> {
        return this.urls.map((url) => ({ url }));
    }
    async delete(req: { url: string }): Promise<boolean> {
        const i = this.urls.indexOf(req.url);
        if (i < 0) return false;
        this.urls.splice(i, 1);
        return true;
    }
}

class EntryCacheStorage {
    readonly buckets: Record<string, EntryCache> = {};
    constructor(private names: string[], seed: Record<string, string[]> = {}) {
        for (const [n, urls] of Object.entries(seed)) this.buckets[n] = new EntryCache([...urls]);
    }
    async keys(): Promise<string[]> {
        return [...this.names];
    }
    async delete(name: string): Promise<boolean> {
        const i = this.names.indexOf(name);
        if (i < 0) return false;
        this.names.splice(i, 1);
        delete this.buckets[name];
        return true;
    }
    async open(name: string): Promise<EntryCache> {
        this.buckets[name] ??= new EntryCache([]);
        return this.buckets[name];
    }
    get remaining(): string[] {
        return [...this.names];
    }
}

/** tests/unit runs under the NODE jest project, which has no `location`. */
function installLocation(href: string | null): void {
    if (href === null) {
        delete (globalThis as unknown as { location?: unknown }).location;
        return;
    }
    (globalThis as unknown as { location: unknown }).location = {
        origin: new URL(href).origin,
        href,
    };
}

function installEntries(): EntryCacheStorage {
    const fake = new EntryCacheStorage([...ALL], {
        'agrent-v1-pages': [`${ORIGIN}/tenants`, CURRENT, OTHER],
        'agrent-v1-fielddata': [`${ORIGIN}/api/t/acme/farm-tasks`],
    });
    (globalThis as unknown as { caches: unknown }).caches = fake;
    return fake;
}

describe('the offline shell survives the sweep (#851)', () => {
    beforeEach(() => installLocation(CURRENT));
    afterEach(() => installLocation(null));

    it('keeps the start_url and the current document, drops other tenant pages', async () => {
        setOnline(true);
        const fake = installEntries();

        await sweepClientStores();

        const pages = fake.buckets['agrent-v1-pages'].urls;
        // The Home Screen launch requests the start_url, not the last route.
        expect(pages).toContain(`${ORIGIN}/tenants`);
        expect(pages).toContain(CURRENT);
        // Every other server-rendered tenant document still goes.
        expect(pages).not.toContain(OTHER);
    });

    it('still deletes DATA_CACHE whole — it holds decrypted task text', async () => {
        setOnline(true);
        const fake = installEntries();

        await sweepClientStores();

        expect(fake.remaining).not.toContain('agrent-v1-fielddata');
    });

    it('keeps NOTHING on a purge — sign-out must leave the device empty', async () => {
        setOnline(true);
        const fake = installEntries();

        // signOutAndPurge passes exactly this.
        await sweepClientStores({ maxAgeMs: 0 });

        expect(fake.remaining).not.toContain('agrent-v1-pages');
        expect(fake.remaining).not.toContain('agrent-v1-fielddata');
    });

    it('touches nothing while OFFLINE — the shell is all there is', async () => {
        setOnline(false);
        const fake = installEntries();

        await sweepClientStores();

        expect(fake.buckets['agrent-v1-pages'].urls).toHaveLength(3);
        expect(fake.remaining).toContain('agrent-v1-fielddata');
    });

    it('leaves STATIC and BASEMAP alone', async () => {
        setOnline(true);
        const fake = installEntries();

        await sweepClientStores();

        expect(fake.remaining).toContain('agrent-v1-static');
        expect(fake.remaining).toContain('agrent-v1-basemap');
    });

    it('falls back to the whole-bucket delete when there is no location', async () => {
        // Not hypothetical: this suite runs under the node project, which has
        // no `location`. Nothing to protect, so the original behaviour stands.
        installLocation(null);
        setOnline(true);
        const fake = installEntries();

        await sweepClientStores();

        expect(fake.remaining).not.toContain('agrent-v1-pages');
    });
});
