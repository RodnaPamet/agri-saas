# 2026-10-06 — `avatarUrl` on `/api/auth/me`, and `GET /api/account/avatar/{userId}` documented

**Issue:** #1299 (from agrent-ios#149)

Two halves of one gap: `/api/auth/me` did not say whether the caller had an
avatar, and the route that serves one was live and undescribed. iOS therefore
fell back to probing `GET /api/account/avatar/{userId}` — which only ever
answers for an UPLOADED avatar — so an account whose photo came from an OAuth
sign-in showed a photo on the web and initials on the phone.

## Design

### `avatarUrl` is a projection, not a chain

The issue asked for `avatarUrl` as "the uploaded avatar route if one exists,
else `User.image`, else null". That chain is unnecessary, because the write
path already collapses it into one column:

| case | who writes `User.image` | value |
| --- | --- | --- |
| uploaded | `uploadOwnAvatar` (`src/lib/account/avatar.ts`) | `avatarServeUrl(userId)` → `/api/account/avatar/<id>` |
| OAuth sign-in | `PrismaAdapter` at first sign-in | the provider's photo URL |
| neither | `removeOwnAvatar` clears it; a user who never had one never had a value | `null` |

So `avatarUrl` is `user.image ?? null`, and `image` rides the `findUnique` the
handler already runs. That cost matters: `/api/auth/me` is the launch request
every client makes, and the literal reading of the issue — "if one exists" —
is a storage `head` probe per launch, buying an answer the column already
holds. The three cases above were verified against the current tree, not taken
from the issue: `tests/unit/account-avatar.test.ts` already pins both the
upload write (`{ image: '/api/account/avatar/u1' }`) and the removal
(`{ image: null }`).

It is read from the DATABASE, not from the session. `session.user.image` comes
from the token's `picture` claim, minted at sign-in, so it is stale between an
avatar upload and the next session refresh; the DB read is current.

### The relative-vs-absolute hazard is the contract

The value has two shapes and is returned AS STORED:

- root-relative (`/api/account/avatar/<id>`) for an uploaded avatar — resolve
  against the API base, send the cookie or bearer;
- absolute third-party `https://` (e.g. `lh3.googleusercontent.com`) for a
  provider photo — fetch as given, attach NO credentials.

Both mistakes are real and asymmetric. Resolving an absolute provider URL
against the API base 404s — annoying. Attaching the bearer to it ships the
token to a third party — not annoying. A client branches on whether the value
starts with `/`.

Absolutising server-side was considered and rejected (and the iOS session
confirmed they want it left as stored): one shape would be tidier to consume,
but it would hide which host is about to be contacted, which is precisely the
fact that decides whether credentials may travel with the request. The whole
argument is written into the `avatarUrl` description in `account.paths.ts`, so
the next client does not have to rediscover it.

### `.optional()`, and what the breaking-change gate actually says

`AvatarUrl` is `z.string().nullable().optional()`. `.nullable()` is the real
"no avatar" state. `.optional()` is for a different reason: the field is new,
and a client built against this contract can be talking to a server that
predates it, where the key is simply absent. Absent and `null` mean the same
thing to a reader.

That also keeps it out of `CurrentUser.user.required`, which matters, and the
alternative was MEASURED rather than assumed. With `.nullable()` alone the
field lands in `required` and
`tests/contracts/openapi-breaking-change.test.ts` reports, against the PR's
base:

```
[property-now-required] CurrentUser.user.avatarUrl —
  "user.avatarUrl" is now required; a client that omits it is rejected
```

