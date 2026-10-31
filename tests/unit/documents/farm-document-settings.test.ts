/**
 * The «Документи» settings usecase (#2495 step 3).
 *
 * Three properties here are contract rather than behaviour-as-written, so
 * they are asserted rather than left to review:
 *
 *   - **A farm with no settings row reads as the defaults and WRITES
 *     NOTHING.** A GET that lazily created a row would turn opening a
 *     settings screen into a mutation — and `documents.view` is a READ
 *     permission, so a reader without `documents.manage` would be
 *     provoking a write they are not allowed to make.
 *   - **`driveSync: false` is a VALUE, not an absence.** The patch is built
 *     with `!== undefined` for exactly this reason; a truthiness check
 *     reads turning the setting OFF as "no change requested", so the one
 *     operation a farmer performs to stop copying their documents to a
 *     third party silently does nothing.
 *   - **A partial patch leaves the other field alone.** `upsert`'s `update`
 *     branch must carry only what was asked for, or editing the retention
 *     period resets the Drive setting to its default.
 *
 * `mayEdit` is reported from the caller's own permissions so the client can
 * render the form read-only; it is not the enforcement, which is
 * `assertCanAdmin` on the write and asserted below.
 */
import type { RequestContext } from '@/app-layer/types';

const db = {
    tenantDocumentSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    // `readDocumentStorageUsage` is raw SQL — it sums `FileRecord.sizeBytes`
    // joined through `FarmDocument` and filters on `purgedAt IS NULL`, which
    // Prisma's aggregate cannot express. The double therefore stands in for a
    // tagged template, and `::bigint` means the row carries a BigInt.
    $queryRaw: jest.fn(),
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

const logEventMock = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));

import {
    getFarmDocumentSettings,
    updateFarmDocumentSettings,
} from '@/app-layer/usecases/farm-documents';
import { documentStorageLimitBytes } from '@/app-layer/documents/budget';
import { makeRequestContext } from '../../helpers/make-context';

/**
 * Usage is read once, through `readDocumentStorageUsage`, which is also what
 * the upload refusal reads — so this one stub drives both numbers the settings
 * GET reports. Returns a BigInt because the query casts to `::bigint`, and a
 * caller that forgot `Number()` would hand `NaN` to the client.
 */
function setUsedBytes(bytes: number): void {
    db.$queryRaw.mockResolvedValue([{ total: BigInt(bytes) }]);
}

function ctx(role: 'ADMIN' | 'EDITOR' = 'ADMIN'): RequestContext {
    return makeRequestContext(role, { tenantId: 'tenant-1', tenantSlug: 'acme' });
}

beforeEach(() => {
    jest.clearAllMocks();
    db.tenantDocumentSettings.findUnique.mockResolvedValue(null);
    db.tenantDocumentSettings.upsert.mockResolvedValue({});
    setUsedBytes(0);
});

describe('getFarmDocumentSettings', () => {
    it('answers the defaults for a farm with no row, and writes nothing', async () => {
        const result = await getFarmDocumentSettings(ctx());

        expect(result).toMatchObject({ retention: 'P1Y', driveSync: false });
        // The load-bearing half — a read must not create the row.
        expect(db.tenantDocumentSettings.upsert).not.toHaveBeenCalled();
    });

    it('answers the stored row when there is one', async () => {
        db.tenantDocumentSettings.findUnique.mockResolvedValue({
            retention: 'P5Y',
            driveSync: true,
        });

        await expect(getFarmDocumentSettings(ctx())).resolves.toMatchObject({
            retention: 'P5Y',
            driveSync: true,
        });
    });

    it('reports the usage and the ceiling together', async () => {
        setUsedBytes(1_234_567);

        const result = await getFarmDocumentSettings(ctx());

        expect(result.usedBytes).toBe(1_234_567);
        expect(result.limitBytes).toBe(documentStorageLimitBytes());
        // Both numbers from one place: a console that computed the ceiling
        // differently from the refusal would tell a farmer they have room
        // while the upload refuses them.
        expect(result.limitBytes).toBeGreaterThan(0);
    });

    it('reports mayEdit from the caller permissions, not from the row', async () => {
        await expect(getFarmDocumentSettings(ctx('ADMIN'))).resolves.toMatchObject({
            mayEdit: true,
        });
        await expect(getFarmDocumentSettings(ctx('EDITOR'))).resolves.toMatchObject({
            mayEdit: false,
        });
    });
});

