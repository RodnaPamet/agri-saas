# 2026-09-22 — nested PII relations returned ciphertext to callers

**Commit:** `fix(pii): decrypt every nested relation that can carry personal data`

## What happened

The native client rendered this on screen, under "Създадена от", on a live
tenant:

```
v1:FTDt/A1v/6KngIxn762VOuI9kQdrKrz69Se6XnFAUBVSb0L/Nm8r
```

54 characters of base64 where a colleague's name belongs. The same tenant's
task LIST returned `assignee.name` in plaintext, so two routes disagreed about
the same column on the same model.

## Cause

`decryptNested` in `pii-middleware.ts` walks a result tree and decrypts a
nested object only when its key appears in `RELATION_KEY_TO_MODEL`. Generic
walking is deliberately not done — inspecting every relation on every read is a
real perf cost. So the table is an allowlist, and an allowlist of relation keys
has one failure mode that points the wrong way: **a key nobody added returns
ciphertext**, silently, because a missing entry is indistinguishable from a
relation carrying no PII.

`assignee` was in it. `createdBy` was not.

## The measured gap

Derived from the schema rather than from the two names in the report:

| | count | |
|---|---|---|
| relation fields pointing at `User` | 16 | |
| of those, mapped | 4 | `assignee`, `invitedBy`, `owner`, `user` |
| **unmapped** | **12** | `actor closedBy completedBy createdBy decidedBy deletedBy executedBy ownerUser reviewer subjectUser target uploadedBy` |
| mapped but absent from the schema | 3 | `inviter`, `invitedByUser`, `creator` |
| mapped with the wrong spelling | 1 | `identityLink` — the field is `identityLinks`, a list |

Two managed models had no key at all: `NotificationOutbox` and `Account`, both
reachable as back-references off `User`.

So `identityLink` had never matched anything from the day it was written, and
three more entries matched nothing either. **A map that looks populated is why
nobody asked whether it was complete.**

## Files

| file | role |
|---|---|
| `src/lib/security/pii-middleware.ts` | the corrected table; `PII_MANAGED_MODELS` exported for the guard |
| `tests/guards/pii-relation-key-coverage.test.ts` | derives the required keys from the Prisma schema, fails in BOTH directions |
| `tests/integration/pii-encryption.test.ts` | the executing half — a real `Task` read through `createdBy` |

## Decisions

- **Derived, not patched.** Adding `createdBy` and `reviewer` would have fixed
  the two reported symptoms and left ten. The population question — *which
  relation keys can carry PII* — has an exact answer in the schema, and a guard
  that asks the schema cannot drift the way a docblock instruction did.

- **Both directions, because the dead entries are what hid the live ones.**
  Requiring every schema key to be mapped catches the leak. Requiring every
  mapped key to exist catches the rot that made the table look maintained.

- **A structural guard was not enough.** It proves a row exists and never runs
  `decryptNested` — this repo has a standing rule about exactly that. The
  integration test creates a real `Task`, reads it through `createdBy`, and
  asserts the decrypted value. It also asserts the stored column IS encrypted
  first, because otherwise the test would pass with the middleware removed
  entirely. Mutation-proved: deleting `createdBy` reproduces the production
  string, `v1:L+QNb4fl/…`, in the failure output.

- **The key remains the only thing resolvable at runtime.** `decryptNested`
  sees an object key, not Prisma type information, so a key pointing at two
  different managed models would be unresolvable either way it was mapped. The
  guard refuses one rather than picking. None exists today.
