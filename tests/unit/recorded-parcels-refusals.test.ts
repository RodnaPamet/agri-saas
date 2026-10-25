/**
 * `resolveRecordedParcels`' refusals that need no database — #2316.
 *
 * Three of its four rules throw BEFORE it touches Postgres: an unparseable
 * day, a future day, and an empty parcel list. So they are unit-testable, and
 * worth testing here rather than only through the activity write, because they
 * are the rules shared with the treatment write and a change to either must
 * surface against both.
 *
 * The fourth — the per-parcel area bound — needs the parcel row and is covered
 * in `tests/integration/farm-activity-write.test.ts`.
 *
 * ## Asserted on `error.code`, not on the message
 *
 * `codedBadRequest` puts the code on the error and the sentence in `message`,
 * so matching the prose would both fail here and be the wrong test: the code is
 * what a client switches on, and the sentence is copy that may be reworded —
 * `refusal-codes-read-in-bulgarian` already pins the strings that matter.
 *
 * ## Why the ORDER of the first two is asserted
 *
 * `parseRecordedDay` runs before the future check, so `2026-02-31` is
 * `TREATMENT_DATE_INVALID` and not `TREATMENT_DATE_IN_FUTURE` — a date that
 * does not exist is refused as malformed rather than rolled forward to
 * 2026-03-03 and then compared. Rolling forward is what `new Date(string)`
 * does, and it would file a treatment on a day the farmer did not name.
 */
import { resolveRecordedParcels } from '@/app-layer/usecases/recorded-parcels';
import { makeRequestContext } from '../helpers/make-context';

const ctx = () =>
    makeRequestContext('OWNER', {
        userId: 'u-test',
        tenantId: 't-test',
        tenantSlug: 'rp-test',
    });

const future = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
};

describe('resolveRecordedParcels refusals (#2316)', () => {
    it('refuses a day that does not exist, rather than rolling it forward', async () => {
        await expect(
            resolveRecordedParcels(ctx(), { occurredOn: '2026-02-31', parcelIds: ['p1'] }),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_INVALID' });
    });

    it('refuses a malformed day', async () => {
        // `new Date('2026-3')` parses in some runtimes and resolves against the
        // server's zone in others, which is the reason this is a strict regex
        // rather than a Date construction.
        await expect(
            resolveRecordedParcels(ctx(), { occurredOn: '2026-3', parcelIds: ['p1'] }),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_INVALID' });
    });

    it('refuses a future day', async () => {
        await expect(
            resolveRecordedParcels(ctx(), { occurredOn: future(), parcelIds: ['p1'] }),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_IN_FUTURE' });
    });

    it('refuses an empty parcel list', async () => {
        // AFTER the date checks, so a request wrong in both ways reports the
        // date first. Asserted because the order is what a client sees.
        await expect(
            resolveRecordedParcels(ctx(), { occurredOn: '2026-10-01', parcelIds: [] }),
        ).rejects.toMatchObject({ code: 'TREATMENT_NO_PARCELS' });
    });

    it('reports the DATE first when both the date and the list are wrong', async () => {
        await expect(
            resolveRecordedParcels(ctx(), { occurredOn: future(), parcelIds: [] }),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_IN_FUTURE' });
    });

    it('these three throw before any database access', async () => {
        // The property that makes this file a unit test: none of the above
        // reaches `runInTenantContext`. If a future change moved the parcel
        // fetch ahead of them, this suite would fail on a missing database
        // rather than on the refusal — which is the signal to re-split it.
        //
        // Asserted by the absence of a DB in this jest project rather than by a
        // mock: a mock would prove the call was not made to the mock, not that
        // it was not made at all.
        await expect(
            resolveRecordedParcels(ctx(), { occurredOn: '2026-13-01', parcelIds: [] }),
        ).rejects.toMatchObject({ code: 'TREATMENT_DATE_INVALID' });
    });
});
