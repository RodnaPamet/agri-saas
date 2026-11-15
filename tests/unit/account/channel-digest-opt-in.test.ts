/**
 * The channel-digest opt-in REQUIRES its key, and that requirement is the
 * whole control (#2941).
 *
 * The failure it prevents: under an optional or defaulted field a misspelled
 * `{ optin: true }` parses to `{}`, `optIn` reads `undefined`, the route
 * writes `false` and answers 200. The person is told their opt-in was saved
 * and then never hears anything — and nothing fails, because an opt-in that
 * silently means "off" produces exactly the observable of a working feature
 * nobody has enabled. Same reasoning as `/api/account/bottom-tabs`'s REQUIRED
 * `order`; here the two states being kept apart are "they chose off" and "we
 * could not tell what they chose".
 *
 * ## This file's own correction, which is why the mechanism is named
 *
 * The schema was `.strict()` first and this docblock credited strictness with
 * catching the misspelling. A mutation removing `.strict()` left all five
 * cases GREEN: zod strips unknown keys by default, so `{ optin: true }` was
 * always failing as a MISSING key and never as an unknown one. The claim was
 * true and its stated mechanism was not — the negative test was satisfied by
 * a different mechanism from the one it named.
 *
 * So the last case here is the discriminating one, and it asserts the
 * OPPOSITE of what a strict schema would do: an unknown key is accepted. That
 * is deliberate forward compatibility — a newer client sending an extra field
 * must keep working against an older server, since the web and native release
 * cycles are not coupled.
 */
import { ChannelDigestOptInSchema } from '@/lib/account/channel-digest';

describe('ChannelDigestOptInSchema', () => {
    it('accepts both explicit states', () => {
        expect(ChannelDigestOptInSchema.safeParse({ optIn: true }).success).toBe(true);
        expect(ChannelDigestOptInSchema.safeParse({ optIn: false }).success).toBe(true);
    });

    it('refuses a MISSING key rather than defaulting it', () => {
        // The failure this schema exists to prevent: defaulting an absent key
        // to `false` cannot be told apart from somebody deliberately opting
        // out, and only one of those should answer 200.
        expect(ChannelDigestOptInSchema.safeParse({}).success).toBe(false);
    });

    it('refuses a MISSPELLED key instead of writing nothing and reporting success', () => {
        // Refused because `optIn` is MISSING once the unknown key is
        // stripped — not because the schema rejects unknown keys. Both
        // spellings below carry no `optIn` at all.
        expect(ChannelDigestOptInSchema.safeParse({ optin: true }).success).toBe(false);
        expect(ChannelDigestOptInSchema.safeParse({ enabled: true }).success).toBe(false);
    });

    it('ACCEPTS an unknown key alongside a valid one — forward compatibility', () => {
        // The discriminating case, and the one the `.strict()` version got
        // wrong. A newer client that starts sending `{ optIn, source }` must
        // keep working against an older server; a 400 on a field the server
        // merely does not know about turns an additive client change into an
        // outage. The unknown key is stripped, so nothing extra is persisted.
        const parsed = ChannelDigestOptInSchema.safeParse({ optIn: true, source: 'settings' });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data).toEqual({ optIn: true });
    });

    it('refuses a truthy non-boolean', () => {
        // A client sending `"true"` has a bug, and coercing it would hide
        // that bug on the one surface where a wrong answer is silent.
        for (const bad of ['true', 1, 0, null, [], 'on']) {
            expect(ChannelDigestOptInSchema.safeParse({ optIn: bad }).success).toBe(false);
        }
    });

    it('refuses a non-object body', () => {
        for (const bad of [null, undefined, 'optIn', 42, []]) {
            expect(ChannelDigestOptInSchema.safeParse(bad).success).toBe(false);
        }
    });
});
