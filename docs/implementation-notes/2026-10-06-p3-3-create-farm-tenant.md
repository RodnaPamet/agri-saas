# P3.3 — one tenant-creation helper, and the census that was wrong

*2026-10-06 · roadmap #1194*

Two things: Bulgarian Cyrillic → Latin transliteration for slugs and handles,
and `createFarmTenant` — the single implementation that the three sites which
used to replicate it now call.

## The census in the docblock was wrong, and that is the transferable part

`tenant-key-manager.ts` documents its own limitation clearly:

> This function cannot join a caller's transaction … Callers that need the
> tenant row created atomically alongside other writes (the self-service
> register route …, and `createTenantWithOwner` in `tenant-lifecycle.ts`)
> replicate this function's body … directly against the transaction client.

**Two sites named. There are three.** `org-tenants.ts:65` does
`generateAndWrapDek()` then `tx.tenant.create({ … encryptedDek: wrapped })`, and
its own comment says it "mirrors createTenantWithDek" — but the key manager's
census does not list it.

I sized this work off that docblock, and a plan scoped off it converges two
sites and leaves the third diverged, where it then reads as deliberate rather
than missed. The correction came from the peer session that had looked at this
before; I would not have found it by reading the file that describes it.

The shape generalises: **a comment explaining why something is load-bearing is
evidence the author checked, which makes every case it omits look considered.**
Derive the population, do not read it.

`tests/guards/tenant-creation-is-converged.test.ts` now derives it: no file
outside the two key modules may call `generateAndWrapDek` or `tenant.create`.

## The blocker was never the Prisma client

The docblock says "cannot join a transaction", which reads as a client problem.
It is one line — `prisma.tenant.create` — and `Prisma.TransactionClient` carries
the same signature, with the `DbClient` pattern already in
`org-provisioning.ts:79`.

The real obstacle is **`setCached`**. Priming the DEK cache inside a caller's
transaction leaves a side effect that survives a ROLLBACK: the process then
holds a key for a tenant id that was never committed. Nothing decrypts wrongly —
ids do not recycle — but the cache is an insertion-order LRU bounded at
`MAX_CACHE_SIZE`, so every abandoned registration evicts a LIVE tenant's key and
charges it an unwrap.

So the helper is two-phase: it takes the client and returns
`{ tenant, primeDekCache }`, and the caller primes after commit.
`tenant-lifecycle.ts` had `void _dek; // here we prime nothing` — the author
arriving at the same conclusion and working around it at the call site.

## bcrypt stays outside the transaction, and now something checks

`api/auth/register` hashes the password **before** opening the transaction,
because bcrypt at cost 12 runs for hundreds of milliseconds and `DATABASE_URL`
points at PgBouncer in transaction mode, where holding the transaction open
pins a pooled connection.

Nothing fails if that moves. It just gets slow under exactly the load where
connections are scarce — which is why the comment was not enough and there is
now an ordering assertion, with a second case ensuring both anchors still exist
so the ordering check cannot pass vacuously on two `-1`s.

## Transliteration

The Streamlined System (Закон за транслитерацията, 2009) — the one on passports
and road signs, so `ъ → a` and a word ending `-ия → -ia`.

Unlike the identifier checksums in P3.2, **these vectors are externally
verifiable**: «Търговище» is `Targovishte` on the sign at the edge of the town.
That makes them real vectors rather than derived ones.

Two of my own expectations were wrong, and both are kept as cases:

- **«България» → `Balgaria`.** "Bulgaria" is the English exonym, not a
  transliteration. The next reader will reach for it and conclude the table is
  broken.
- All-caps gives `ZhELYO`, not `ZHELYO` — asserted as actual behaviour, with a
  note that every consumer lowercases anyway.

Mutation-proved six ways. The sixth caught a toothless assertion of mine: my
length test never landed the 80-character slice on a separator, so the
trailing-hyphen re-strip was never exercised. `'abcd '` repeated is five
characters per unit, so an 80-character cut lands exactly on a hyphen.

## A partial barrel mock broke two suites

Adding `createFarmTenant` to `tenant-key-manager` made
`tests/unit/usecases/tenant-lifecycle.test.ts` fail with
`createFarmTenant is not a function` — it mocks the module with only
`createTenantWithDek`, so a new export is `undefined`. Three suites mock that
module; the fix delegates to the caller's client so the existing
`tx.tenant.create` assertion stays meaningful rather than being swallowed.

`org-tenants.test.ts` also broke, differently: it asserted the create's `select`
clause and counted info logs by position. Both were assertions about how the
work was done rather than what it did, and both moved when the work moved into
the helper. They now select by message rather than by index.

## Not in this PR

`FarmBrand` does not exist. Per the standing rule that tables ship one release
before the code that writes them, its migration is its own PR.