describe('updateFarmDocumentSettings', () => {
    it('refuses a caller who cannot administer the farm', async () => {
        await expect(
            updateFarmDocumentSettings(ctx('EDITOR'), { retention: 'P5Y' }),
        ).rejects.toThrow();
        expect(db.tenantDocumentSettings.upsert).not.toHaveBeenCalled();
    });

    it('refuses a retention period that is not one of the choices', async () => {
        await expect(
            updateFarmDocumentSettings(ctx(), { retention: 'P7Y' }),
        ).rejects.toMatchObject({ code: 'DOCUMENT_RETENTION_INVALID' });
        // A period the client invented must not reach the column — the
        // sweep compares these as strings and would never match it.
        expect(db.tenantDocumentSettings.upsert).not.toHaveBeenCalled();
    });

    it('refuses a driveSync that is not a boolean', async () => {
        await expect(
            updateFarmDocumentSettings(ctx(), { driveSync: 'yes' }),
        ).rejects.toMatchObject({ code: 'DOCUMENT_DRIVE_SYNC_INVALID' });
    });

    it('treats driveSync false as a VALUE, not as absent', async () => {
        db.tenantDocumentSettings.findUnique.mockResolvedValue({
            retention: 'P1Y',
            driveSync: true,
        });

        await updateFarmDocumentSettings(ctx(), { driveSync: false });

        expect(db.tenantDocumentSettings.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ update: { driveSync: false } }),
        );
    });

    it('leaves the other field alone on a partial patch', async () => {
        await updateFarmDocumentSettings(ctx(), { retention: 'P2Y' });

        const arg = db.tenantDocumentSettings.upsert.mock.calls[0][0];
        expect(arg.update).toEqual({ retention: 'P2Y' });
        // The create branch still needs a complete row, so the default
        // appears THERE and not in the update.
        expect(arg.create).toMatchObject({ retention: 'P2Y', driveSync: false });
    });

    it('writes an audit entry carrying only what changed', async () => {
        await updateFarmDocumentSettings(ctx(), { retention: 'P6M' });

        expect(logEventMock).toHaveBeenCalledTimes(1);
        const payload = logEventMock.mock.calls[0][2];
        expect(payload).toMatchObject({
            action: 'FARM_DOCUMENT_SETTINGS_UPDATED',
            entityType: 'TenantDocumentSettings',
            detailsJson: { retention: 'P6M' },
        });
        /**
         * No prose about the farm in detailsJson beyond the patch itself, plus
         * the `category` discriminator `validateAuditDetailsJson` REQUIRES —
         * without which this write throws an uncoded 400 and the retention
         * change fails outright, which is how the owner found it.
         *
         * Still an EXACT key set, so farm prose added here still fails; the
         * two assertions below are the ones the old key list gave for free and
         * are kept explicit now that the set is wider.
         */
        expect(Object.keys(payload.detailsJson).sort()).toEqual([
            'category',
            'changedFields',
            'entityName',
            'operation',
            'retention',
        ]);
        expect(payload.detailsJson.changedFields).toEqual(['retention']);
        // The field that did NOT change must not appear.
        expect(payload.detailsJson.driveSync).toBeUndefined();
    });

    it('accepts every retention the sweep understands', async () => {
        for (const retention of ['P3M', 'P6M', 'P1Y', 'P2Y', 'P5Y', 'NONE']) {
            db.tenantDocumentSettings.upsert.mockClear();
            await updateFarmDocumentSettings(ctx(), { retention });
            expect(db.tenantDocumentSettings.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ update: { retention } }),
            );
        }
    });
});
