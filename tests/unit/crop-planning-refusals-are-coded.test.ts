/**
 * The ten crop-planning refusals carry codes, and the two that look alike are
 * NOT the same code (#1712).
 *
 * ## Why this is behavioural and needs no database
 *
 * Every one of these checks runs between `assertCanWrite` and
 * `runInTenantContext` — the input is sanitised and validated before a
 * connection is touched. So the usecases can be called with nothing but a
 * context, and a throw that happens here provably happened before any query.
 * That also means a `params` payload asserted here is the one a client
 * receives, not one reconstructed from the source text.
 *
 * ## The distinction the batch turns on
 *
 * `SEASON_INVALID_DATE` and `SEASON_WINDOW_INVERTED` are one `if` apart and
 * both are "something is wrong with the dates". They are deliberately
 * separate codes, because the remedies differ: the first means a value could
 * not be parsed, the second means both parsed and the window runs backwards.
 * A client that conflated them would re-prompt for a date the operator typed
 * correctly. The pair of cases below is what stops them being merged later.
 *
 * `CROP_PLAN_INVALID_DATE` goes the other way: the SAME code on create and
 * update, because it is the same field failing the same parse. Asserted from
 * both call sites so a later split is a test failure rather than a quiet
 * divergence.
 *
 * ## The positive control is not optional
 *
 * Every case here asserts a refusal. A mutation that made validation throw
 * unconditionally would satisfy all of them — the same trap
 * `farm-identity-claim-unique.test.ts` measured for RLS, where dropping both
 * policies left its refusal case passing. So the last describe proves a VALID
 * input gets past validation, which is what fails under blanket refusal.
 */
import { makeRequestContext } from '../helpers/make-context';
import {
    createSeason,
    updateSeason,
    createCropType,
    createCropVariety,
    createCropPlan,
    updateCropPlan,
} from '@/app-layer/usecases/crop-planning';

const ctx = makeRequestContext('EDITOR', { userId: 'u-1', tenantId: 't-1' });

interface Caught {
    code?: string;
    params?: Record<string, unknown>;
    status?: number;
    message?: string;
}

/** Call and return the thrown error, never the result. */
async function refusal(fn: () => Promise<unknown>): Promise<Caught> {
    try {
        await fn();
    } catch (e) {
        return e as Caught;
    }
    throw new Error('expected a refusal, got none');
}

const SEASON = { name: 'Пролет 2027', startDate: '2027-03-01', endDate: '2027-09-30' };
const PLAN = { name: 'План', seasonId: 's-1', cropTypeId: 'c-1', firstSowDate: '2027-03-15' };

describe('a blank name is coded, per entity', () => {
    // Four codes rather than one `NAME_REQUIRED`, matching the 64 existing
    // domain-prefixed codes — `FARM_NAME_REQUIRED` is the precedent. The
    // reasoning is recorded beside the ratchet in
    // `tests/guards/no-server-authored-user-copy.test.ts`.
    it.each([
        ['SEASON_NAME_REQUIRED', () => createSeason(ctx, { ...SEASON, name: '' } as never)],
        ['SEASON_NAME_REQUIRED', () => updateSeason(ctx, 's-1', { name: '' } as never)],
        ['CROP_TYPE_NAME_REQUIRED', () => createCropType(ctx, { name: '' } as never)],
        ['VARIETY_NAME_REQUIRED', () => createCropVariety(ctx, { name: '', cropTypeId: 'c-1' } as never)],
        ['CROP_PLAN_NAME_REQUIRED', () => createCropPlan(ctx, { ...PLAN, name: '' } as never)],
        ['CROP_PLAN_NAME_REQUIRED', () => updateCropPlan(ctx, 'p-1', { name: '' } as never)],
    ])('%s', async (code, call) => {
        const err = await refusal(call);
        expect(err.code).toBe(code);
        expect(err.status).toBe(400);
    });

    it('a name of only markup sanitises to nothing and is refused', async () => {
        // `sanitizePlainText` is what makes this reachable: the field is
        // non-empty on the wire and empty after sanitising, so a check on the
        // raw input would pass it through and store a blank name.
        const err = await refusal(() => createSeason(ctx, { ...SEASON, name: '<b></b>' } as never));
        expect(err.code).toBe('SEASON_NAME_REQUIRED');
    });

    it('a whitespace-only name is refused — GAP CLOSED (#1825)', async () => {
        // This case was called "DOCUMENTS A GAP" and asserted the OPPOSITE:
        // `expect(err.code).not.toBe('SEASON_NAME_REQUIRED')`, because
        // `sanitizePlainText` stripped markup without trimming, so
        // `if (!name)` caught only a truly empty string and `'   '` was
        // stored as a name. It asserted what HAPPENED rather than what
        // should, deliberately, so the gap stayed visible and this case
        // would fail the moment somebody fixed it.
        //
        // It did. `sanitizePlainText` trims as of 2026-10-15 (owner ruling
        // on #1825: trim in the one function rather than at 28 call sites,
        // so the 140th caller is correct without knowing it exists). The
        // flip is the proof the fix reaches this usecase: nothing in
        // `crop-planning.ts` changed.
        const err = await refusal(() => createSeason(ctx, { ...SEASON, name: '   ' } as never));
        expect(err.code).toBe('SEASON_NAME_REQUIRED');
    });

});