The classifier's rule is request-shaped ("a client that OMITS it"), so for a
response field the finding reads oddly — but it is the documented, intended
behaviour (CLAUDE.md: *"if you remove a property, narrow an enum or make a
field required, the gate goes red and is supposed to"*), and the honest field
here is optional anyway. Nothing was relaxed to get past it.

### Documenting the serve route

`/api/account/avatar/{userId}` leaves
`tests/guards/openapi-undocumented-baseline.json` in the same diff that
describes it, and `UNDOCUMENTED_CEILING` drops 244 → 243 — the direction that
guard's sibling assertion demands. `npm run routes:inventory` flips its
`documented` flag to `true` (131 documented / 243 undocumented of 374).

Three details the entry carries that a reader of the route file would have to
work out:

- the 200 is `image/webp` BYTES (declared as `format: binary`, like the WMS
  tile), not JSON — the response-shapes ratchet is at zero, so a declared
  non-JSON media type is how an operation documents a binary body;
- the 404 is the ORDINARY answer, not an error to log. It is what every user
  without an uploaded avatar returns, including every user whose photo came
  from an OAuth provider, and `<InitialsAvatar>` falls back to initials on it.
  `extraResponses` overrides the shared envelope's generic 404 text to say so;
- ANY authenticated user may read ANY user id, deliberately — avatars render
  across member lists and people-pickers, so a per-viewer check would break
  the surfaces the route exists for. A non-existent id and a user with no
  avatar are indistinguishable.

## Files

| file | role |
| --- | --- |
| `src/app/api/auth/me/route.ts` | selects `image`; returns `avatarUrl: user?.image ?? null` |
| `src/lib/openapi/paths/account.paths.ts` | the `AvatarUrl` schema + description, and the `getUserAvatar` operation |
| `src/generated/openapi.json` | regenerated (`CI=1 npm run openapi:generate`) |
| `src/generated/route-inventory.json` | regenerated; `documented: true` for the serve route |
| `tests/contracts/__snapshots__/api-schemas.test.ts.snap` | `CurrentUser` fragment |
| `tests/guards/openapi-undocumented-baseline.json` | serve route removed |
| `tests/guards/openapi-paths-complete.test.ts` | `UNDOCUMENTED_CEILING` 244 → 243 |
| `tests/unit/auth-me-avatar-url.test.ts` | NEW — the projection, both shapes, and the no-extra-query property |
| `tests/unit/account-avatar-serve-contract.test.ts` | NEW — executes the four claims the new spec entry makes |
| `tests/unit/bearer-cookie-parity.test.ts` | a non-tenant account path, both transports; `bothTransports` now accepts `null` claims |
| `tests/guards/openapi-paths-non-empty.test.ts` | `getCurrentUser` + `getUserAvatar` in `REQUIRED_OPERATION_IDS` |
| `CLAUDE.md` | retires a false carve-out; refreshes the inventory counts |

## Decisions

- **No fallback chain and no existence check.** Covered above; the test
  asserts it as a CALL COUNT plus the `select`'s own shape, so a later "let me
  just check whether the object is really there" fails rather than quietly
  adding a per-launch storage round-trip.
- **The projection test imports `avatarServeUrl` rather than hard-coding
  `/api/account/avatar/<id>`.** The premise lives in the avatar lib; if its
  serve-URL shape changes, the projection test must redden with it instead of
  the two halves agreeing on different strings.
- **A serve-route test, even though the route is not new.** Documenting it is
  what made its status codes and headers a contract. Nothing executed them
  before: `account-avatar.test.ts` covers the lib, and
  `avatar-renderer-convergence.test.ts` matches source TEXT, which cannot see
  a 404 or a `Cache-Control`. `Cache-Control` in particular is a literal this
  repo has broken before: a project-wide entity rename mangled 39 of these
  header names with the whole suite green, which is why
  `tests/guards/web-platform-identifiers.test.ts` exists. That guard caught
  the first draft of the serve-route test, whose docblock quoted the mangled
  spelling as a cautionary tale — the ban is on the TOKEN, anywhere under
  `src/` and `tests/`, prose included. Worth knowing before you write the
  story down.
- **The bearer claim is asserted at the EDGE, in the existing parity
  harness.** `op()` declares `sessionCookie` AND `bearerToken` on the new
  operation, and iOS uses the second. Every case in
  `bearer-cookie-parity.test.ts` was an `/api/t/{slug}/…` path, so all of them
  went through `checkTenantAccess`; `/api/account/avatar/{userId}` carries no
  slug and is not an `isPersonPath` prefix either, so it takes a different
  route through the middleware that had no bearer/cookie assertion over it.
  Added there rather than in a new file — the harness and the subject already
  matched. One of the four new cases is a negative control (no token ⇒ 401),
  because "not 401 on both transports" is also what a middleware that admits
  everything produces. That control is driven through `bothTransports`, whose
  claims parameter was widened to accept `null`, rather than through a fourth
  hand-rolled `middleware(...)` call — the first draft did the latter and cost
  one `{} as any`, which the lint ceiling counted as a new SUPPRESSED finding
  (1581 against a ceiling of 1580) even though the file carries a blanket
  `no-explicit-any` disable. Worth knowing: in this repo an inline `as any`
  under a file-level disable is NOT free, and a refusal has to be
  transport-blind too, so the widening is the better test as well as the
  cheaper one. (The first lint reading of that failure was itself wrong —
  `npm run lint | tail` reports `tail`'s exit code, so the FAIL text appeared
  next to a 0. The gate exits 1 correctly; the harness lied.)
- **CLAUDE.md's `/api/account/**` carve-out was false and is retired, not
  annotated.** It said those routes are cookie-only by design and call
  `getServerSession` directly, "pinned by" two guards. All five call `auth()`;
  both guards pin `auth()`, and the avatar one's comment says pinning the raw
  helper "was enforcing a cookie-only route by accident". The claim directly
  contradicted this diff, which documents one of those routes as
  bearer-accepting.

## Mutation proofs

Each mutation was applied at the CALL SITE, the suite run, and the file
restored. `tests/unit/auth-me-avatar-url.test.ts` (9 tests):

| mutation in `me/route.ts` | result |
| --- | --- |
| `new URL(user.image, 'https://app.agrent.bg')` — absolutise | **3 failed**, incl. "stays RELATIVE — it never gains an origin" |
| delete the `avatarUrl` line | **7 failed**, incl. "the key is PRESENT … null, never absent" |
| resolve it from a SECOND `findUnique` | **1 failed** — "costs NO extra query and NO existence probe" |
| drop `image: true` from the `select` | **1 failed** — same test, via the select assertion |

`tests/unit/account-avatar-serve-contract.test.ts` (5 tests):

| mutation in `avatar/[userId]/route.ts` | result |
| --- | --- |
| `Cache-Control: private` → `public` | **1 failed** — the header pair |
| `getAvatarStream(session.user.id)` instead of the path id | **1 failed** — "reads the avatar of the id IN THE PATH" |
| auth check moved AFTER the storage probe | **1 failed** — "the storage layer is never consulted" |

`tests/unit/bearer-cookie-parity.test.ts` (9 tests, 5 before):

| mutation in `src/middleware.ts` | result |
| --- | --- |
| refuse any `/api/account/*` request carrying `Authorization` | **2 failed** |
| tenant-gate `/api/account/*` on a non-empty `memberships[]` | **1 failed** — "a member of NO tenant still reaches it" |
