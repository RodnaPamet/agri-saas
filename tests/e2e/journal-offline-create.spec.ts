/**
 * @mobile — offline journal create, now a TREATMENT record (#1740, #1830).
 *
 * A field operator records a treatment and loses signal before it is sent: the
 * write is enqueued in the outbox (OfflineSyncBar shows it queued), and on
 * reconnect the service worker replays it carrying its outbox id as the
 * `Idempotency-Key` so the server dedupes the delivery. The regression class
 * is unchanged: work silently dropped offline, or delivered twice on a flaky
 * reconnect.
 *
 * ## What changed, and what deliberately did not
 *
 * «Нов запис» used to open a free-form note; it now opens the two-step
 * treatment form, so this spec drives that instead of `#journal-entry-title`.
 * The PROMISE under test is the same one, which is why the spec was updated
 * rather than retired: replacing the form must not quietly remove the
 * capability it covers.
 *
 * ## Why every read happens while ONLINE
 *
 * Step two's crop list and parcel list come from `/parcels/by-crop`, which the
 * web's persistent SWR cache does NOT write: `PERSISTABLE_PATHS` is an
 * allowlist of `/journal`, `/farm-tasks`, `/locations` and
 * `/exchange/listings`, and this form's four reads are on none of them
 * (#1845). So the reads must happen online here, and that is not a quirk of
 * the fixture — it is what a real device does too.
 *
 * Which makes the scenario this spec covers precise: a farmer who loses signal
 * MID-FORM keeps the work, because the WRITE is queued. A farmer who opens the
 * form with no signal has nothing to tick, cache or no cache.
 *
 * The network is cut immediately before Save, which is the moment the outbox
 * exists for. Same shape as the old spec's warm-up (#730) for a different
 * reason: there it was a lazy chunk, here it is data that is never persisted.
 *
 * Mutating spec → isolated empty tenant, so the farm data is created here.
 */
import { test, expect } from './fixtures';
import { agPrisma, seedTreatmentBasics } from './ag-fixtures';
import { openTreatmentFormWarm } from './e2e-utils';

test('@mobile journal entry created offline queues and delivers exactly once', async ({
    authedPage,
    isolatedTenant,
}) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;
    const prisma = agPrisma();
    const product = `Aphid spray ${Date.now()}`;

    // ── The farm this treatment is recorded against ────────────────────
    const { product: productName } = await seedTreatmentBasics(
        api, prisma, isolatedTenant.tenantId, slug, { product },
    );

    await authedPage.goto(`/t/${slug}/journal`);
    await expect(authedPage.getByText('No journal entries yet')).toBeVisible();

    // ── Both steps, ONLINE: every read lands before the network is cut ──
    const parcelBox = await openTreatmentFormWarm(authedPage, { product: productName });

    // ── Signal lost, then Save ─────────────────────────────────────────
    await authedPage.context().setOffline(true);
    await parcelBox.click();
    await authedPage.getByRole('button', { name: 'Save' }).click();

    // The modal closes; the outbox holds it and the sync bar shows it queued.
    await expect(authedPage.locator('#treatment-product')).toBeHidden();
    await expect(authedPage.getByText('Offline', { exact: true })).toBeVisible();
    await expect(authedPage.getByTestId('offline-pending-count')).toHaveText(
        '1 change saved on this phone',
    );
    // The optimistic row names the product, which is also how the folded row
    // reads once it is delivered — so this assertion holds either side of the
    // reconnect rather than describing a transient shape.
    await expect(authedPage.getByText(product).first()).toBeVisible();
    // And it offers NO document: the treatment does not exist on the server
    // yet, so a «Изтегли дневник (PDF)» button there would fetch a 404.
    await expect(authedPage.getByRole('button', { name: 'Download diary (PDF)' })).toHaveCount(0);

    // ── Reconnect → the outbox drains; the queue clears ────────────────
    await authedPage.context().setOffline(false);
    await expect(authedPage.getByTestId('offline-pending-count')).toBeHidden({ timeout: 20_000 });

    // Server truth: delivered EXACTLY ONCE. One parcel is one operation line,
    // which is one journal entry — a duplicate delivery would be two.
    await expect
        .poll(
            async () => {
                const body = (await (await api.get(`/api/t/${slug}/journal`)).json()) as
                    | Array<{ title?: string }>
                    | { entries?: Array<{ title?: string }>; rows?: Array<{ title?: string }> };
                const rows = Array.isArray(body) ? body : (body.entries ?? body.rows ?? []);
                return rows.filter((e) => String(e.title ?? '').includes(product)).length;
            },
            { timeout: 20_000 },
        )
        .toBe(1);
});
