# 2026-11-13 — «Вдъхновение», the library page

**Commit:** (this branch) `feat/2980-library-page`

## Design

#2980 PR 3. The server contract shipped in #3019 and the books went into
production on 2026-11-13 — Sun Tzu (13 chapters) and Franklin (6), both
published, `library.enabled` on with no cohort. **There was no page.** Two
books live, reachable only by typing an API URL, which is #2844's shape with
content already waiting behind it.

```
/library                       server shell → LibraryDirectoryClient
                                                  │ useSWR('/api/library/books')
/library/{slug}                server shell → BookReaderClient
                                                  │ useSWR('/api/library/books/{slug}')
sidebar «Пазар» → «Вдъхновение»  raw href '/library', visible: libraryEnabled
```

Four gates on each page, in order: `auth()` → `/login`,
`redirectIfSuspended`, `isFeatureEnabled('library.enabled')` → `notFound()`.

## Files

| File | Role |
|---|---|
| `src/app/library/page.tsx` | directory shell; the four gates |
| `src/app/library/LibraryDirectoryClient.tsx` | the list, fetched client-side |
| `src/app/library/[slug]/page.tsx` | reader shell; the same four gates |
| `src/app/library/[slug]/BookReaderClient.tsx` | chapters and paragraphs |
| `src/lib/auth/guard.ts` | `/library` **and `/api/library`** join `isPersonPath` |
| `src/lib/swr/persistent-cache.ts` | `/api/library/books` joins `PERSISTABLE_PATHS` |
| `src/lib/tenant-context-provider.tsx` | `libraryEnabled` on the context |
| `src/app/t/[tenantSlug]/layout.tsx` | resolves the flag server-side |
| `src/components/layout/SidebarNav.tsx` | the nav item — the only raw href here |
| `docs/nav-vocabulary.md` | the «Вдъхновение» row |
| `messages/{bg,en}/app.json` | 9 keys each, inserted as TEXT |
| `tests/guards/persisted-reads-answer-with-an-etag.test.ts` | its mapper learns non-tenant entries |
| `tests/guards/swr-persist-allowlist.test.ts` | cap 8 → 9, with the decision |

## Decisions

**The page is a SHELL over the API, not a usecase call.** Server-rendering the
directory would be shorter and would break the feature: the persistent SWR
cache populates from CLIENT fetches, so a server read puts nothing on the
phone and a farmer with no signal gets an empty page. The same argument makes
the reader a client fetch — the copy worth having offline is the chapters.

**`PERSISTABLE_PATHS` carries the FULL path.** `tenantRelativePath` strips only
`/api/t/<slug>/` and returns a non-tenant key unchanged, so `/library/books`
would match nothing and persist nothing, silently. The prefix matcher then
makes that one entry cover each book text as well as the directory, which is
the decision rather than a side effect: public-domain text, identical for every
reader, no personal data. Cap raised 8 → 9 in the same diff, because that cap
exists to force exactly this paragraph.

**`/api/library/books` was already ungated at the Edge, and this fixes it.** It
merged in #3019 in NEITHER path population — not a tenant path, not a person
path — so it took no Edge MFA gate, which is verbatim what `isPersonPath`'s own
docblock records for `/api/account/**` before #1192. Both halves are added now.
Deliberately NOT added to `isOperatorBlockedPersonPath`: the owner chose a
non-tenant path precisely so a MECHANISATOR reaches the library, and the
lockdown sits inside `if (isTenantPath(pathname))`, so the path shape is what
carries it.

**The nav item uses a raw href, and that is load-bearing.** Every sibling goes
through `tenantHref`. Wrapping this one would not merely 404 — `/t/{slug}/library`
would be evaluated against `isOperatorAllowedPath`, which does not name it, so
it would close the surface to the persona the path was chosen for.

**One row in `nav-vocabulary.md`, not two.** «Канали» needs a `channelNav` row
because the nav label is BG-plural against EN-singular. «Вдъхновение» has no
plural, so `library.title` and `sidebarNav.library` hold the same value and one
row pins both. The `Never` column bans «Библиотека» scoped to the `library.`
namespace — `sharepointPicker.library` is SharePoint's own term for a document
library and is correctly out of range.

## Four things caught in review of my own work

- **`lang="zh-Hant"` on `originalTitle`.** Right for Sun Tzu, wrong for
  Franklin, and the payload has no original-language field — `locale` is the
  language of the TRANSLATION. A wrong `lang` makes a screen reader pronounce
  English with Chinese phonetics, so it ships with none. **#3036.**
- **A docblock describing a chapter count the directory cannot render**, because
  `BookSummary` has none. Writing it would need a second SELECT shape, which is
  the split `usecases/library.ts` spells once to avoid.
- **A view interface listing four fields nothing renders**, which would tell the
  next reader all seven were load-bearing.
- **An apostrophe in a comment.** `swr-persist-allowlist` parses
  `PERSISTABLE_PATHS` as TEXT, and `book's TEXT` opened what its extractor read
  as a string literal: two garbage entries and a count of 10. The comment now
  says why it has no apostrophes.

## Two guards that fired, and one was a false ALARM

`page-routes-generated-in-sync` wanted the assistant route inventory
regenerated — 108 → 110 templates — and it runs the generator rather than a
copy, so a stale commit cannot pass.

`persisted-reads-answer-with-an-etag` reported **`/api/library/books: false`**,
"has no route handler", for a route that exists and does answer with an ETag.
Its `routeFileFor` resolved every entry under `src/app/api/t/[tenantSlug]/`,
because until now every entry was tenant-relative. That is a false alarm, not a
false pass, so the mapper learned both shapes rather than the entry taking an
exemption — the next non-tenant entry would hit it too. Mutation-proved: a
bogus `/api/nope/books` still reports `false`.

## Filed, not built

- **#3036** — `BookChapter` has no original-language field.
- **#3037** — `pages-are-reachable` derives from the tenant subtree only, so a
  non-tenant page can ship linked from nothing. This page IS linked; nothing
  would have failed if it were not.
