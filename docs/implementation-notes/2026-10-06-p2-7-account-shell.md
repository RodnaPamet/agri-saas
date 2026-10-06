# P2.7 — the account area, and the users who could not reach it

*2026-10-06 · roadmap #1193*

## What was actually wrong

The phase item reads "Профил sheet, plus a personal-settings shell at root
`/account` that works with zero farms", which sounds like new construction. Most
of it already existed: `/account/profile` and `/account/security` were both
built, and `/account` was already opened in the Edge auth guard, so the area was
tenant-independent at the routing layer.

What did not exist was any way in. Measured:

| | |
|---|---|
| user menu | linked `/account/security` **only** |
| `/account/profile` | reachable by typing the URL and **no other way** |
| bare `/account` | no `page.tsx` — **404** |
| `/no-tenant` | sign-out and nothing else |

So the avatar upload, the name editor and the feedback preferences were live
code with no entry point, and the users the phase explicitly names — those with
zero farms — landed on a page whose only control signed them out.

None of that is visible in any single file. Each page was individually correct;
the defect was in the EDGES between them, which is why it survived.

## The shell

`src/app/account/layout.tsx`, deliberately not `AppShell`. `AppShell`'s sidebar,
bottom bar and switcher all resolve against `useNavSections()`, which reads
tenant context — and a user with no farms has none. So the account area gets its
own smaller shell, and nothing in the subtree touches tenant context.

The back link goes to `/tenants` rather than a farm URL, because it is the one
destination correct for every reader: it routes 0 memberships to `/no-tenant`,
1 straight into that farm, and more to the picker. A link to a tenant dashboard
would 404 for exactly the users this shell exists to serve.

Both pages shed their full-screen centred wrappers and background effects, and
their `<h1>`s stepped down to `<h2>` — the shell owns the area heading now.

## The guard is about edges, not files

`tests/guards/account-sections-are-reachable.test.ts` derives the sections from
disk rather than listing them, so a third section that nobody links fails the
day it is added — which is this bug, one iteration later.

Two things it took a mutation to get right.

**The circularity.** The first version asked "is each section linked from
somewhere outside its own directory". The shell's nav satisfies that for every
section, so the area linking itself passed. Removing the user-menu link left it
green — correctly, as it happens, since `/no-tenant` still reached the page, but
nothing yet asserted that ANY outside link existed. There is now a separate case
for an entry point from outside the account subtree, and removing *both*
external links reddens it.

**Prose.** The tenant-context check matched the layout's own docblock, which
EXPLAINS why it cannot reuse `useNavSections()`, and reported the explanation as
the violation. It strips comments now, with a control proving the strip fires —
otherwise "no offenders" could mean "the regex never ran".

## Three things the gate caught that I had wrong

Worth recording because two are repeats.

1. **I corrupted the lockfile again.** Syncing `node_modules` to pick up
   stripe@23 ran `npm install` under npm 10.9.8, which strips every `libc`
   entry — 26 → 0. That is the exact defect I had fixed in #1321 earlier the
   same day, and the repo's own guard documents the cause. P2.7 changes no
   dependencies, so the fix was to restore the lockfile from main outright. The
   lesson is narrower than "be careful": **on this toolchain, any `npm install`
   corrupts the lockfile**, so a branch that does not intend to change
   dependencies should end with a lockfile byte-identical to its base, and that
   is worth checking rather than assuming.

2. **A hand-rolled collector, again.** The new guard walked `src/` itself.
   Migrated to `collectTrackedFiles`, with the floor asserted at the CALL SITE
   as well as inside the helper — gutting the wrapper skips the helper's
   refuse-empty entirely, which is how the same mistake slipped through earlier
   today.

3. **A new `eslint-disable` costs the same as a new warning.** The lint ceiling
   counts suppressions, and the `any` in a test's `next/link` mock pushed it +1.
   Typed properly instead of suppressed.

## Noted, not fixed here

`tests/unit/theme-cookie.test.ts:135` carries an eslint-disable that lint now
reports as unused. Mine, from P2.4, already on main — a one-line cleanup, but it
belongs in its own change rather than riding along in this one.
