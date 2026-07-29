/**
 * Coverage wave 22 — `TraceabilityRepository` (the three cross-entity
 * link repositories: control↔risk, asset↔control, asset↔risk).
 *
 * 11 uncovered functions at 15.38%. These are the join tables behind the
 * traceability matrix, and they have an unusual property: every write
 * addresses a row by a COMPOSITE unique key whose FIRST component is the
 * tenant. That makes the tenant part of the row's address rather than a
 * filter on top of it — an unlink against another tenant's pair simply
 * cannot resolve. Losing `tenantId` from one of those composite keys is a
 * silent cross-tenant delete primitive, and it is exactly the kind of
 * change that looks like tidy-up in review, so the key shape is asserted
 * literally here.
 *
 * `db` is a recording double; the assertions are on the emitted query.
 */
import {
    ControlRiskRepository,
    AssetControlRepository,
    AssetRiskRepository,
} from '@/app-layer/repositories/TraceabilityRepository';
import type { PrismaTx } from '@/lib/db-context';

const TENANT = 'tenant-1';
const OTHER = 'tenant-2';

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        upsert: jest.fn().mockResolvedValue({ id: 'upserted' }),
        delete: jest.fn().mockResolvedValue({ id: 'deleted' }),
    });
    return { riskControl: model(), controlAsset: model(), assetRiskLink: model() };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('ControlRiskRepository', () => {
    it('lists a control’s risks tenant-scoped, newest first', async () => {
        // Break: dropping `tenantId`. Control ids are visible in the URL,
        // so an unscoped join read exposes another tenant's risk register
        // titles and scores through the traceability tab.
        await ControlRiskRepository.listByControl(asTx(db), TENANT, 'c-1');

        expect(whereOf(db.riskControl.findMany)).toEqual({ tenantId: TENANT, controlId: 'c-1' });
        expect(argOf(db.riskControl.findMany).orderBy).toEqual({ createdAt: 'desc' });
    });

    it('lists a risk’s controls tenant-scoped', async () => {
        await ControlRiskRepository.listByRisk(asTx(db), OTHER, 'r-1');

        expect(whereOf(db.riskControl.findMany)).toEqual({ tenantId: OTHER, riskId: 'r-1' });
    });

    it('records the author and rationale on a new link', async () => {
        // Break: dropping `createdByUserId`. "Who asserted that this
        // control mitigates this risk" is the whole evidential value of a
        // traceability link at audit time.
        await ControlRiskRepository.link(asTx(db), TENANT, 'c-1', 'r-1', 'Encrypts the store', 'user-1');

        expect(dataOf(db.riskControl.create)).toEqual({
            tenantId: TENANT,
            controlId: 'c-1',
            riskId: 'r-1',
            rationale: 'Encrypts the store',
            createdByUserId: 'user-1',
        });
    });

    it('addresses the unlink by the tenant-leading composite key', async () => {
        // Break: `where: { riskId_controlId: {...} }` without the tenant.
        // The delete would then resolve on ANY tenant's pair with the same
        // two ids — the undo-toast unlink flow would quietly sever another
        // customer's traceability link.
        await ControlRiskRepository.unlink(asTx(db), TENANT, 'c-1', 'r-1');

        expect(whereOf(db.riskControl.delete)).toEqual({
            tenantId_riskId_controlId: { tenantId: TENANT, riskId: 'r-1', controlId: 'c-1' },
        });
    });
});

