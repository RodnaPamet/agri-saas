/**
 * `ModerationActor` — the three ways a moderation decision is attributed, and
 * the two fields that must agree about them (#2735).
 *
 * ## Why a union with three arms rather than a nullable id
 *
 * One `PLATFORM_ADMIN_API_KEY` is shared by every operator, so a decision made
 * with it can be attributed no further than which GENERATION authorised it —
 * *"a regulator asking 'who decided this' gets 'somebody holding the key'"*. A
 * session-gated console caller IS a person. And P9.3d's report-threshold job
 * decides with no human and no credential in scope at all.
 *
 * Collapsing those into one nullable `userId` produces a trail where "who" is
 * ambiguous, which is WORSE than an honest limit: a reader cannot tell "a
 * person decided this" from "somebody holding the key decided this and we lost
 * the detail" from "a rule fired". The discriminant keeps the three readings
 * apart, and a fourth kind adds an arm rather than widening one.
 *
 * ## The `automatic` arm exists because `tsc` found a FOURTH spelling
 *
 * Threading the actor through `queueStatement` made the compiler name
 * `channel-auto-hide.ts` as a caller with nothing to pass — and that job was
 * writing `moderatorRef: 'auto:report-threshold'` as a hardcoded literal,
 * outside the helper, exactly like the two in `account-suspension.ts` that the
 * first half of #2735 removed. Three spellings had become four.
 *
 * ## The stored bytes did not change, and that is asserted rather than assumed
 *
 * `auto:report-threshold` rows already exist in production from P9.3d. If the
 * helper rendered `system:report-threshold` instead, one attribution would be
 * split across two spellings in the same column and no migration would say so.
 */
import {
    actorUserIdFor,
    moderatorRefFor,
    type ModerationActor,
} from '@/lib/auth/platform-admin';

describe('#2735 — moderatorRefFor renders each kind distinguishably', () => {
    it('a session caller is named', () => {
        expect(moderatorRefFor({ kind: 'user', userId: 'u-moderator' }))
            .toBe('user:u-moderator');
    });

    it('a shared key names its GENERATION and no person', () => {
        expect(moderatorRefFor({ kind: 'platform-key', generation: 'current' }))
            .toBe('platform-key:current');
        expect(moderatorRefFor({ kind: 'platform-key', generation: 'previous' }))
            .toBe('platform-key:previous');
    });

    it('an automatic rule renders `auto:<rule>` — the BYTES P9.3d already wrote', () => {
        // Byte-for-byte what `channel-auto-hide.ts`'s literal produced. A
        // `system:` prefix would read better and would split one attribution
        // across two spellings in a column that already has rows.
        expect(moderatorRefFor({ kind: 'automatic', rule: 'report-threshold' }))
            .toBe('auto:report-threshold');
    });

    it('the three prefixes are mutually exclusive — the control', () => {
        // Without this, a helper that returned one constant would satisfy every
        // case above read individually.
        const refs = [
            moderatorRefFor({ kind: 'user', userId: 'u-1' }),
            moderatorRefFor({ kind: 'platform-key', generation: 'current' }),
            moderatorRefFor({ kind: 'automatic', rule: 'report-threshold' }),
        ];
        expect(new Set(refs).size).toBe(3);
        // And each is self-describing to a reader who has only the column,
        // which for a regulator reading an export is the usual case.
        expect(refs[0].startsWith('user:')).toBe(true);
        expect(refs[1].startsWith('platform-key:')).toBe(true);
        expect(refs[2].startsWith('auto:')).toBe(true);
        // No prefix is a prefix of another, or a `startsWith` filter over the
        // column would classify rows into two buckets at once.
        for (const a of refs) {
            for (const b of refs) {
                if (a !== b) expect(a.startsWith(b)).toBe(false);
            }
        }
    });
});

describe('#2735 — actorUserIdFor records a person only when there is one', () => {
    it('yields the id for a session caller', () => {
        expect(actorUserIdFor({ kind: 'user', userId: 'u-moderator' })).toBe('u-moderator');
    });

    it.each([
        ['platform-key', { kind: 'platform-key', generation: 'current' } as ModerationActor],
        ['automatic', { kind: 'automatic', rule: 'report-threshold' } as ModerationActor],
    ])('yields NULL for %s — truthfully, not as a fallback', (_label, actor) => {
        // NULL is the correct answer for both: a shared key names no person and
        // a rule is not one. Accepting an id from a request body to fill this in
        // would put a caller-supplied name in an attribution field, which is
        // worse than an absent one — the `FeatureFlag.updatedByUserId` rule.
        expect(actorUserIdFor(actor)).toBeNull();
    });

    it('the two fields AGREE about every kind', () => {
        // The pairing that matters: a chain entry naming a person in
        // `detailsJson.moderatorRef` while leaving `actorUserId` NULL is a
        // record a reader cannot interpret either way, and so is the reverse.
        const cases: ModerationActor[] = [
            { kind: 'user', userId: 'u-1' },
            { kind: 'platform-key', generation: 'current' },
            { kind: 'automatic', rule: 'report-threshold' },
        ];
        for (const actor of cases) {
            const ref = moderatorRefFor(actor);
            const id = actorUserIdFor(actor);
            // Exactly one direction of implication each way.
            expect(ref.startsWith('user:')).toBe(id !== null);
            if (id !== null) expect(ref).toBe(`user:${id}`);
        }
    });
});
