/**
 * The outbox under a REAL eviction (@mobile).
 *
 * ISOLATED / MUTATING tenant (e2e-isolation convention).
 *
 * ## Why this has to run in a browser
 *
 * The unit tests in `tests/unit/offline/outbox-eviction.test.ts` drive a fake
 * store, so they prove the POLICY — what the app reports once it knows the
 * queue was destroyed. They cannot prove the DETECTOR, because the detector is
 * a claim about IndexedDB itself: that a database deleted underneath a live
 * connection fires `versionchange`, that closing on it lets the delete
 * proceed, and that the next open reports the store as newly created. Every
 * one of those is the dependency's behaviour, not ours, and a mocked
 * IndexedDB cannot report that IndexedDB changed.
 *
 * So this spec queues real work in the real store and then deletes the real
 * database, which is what an eviction looks like from inside the page.
 *
 * ## The regression class
 *
 * Before this work an evicted queue and a fully-synced queue rendered
 * IDENTICALLY: no count, no warning, nothing. An operator who lost a
 * morning's marks saw the same clean screen as one whose work had landed.
 * The assertion that matters is therefore not "a banner appears" but "the app
 * does NOT claim the work is on the server".
 */
import { test, expect } from '../fixtures';
import { openTreatmentFormWarm, saveTreatmentThroughReview } from '../e2e-utils';
import { agPrisma, seedTreatmentBasics } from '../ag-fixtures';

test.describe('offline outbox survives eviction visibly @mobile', () => {
    test.describe.configure({ retries: 0 });

    test('work deleted by the phone is reported, not silently forgotten', async ({
        authedPage,
        isolatedTenant,
    }) => {
        test.setTimeout(120_000);
        const page = authedPage;
        const slug = isolatedTenant.tenantSlug;

        await page.goto(`/t/${slug}/journal`);
        await expect(page.getByText('No journal entries yet')).toBeVisible();

        // Open the create form ONLINE so its lazy chunk lands, then cut the
        // network before submitting.
        //
        // «Нов запис» records a TREATMENT now (#1740), so this drives that
        // form — the vehicle changed, the subject of this spec did not: all it
        // needs is one write sitting in the outbox, and the journal create is
        // where a field operator actually produces one.
        //
        // `openTreatmentFormWarm` holds the load-bearing wait. Waiting on the
        // parcel checkboxes alone would prove only that the data arrived, not
        // that MapLibre's ~200KB chunk has — the same shape as the
        // `#journal-entry-title` mistake this spec used to carry.
        //
        // This is a real hazard but it was NOT the cause of this spec's two
        // failures on main (#730). That was traced instead to the service
        // worker racing the page to reopen the evicted database and consuming
        // the one `upgradeneeded` event the loss detector depends on — see
        // `tests/unit/offline/sw-outbox-recreation.test.ts`.
        const { product } = await seedTreatmentBasics(
            page.request, agPrisma(), isolatedTenant.tenantId, slug,
            { product: `Aphid spray ${Date.now()}` },
        );
        const parcelBox = await openTreatmentFormWarm(page, { product });

        await page.context().setOffline(true);
        await parcelBox.click();
        await saveTreatmentThroughReview(page);
        await expect(page.locator('#treatment-product')).toBeHidden();

        // Queued, and the app says WHERE it is: on the phone, not the server.
        await expect(page.getByTestId('offline-pending-count')).toHaveText(
            '1 change saved on this phone',
        );
        await expect(page.getByTestId('offline-location-claim')).toHaveText('Not on the server yet');

        // The work is really in IndexedDB (not just in React state).
        const queuedBefore = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                // NO VERSION. Opening at a fixed version fails the moment the
                // app's schema moves ahead — IndexedDB refuses to open below
                // the version a database already holds, so this threw
                // `VersionError: The requested version (1) is less than the
                // existing version (2)` the day the delivery-receipt store
                // landed. A test that only READS must not pin a version, or it
                // becomes a tripwire for every future migration.
                const req = indexedDB.open('agri-offline');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            const rows = await new Promise<unknown[]>((resolve, reject) => {
                const rq = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
                rq.onsuccess = () => resolve(rq.result as unknown[]);
                rq.onerror = () => reject(rq.error);
            });
            db.close();
            return rows.length;
        });
        expect(queuedBefore, 'the outbox should hold the queued entry').toBe(1);

        // ── EVICT ────────────────────────────────────────────────────────
        // `deleteDatabase` is the closest faithful stand-in for what iOS does
        // to a non-persisted origin: the database is gone and the next open
        // silently builds an empty one. It also BLOCKS while any connection is
        // open, so this doubles as proof that the page's `versionchange`
        // handler closes its connection — without it, the delete would hang
        // and this test would time out here.
        const deleted = await page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const req = indexedDB.deleteDatabase('agri-offline');
                    req.onsuccess = () => resolve('deleted');
                    req.onerror = () => resolve('error');
                    req.onblocked = () => resolve('blocked');
                }),
        );
        expect(deleted, 'delete must not be blocked by a held connection').toBe('deleted');

        // Bring the app back to the foreground — the same event an operator
        // generates by taking the phone out of a pocket, and the trigger that
        // re-reads the queue.
        await page.context().setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));

        // ── The assertion this whole feature exists for ──────────────────
        const lost = page.getByTestId('offline-lost-work');
        await expect(lost).toBeVisible({ timeout: 20_000 });
        await expect(lost).toContainText('Unsent work was deleted by this phone');
        // Named, so the operator knows WHAT to re-enter rather than just that
        // something is missing. The name is the queue LABEL the form supplied,
        // which for a treatment is the product — the farmer's own word for it.
        await expect(lost).toContainText(product);

        // And the negative half: the app must not be claiming the work landed.
        await expect(page.getByTestId('offline-unsynced-pill')).toHaveCount(0);
        const server = await page.request.get(`/api/t/${slug}/journal`);
        const body = (await server.json()) as
            | Array<{ title?: string }>
            | { entries?: Array<{ title?: string }>; rows?: Array<{ title?: string }> };
        const entries = Array.isArray(body) ? body : (body.entries ?? body.rows ?? []);
        expect(
            // CONTAINS, not equals: the server composes an entry's title per
            // operation line (`{product} — {parcel}`), so equality against the
            // product name alone would pass whatever the server holds — a
            // negative assertion that cannot fail is worse than none.
            entries.filter((e) => String(e.title ?? '').includes(product)),
            'the treatment genuinely never reached the server',
        ).toHaveLength(0);

        // ── The record is STICKY ─────────────────────────────────────────
        // A later successful sync must not wipe it: those items are not in
        // that sync and never will be.
        await page.reload();
        await expect(page.getByTestId('offline-lost-work')).toBeVisible({ timeout: 20_000 });

        // Only an explicit acknowledgement clears it.
        await page.getByTestId('offline-lost-work').getByRole('button', { name: 'I understand' }).click();
        await expect(page.getByTestId('offline-lost-work')).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId('offline-lost-work')).toHaveCount(0);
    });
});