describe('AssetControlRepository', () => {
    it('lists both directions tenant-scoped', async () => {
        await AssetControlRepository.listByAsset(asTx(db), TENANT, 'a-1');
        expect(whereOf(db.controlAsset.findMany)).toEqual({ tenantId: TENANT, assetId: 'a-1' });

        db = makeDb();
        await AssetControlRepository.listByControl(asTx(db), TENANT, 'c-1');
        expect(whereOf(db.controlAsset.findMany)).toEqual({ tenantId: TENANT, controlId: 'c-1' });
    });

    it('defaults an unstated coverage type to UNKNOWN rather than null', async () => {
        // Break: forwarding `null`. `coverageType` is a non-nullable enum
        // column, so a null would be rejected at the driver and the "link
        // control" action would fail whenever the optional select is left
        // blank — which is the default state of the form.
        await AssetControlRepository.link(asTx(db), TENANT, 'a-1', 'c-1', null, null, 'user-1');

        expect(dataOf(db.controlAsset.create)).toEqual({
            tenantId: TENANT,
            assetId: 'a-1',
            controlId: 'c-1',
            coverageType: 'UNKNOWN',
            rationale: null,
            createdByUserId: 'user-1',
        });
    });

    it('honours an explicit coverage type', async () => {
        await AssetControlRepository.link(asTx(db), TENANT, 'a-1', 'c-1', 'FULL', 'Whole estate', 'user-1');

        expect(dataOf(db.controlAsset.create)).toMatchObject({
            coverageType: 'FULL',
            rationale: 'Whole estate',
        });
    });

    it('addresses the unlink by the tenant-leading composite key', async () => {
        await AssetControlRepository.unlink(asTx(db), TENANT, 'a-1', 'c-1');

        expect(whereOf(db.controlAsset.delete)).toEqual({
            tenantId_controlId_assetId: { tenantId: TENANT, controlId: 'c-1', assetId: 'a-1' },
        });
    });
});

describe('AssetRiskRepository', () => {
    it('lists both directions tenant-scoped', async () => {
        await AssetRiskRepository.listByAsset(asTx(db), TENANT, 'a-1');
        expect(whereOf(db.assetRiskLink.findMany)).toEqual({ tenantId: TENANT, assetId: 'a-1' });

        db = makeDb();
        await AssetRiskRepository.listByRisk(asTx(db), OTHER, 'r-1');
        expect(whereOf(db.assetRiskLink.findMany)).toEqual({ tenantId: OTHER, riskId: 'r-1' });
    });

    it('finds an existing link by the tenant-leading composite key', async () => {
        await AssetRiskRepository.findLink(asTx(db), TENANT, 'a-1', 'r-1');

        expect(whereOf(db.assetRiskLink.findUnique)).toEqual({
            tenantId_assetId_riskId: { tenantId: TENANT, assetId: 'a-1', riskId: 'r-1' },
        });
    });

    it('creates with MEDIUM exposure when none is stated', async () => {
        // Break: passing the null through. Same non-nullable-enum failure
        // as coverageType above — "link risk" with the optional exposure
        // left blank is the common case, not the edge case.
        await AssetRiskRepository.link(asTx(db), TENANT, 'a-1', 'r-1', null, null, 'user-1');

        expect(argOf(db.assetRiskLink.upsert).create).toEqual({
            tenantId: TENANT,
            assetId: 'a-1',
            riskId: 'r-1',
            exposureLevel: 'MEDIUM',
            rationale: null,
            createdByUserId: 'user-1',
        });
    });

    it('leaves an existing link untouched when re-linked with nothing new', async () => {
        // Break: building the update branch unconditionally. Re-linking an
        // already-linked pair from the UI (the idempotent path) would then
        // overwrite a stored exposure level with the default and wipe the
        // stored rationale.
        await AssetRiskRepository.link(asTx(db), TENANT, 'a-1', 'r-1', null, null, 'user-1');

        expect(argOf(db.assetRiskLink.upsert).update).toEqual({});
    });

    it('updates only the fields actually supplied on a re-link', async () => {
        await AssetRiskRepository.link(asTx(db), TENANT, 'a-1', 'r-1', 'HIGH', 'Now internet-facing', 'user-1');

        expect(argOf(db.assetRiskLink.upsert).update).toEqual({
            exposureLevel: 'HIGH',
            rationale: 'Now internet-facing',
        });
    });

    it('treats an empty rationale as a real value but an empty exposure as absent', async () => {
        // Pins the deliberate asymmetry in the source: `rationale` is
        // guarded with `!== null` (so clearing the text to '' persists),
        // while `exposureLevel` is guarded on truthiness (so '' means "no
        // change"). A reviewer "harmonising" the two would break one of
        // the two behaviours.
        await AssetRiskRepository.link(asTx(db), TENANT, 'a-1', 'r-1', '', '', 'user-1');

        expect(argOf(db.assetRiskLink.upsert).update).toEqual({ rationale: '' });
    });

    it('addresses the unlink by the tenant-leading composite key', async () => {
        await AssetRiskRepository.unlink(asTx(db), TENANT, 'a-1', 'r-1');

        expect(whereOf(db.assetRiskLink.delete)).toEqual({
            tenantId_assetId_riskId: { tenantId: TENANT, assetId: 'a-1', riskId: 'r-1' },
        });
    });
});