describe('an unparseable date names WHICH date', () => {
    it('startDate alone', async () => {
        const err = await refusal(() =>
            createSeason(ctx, { ...SEASON, startDate: 'not-a-date' } as never),
        );
        expect(err.code).toBe('SEASON_INVALID_DATE');
        expect(err.params?.field).toBe('startDate');
    });

    it('endDate alone', async () => {
        const err = await refusal(() =>
            createSeason(ctx, { ...SEASON, endDate: 'nope' } as never),
        );
        expect(err.code).toBe('SEASON_INVALID_DATE');
        expect(err.params?.field).toBe('endDate');
    });

    it('BOTH, which is what proves the field list is computed', async () => {
        // A hardcoded `field: 'startDate'` passes the first case and fails
        // here. This is the case that makes the param worth having.
        const err = await refusal(() =>
            createSeason(ctx, { ...SEASON, startDate: 'x', endDate: 'y' } as never),
        );
        expect(err.code).toBe('SEASON_INVALID_DATE');
        expect(err.params?.field).toBe('startDate,endDate');
    });

    it('the crop plan carries its field too, on create AND update', async () => {
        const onCreate = await refusal(() =>
            createCropPlan(ctx, { ...PLAN, firstSowDate: 'bad' } as never),
        );
        const onUpdate = await refusal(() =>
            updateCropPlan(ctx, 'p-1', { firstSowDate: 'bad' } as never),
        );

        // The SAME code from both, deliberately — same field, same parse.
        expect(onCreate.code).toBe('CROP_PLAN_INVALID_DATE');
        expect(onUpdate.code).toBe('CROP_PLAN_INVALID_DATE');
        expect(onCreate.params?.field).toBe('firstSowDate');
        expect(onUpdate.params?.field).toBe('firstSowDate');
    });
});

describe('an inverted window is a DIFFERENT refusal from an invalid date', () => {
    it('both dates parse and the window runs backwards', async () => {
        const err = await refusal(() =>
            createSeason(ctx, {
                ...SEASON,
                startDate: '2027-09-30',
                endDate: '2027-03-01',
            } as never),
        );

        expect(err.code).toBe('SEASON_WINDOW_INVERTED');
        // Both halves: asserting only `toBe` above would still pass if the two
        // codes were merged into one name, and this says they are not the same
        // refusal rather than merely that one of them fired.
        expect(err.code).not.toBe('SEASON_INVALID_DATE');
    });

    it('equal start and end is ACCEPTED — the check is `<`, not `<=`', async () => {
        // A one-day season is legitimate, and this is the boundary that
        // distinguishes the real check from an off-by-one. It gets PAST
        // validation, so it fails later for a reason that is not one of ours.
        const err = await refusal(() =>
            createSeason(ctx, {
                ...SEASON,
                startDate: '2027-05-01',
                endDate: '2027-05-01',
            } as never),
        );
        expect(err.code).not.toBe('SEASON_WINDOW_INVERTED');
        expect(err.code).not.toBe('SEASON_INVALID_DATE');
    });
});

describe('POSITIVE CONTROL: valid input gets past validation', () => {
    // Without this, a mutation making validation throw unconditionally would
    // satisfy every case above. These inputs are well-formed, so whatever
    // they fail on is NOT one of this batch's codes — there is no database
    // here, so they fail at the connection instead.
    const OURS = [
        'SEASON_NAME_REQUIRED',
        'SEASON_INVALID_DATE',
        'SEASON_WINDOW_INVERTED',
        'CROP_TYPE_NAME_REQUIRED',
        'VARIETY_NAME_REQUIRED',
        'CROP_PLAN_NAME_REQUIRED',
        'CROP_PLAN_INVALID_DATE',
    ];

    it.each([
        ['createSeason', () => createSeason(ctx, SEASON as never)],
        ['createCropType', () => createCropType(ctx, { name: 'Пшеница' } as never)],
        ['createCropPlan', () => createCropPlan(ctx, PLAN as never)],
    ])('%s with good input is not refused by this batch', async (_label, call) => {
        const err = await refusal(call);
        expect(OURS).not.toContain(err.code);
    });
});
