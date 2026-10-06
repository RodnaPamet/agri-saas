# P3.5a — disposable-email blocking

*2026-10-06 · roadmap #1194*

The first of P3.5's six parts. It is deliberately the piece that needs no
operator secret, because the next one does — see the Turnstile note below.

## It is a speed bump, and the code says so

New throwaway domains appear daily; no bundled list keeps up. The wall is email
verification, which already exists: an address that cannot receive the code gets
no farm. What the list buys is the volume case — the handful of providers behind
most casual signups, refused at entry with a code the client can explain, rather
than silently accepted and swept seven days later as unverified.

So it **fails open**. An unknown domain is allowed, an unparseable address is
allowed, and nothing throws. Refusing a real farmer their real address is far
more expensive than letting a throwaway through, which verification catches
anyway. The suite is weighted accordingly — more cases prove it does not
over-block than prove it blocks.

## Subdomains are the part an exact match misses

Mailinator and several others deliver to **arbitrary subdomains**:
`anything.mailinator.com` reaches the same public inbox. An exact-domain check
blocks the provider's front page and none of its actual traffic. Matching walks
the domain and every parent of it.

Walking *suffixes*, not prefixes — `mailinator.com.bg` is a `.bg` domain that
merely starts with the same labels, and a prefix walk would refuse it. That is
one of the five mutation cases.

## Placement in the route

Before the duplicate-email lookup, for two reasons: it is a set lookup rather
than a query, and answering "already registered" for a disposable domain would
confirm which throwaway addresses exist.

It returns a stable **code** (`disposable_email`), not prose.
`tests/guards/no-server-authored-user-copy.test.ts` exists because
server-authored English reaches clients verbatim — `ApiClientError` preserves
`message` and the iOS app renders the raw envelope — so the client maps the code
to localised copy. My first draft called a `tErr()` helper that does not exist
in this route; the route localises nothing today, and inventing an API is worse
than following the convention.

## Mutation-proved five ways

Exact-match-only, no lower-casing, a prefix walk instead of a suffix walk, the
trailing dot left unstripped, and the list emptied — each reddens its own cases.
The emptied-list case is the one that matters: without the non-empty assertion,
deleting every entry leaves most of the suite green, because most of it asserts
`false`.

## Blocker found while scoping the rest of P3.5

**P0.7 is ticked as having configured Turnstile. It has not been.** No
`TURNSTILE_*` in `src/env.ts`, neither key present on the VM (presence checked,
never values), no verification code anywhere. Raised on #1191. P3.5's Turnstile
part therefore needs env schema, a siteverify call, the widget, and two keys an
operator must create — the keys are not something this session can produce.

## Remaining in P3.5

Verify-email-before-farm (the architectural inversion), Turnstile, beta access
codes, a 7-day sweep of unverified accounts, and no AI budget until the farm is
verified.
