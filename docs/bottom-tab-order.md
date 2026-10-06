# Bottom tab order — the web/iOS contract

`User.bottomTabOrder` is shared state. The same account draws a bottom bar in
the web app and in the iOS app, and if the two resolve the stored value
differently the user's own arrangement appears to change when they switch
device. This document is the agreement.

Agreed 2026-10-04 between the agri-saas and Agrent-iOS sessions, both reading
their own source rather than recalling it (`src/lib/nav/resolve-bottom-tabs.ts`
and `Agrent/Tabs/BottomTabsStore.swift`). The one row where the clients differ
was ruled on by the owner.

## Storage and transport (already settled elsewhere)

| | |
|---|---|
| Column | `User.bottomTabOrder`, `Json?` |
| Vocabulary | **tenant-relative href suffixes** — `/journal`, `/farm-tasks`, `/grain/costs`. Path strings, not bare names. iOS uses the same (`case dashboard = "/dashboard"`). |
| Read | `GET /api/auth/me` → `bottomTabOrder` |
| Write | `PUT /api/account/bottom-tabs`, `{ "order": [...] \| null \| [] }` |
| Validation | SHAPE only — never against a list of known tabs. See `src/lib/account/bottom-tabs.ts` for why. |

A server-side allowlist is deliberately absent: it would make every new client
tab wait on a server deploy, and the web and native release cycles are not
coupled. An id the other client does not know must degrade to "not shown"
rather than rejecting the whole arrangement.

## Rendering — what both clients do

1. **Resolve** each stored id against the surfaces this member can actually
   reach right now.
2. **Then clamp** to the first 5.
3. Show fewer than 5 rather than padding.

Resolve *before* clamping. The order only matters when an unreachable id sits
inside the first five — and then clamping first spends a slot on a tab that
drops out, so a user with six choices and one gated-out sees four tabs while
their sixth choice sits unused.

```
stored:   [journal, admin, exchange, locations, farm-tasks, dashboard]
          (admin is gated off for this member)

resolve:  [journal, exchange, locations, farm-tasks, dashboard]
clamp 5:  [journal, exchange, locations, farm-tasks, dashboard]   ✓ 5 chosen tabs

wrong way round:
clamp 5:  [journal, admin, exchange, locations, farm-tasks]
resolve:  [journal, exchange, locations, farm-tasks]              ✗ 4, and dashboard never got the slot
```

The resolved list is a **preference, not a grant**. It is re-resolved on every
render against the live permission- and module-gated nav, so a stored id can
reorder and hide but never widen access, and a role change takes effect
immediately rather than at the next write.

## The table

| stored value | web | iOS |
|---|---|---|
| `null` — never chosen | defaults | defaults |
| `[]` — deliberately cleared | **no bar** | **defaults** |
| non-empty, some ids unreachable | drop them | drop them |
| non-empty, **nothing** resolves | defaults | defaults |
| more than 5 resolve | first 5 | first 5 |
| fewer than 5 resolve | show fewer | show fewer |

## The one platform difference, and why it is not a bug

`[]` is the only row where the clients differ, deliberately.

On iOS the tab bar **is** the navigation, so zero tabs is a blank screen with
only a menu; `BottomTabsStore` falls back to defaults. The web has a sidebar and
a drawer, so an empty bottom bar costs the user nothing and honours what they
asked for.

In practice the divergence is narrow: the iOS tab customiser cannot save `[]`
(Save is disabled while the chosen list is empty), so iOS only ever *meets* this
value, never writes one. Today it can only arrive from a direct API call. It
matters for when the web grows a tab editor.

## `[]` and "nothing resolved" are not the same case

Both end with an empty list, and treating them alike is the obvious
simplification. They mean opposite things:

- `[]` is a **statement** — the user cleared the bar.
- "everything I picked is gated off" is an **accident** of a role or module
  change, which the user never asked for.

Collapsing them would silently delete the bottom bar from someone whose
permissions changed, with nothing on screen to explain it and no way to get it
back from the bar itself. So intent is honoured and accident falls back to
defaults — on both clients.

## Where this lives

| | |
|---|---|
| Contract + default order | `src/lib/nav/resolve-bottom-tabs.ts` |
| Contract tests | `tests/unit/resolve-bottom-tabs.test.ts` (each case names what iOS does) |
| Web consumer | `src/components/layout/BottomTabBar.tsx` |
| Storage + HTTP semantics | `src/lib/account/bottom-tabs.ts`, `src/lib/openapi/paths/account.paths.ts` |
| iOS | `Agrent/Tabs/BottomTabsStore.swift`, `Agrent/Tabs/AppSurface.swift` |

Changing any row of the table is a cross-client change: update this document,
the resolver, its tests, and tell the iOS session in the same breath.
