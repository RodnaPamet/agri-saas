/**
 * «Въпрос» is creatable and `CARD` is NOT — #2961.
 *
 * ## Two halves of one gap
 *
 * `ChannelPostKind` has carried `QUESTION` since P9.1 and `setQuestionResolved`
 * has been able to resolve one since P9.3b — but `postToChannel` took no
 * `kind`, so **nothing could create a question**. P9.3b's own suite works
 * around it with a raw `prisma.channelPost.update({ data: { kind: 'QUESTION' }})`,
 * which is the tell: the test had to reach past the API because the API had no
 * way in.
 *
 * So «Решено» was unobservable (no field on the view) on a kind that was
 * unreachable (no field on the request). Both are fixed together, because
 * either alone leaves the feature unusable.
 *
 * ## `CARD` is the half that must stay refused
 *
 * A card is machine-written by P9.4's queue — a price card, a support scheme,
 * an event. Accepting `CARD` from a caller would let any member post something
 * that renders as the platform's own data, which is a forgery surface rather
 * than a feature. The control is the NARROW UNION: `z.enum(['POST',
 * 'QUESTION'])`. A `z.nativeEnum(ChannelPostKind)` would read as the obvious
 * choice, track the schema automatically, and admit it.
 *
 * That is why this file asserts the enum's MEMBERSHIP rather than only that a
 * valid value parses: the failure to guard against is a widening that looks
 * like tidying.
 */
import { ChannelPostKind } from '@prisma/client';

import { CreateChannelPostSchema } from '@/lib/schemas';

describe('CreateChannelPostSchema.kind', () => {
    it('accepts POST and QUESTION', () => {
        for (const kind of ['POST', 'QUESTION'] as const) {
            const parsed = CreateChannelPostSchema.safeParse({ body: 'текст', kind });
            expect(parsed.success).toBe(true);
            expect(parsed.success && parsed.data.kind).toBe(kind);
        }
    });

    it('REFUSES CARD, which is machine-written', () => {
        const parsed = CreateChannelPostSchema.safeParse({ body: 'текст', kind: 'CARD' });
        expect(parsed.success).toBe(false);
    });

    it('refuses an unknown kind rather than ignoring it', () => {
        // Dropping an unrecognised value would create a `POST` while the
        // caller believed they had created something else.
        const parsed = CreateChannelPostSchema.safeParse({ body: 'текст', kind: 'POLL' });
        expect(parsed.success).toBe(false);
    });

    it('is OPTIONAL, so a client predating the field is unaffected', () => {
        const parsed = CreateChannelPostSchema.safeParse({ body: 'текст' });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.kind).toBeUndefined();
    });

    it('CARD exists in the Prisma enum — so the refusal is a CHOICE, not an accident', () => {
        // THE CONTROL. Without it, the refusal above would also pass if `CARD`
        // had never existed or had been renamed, and this file would be
        // asserting nothing about a forgery surface. It is also the line that
        // fails if a future phase renames the member, which is when somebody
        // should re-read the paragraph above.
        const members = Object.values(ChannelPostKind) as string[];
        expect(members).toContain('CARD');
        expect(members).toContain('QUESTION');
        expect(members).toContain('POST');
        // And the accepted set is a STRICT SUBSET: the point is the gap.
        const accepted = ['POST', 'QUESTION'];
        expect(members.filter((m) => !accepted.includes(m))).toEqual(['CARD']);
    });
});
