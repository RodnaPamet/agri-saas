/**
 * The refusal text of `timestamps-declare-their-format`, EXECUTED (#2557).
 *
 * #2543 declared an expiry as `z.union([z.string().datetime(), z.null()])`.
 * `.datetime()` was right there; the rendered property carried no `format`
 * because it sat on an `anyOf` branch; the guard correctly refused it and
 * printed "Add `.datetime()` to the Zod declaration" — advice the author had
 * already taken. That guard's docblock says it exists to buy back twenty
 * minutes, and that run spent them instead.
 *
 * #2555 corrected the spelling, so against today's spec the union group is
 * EMPTY and the new sentence renders for nobody. That is the whole reason this
 * file exists rather than a second `if` inside the guard: a branch that only
 * fires for a shape the repo no longer emits is unexecuted text — the failure
 * mode that guard was already carrying once.
 *
 * So the population here is SYNTHETIC on purpose. The real one is empty by
 * design, and a test over it would assert nothing.
 */
import {
    describeMissingFormats,
    branchFormatOf,
    type Found,
} from '../../helpers/timestamp-format-advice';

const absent: Found = {
    root: 'TaskDetail',
    where: 'startedAt',
    format: null,
    branchFormat: null,
};
const onBranch: Found = {
    root: 'ExchangeListingEdit',
    where: 'expiresAt',
    format: null,
    branchFormat: 'date-time',
};

describe('branchFormatOf reads a format out of a union (#2557)', () => {
    it('finds it on an anyOf branch — the z.union spelling', () => {
        expect(
            branchFormatOf({
                anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
            }),
        ).toBe('date-time');
    });

    it('finds it on a oneOf branch too', () => {
        // Nothing in the spec emits `oneOf` today. Covered so that the day
        // something does, the advice is already right rather than silently
        // falling through to the wrong sentence.
        expect(
            branchFormatOf({ oneOf: [{ type: 'null' }, { type: 'string', format: 'date' }] }),
        ).toBe('date');
    });

    it('returns null for a plain property, a formatless union, and a non-object', () => {
        // The negatives matter: a non-null answer here changes which sentence a
        // reader gets, so a loose reader would mis-advise every bare `string`.
        expect(branchFormatOf({ type: 'string' })).toBeNull();
        expect(branchFormatOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBeNull();
        expect(branchFormatOf({ anyOf: 'not-an-array' })).toBeNull();
        expect(branchFormatOf(null)).toBeNull();
        expect(branchFormatOf('string')).toBeNull();
    });
});

describe('the refusal names the right cause (#2557)', () => {
    it('a property with NO format anywhere gets the add-.datetime() advice', () => {
        const msg = describeMissingFormats([absent], 180);
        expect(msg).toContain('NO format anywhere (1)');
        expect(msg).toContain('TaskDetail.startedAt');
        expect(msg).toContain('Add `.datetime()` to the Zod declaration');
        // It must not send a reader after a union they do not have.
        expect(msg).not.toContain('UNION BRANCH');
        expect(msg).not.toContain('.nullable()');
    });

    it('a format on a union BRANCH gets the nullable-spelling advice instead', () => {
        const msg = describeMissingFormats([onBranch], 180);
        expect(msg).toContain('FORMAT IS ON A UNION BRANCH (1)');
        expect(msg).toContain('ExchangeListingEdit.expiresAt');
        expect(msg).toContain('branch carries `date-time`');
        expect(msg).toContain('z.string().datetime().nullable()');
        // THE DEFECT #2557 RECORDS: it must not tell an author to add a
        // `.datetime()` that is already in their declaration.
        expect(msg).not.toContain('Add `.datetime()` to the Zod declaration');
    });

    it('still reports a union-branch property as MISSING, not as satisfied', () => {
        // The tempting wrong fix is to accept a union whose branches all carry
        // a format, which would bless the shape #1391 exists to discourage. The
        // count must include it, and the text must say why it still counts.
        const msg = describeMissingFormats([onBranch], 180);
        expect(msg).toContain('1 of 180 response-side timestamps are typed without a');
        expect(msg).toContain('still counts as missing ON PURPOSE');
    });

    it('a MIXED batch carries both sentences, both counts, and absent first', () => {
        const msg = describeMissingFormats([absent, onBranch], 180);
        expect(msg).toContain('2 of 180 response-side timestamps');
        expect(msg).toContain('NO format anywhere (1)');
        expect(msg).toContain('FORMAT IS ON A UNION BRANCH (1)');
        expect(msg).toContain('TaskDetail.startedAt');
        expect(msg).toContain('ExchangeListingEdit.expiresAt');
        expect(msg.indexOf('NO format anywhere')).toBeLessThan(msg.indexOf('UNION BRANCH'));
    });

    it('omits a group entirely when it is empty — no empty heading', () => {
        // A "NO format anywhere (0)" heading over nothing reads as a finding
        // with its list lost, which is how a reader is sent to look for a
        // property that was never reported.
        expect(describeMissingFormats([onBranch], 180)).not.toContain('NO format anywhere');
        expect(describeMissingFormats([absent], 180)).not.toContain('UNION BRANCH');
    });
});
