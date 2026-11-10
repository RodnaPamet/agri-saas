# 2026-11-10 — a channel thread can be read, and «Въпрос»/«Решено» work

**Issue:** #2961. Found while planning P9.5 (#2939) against the shipped API.

## Three writes with no reader

| what was written | since | what could read it |
|---|---|---|
| a reply (`parentPostId` set) | P9.3b | **nothing** — the feed filters `parentPostId: null` |
| `resolvedAt` on a «Въпрос» | P9.3b | **nothing** — `ChannelPostView` had no such field |
| a `QUESTION` post | — | nothing could CREATE one: `postToChannel` took no `kind` |

The first is the worst: a member posts a reply and it is visible to nobody,
including themselves. The only escape was `alsoToChannel: true`, which writes a
second top-level row — so the feature appeared to work for whoever happened to
tick the box.

## Why every suite was green

`p9-3b-threads-mentions` has a case named *"a reply carries parentPostId and
stays OUT of the top-level feed"*, asserting `expect(ids).not.toContain(...)`.
That is true, and the test is right about the property it names. Nothing
asserted a reply was READABLE, because nothing existed that could read one —
the absence sat in the test's own stated purpose.

The resolved case asserted `setQuestionResolved` returned and the column
carried a timestamp. Also true, and also not a statement about any reader. And
it had to set `kind: 'QUESTION'` with a raw `prisma.channelPost.update`,
because the API could not make a question — **a test reaching past the API to
set up its subject is the tell that the API has no way in.**

## Design

- **One mapper, `toPostView`, shared by both read paths.** The collapse of
  three removal columns into `deleted` plus an EMPTY body is a disclosure rule,
  not formatting: P9.3d's auto-hide sets `autoHiddenAt` on any post including a
  reply, so a thread read with its own mapping would serve text the moderation
  path had taken down. #1664's class — two spellings of one rule, where the
  divergence is a disclosure.
- **Oldest-first, and `after` rather than `before`.** A feed is newest-first
  because the reader wants what is new; a thread is a conversation and the
  answers only make sense in the order given. The parameter is named
  differently from the feed's so a cursor cannot be pasted between them.
- **A non-member reads a thread, exactly as they read the feed.**
  `channel_post_select` admits any authenticated caller, so the database
  already allows it and a narrower API rule would be a second, disagreeing
  answer to one question.
- **A hidden PARENT still serves its thread.** The feed shows a hidden post as
  `deleted` rather than omitting it, precisely so replies do not dangle, and
  withholding the thread would let the moderation of one post silently remove
  other people's words.
- **Asking for a reply's own thread is a 400, not an empty page.** Threads are
  one level deep, so a reply HAS no thread; an empty page would say "no
  replies", which is a different fact from "that id is not a thread", and only
  the second is fixable by the caller. It needed its own code:
  `CHANNEL_THREAD_TOO_DEEP` exists for the write side of the same invariant but
  its copy is imperative about REPLYING («Отговорете на първоначалната
  публикация»), which is nonsense shown to someone reading.
- **`replyCount` counts HIDDEN replies.** A count that shrank when a moderator
  hid one reply would tell every reader that something had been removed — the
  disclosure the `deleted` collapse exists to prevent, arriving by arithmetic.
- **`kind` accepts `POST` and `QUESTION` only.** `CARD` is machine-written by
  P9.4's queue, so accepting it from a caller is a forgery surface. The control
  is the narrow union; `z.nativeEnum(ChannelPostKind)` reads as the obvious
  choice, tracks the schema automatically, and admits it.
- **No migration and no new index.** A pure read addition. The query filters
  `parentPostId` and sorts within it, which `@@index([parentPostId])` serves; a
  thread is one level deep so the sorted set is small. A composite
  `[parentPostId, createdAt]` would make the existing index a redundant prefix
  and cost a write on every post for a gain nothing measures.

## Mutation proofs

Eight, each killing exactly the intended assertion:

| mutation | assertion that went red |
|---|---|
| serve a hidden reply's text | an AUTO-HIDDEN reply comes back EMPTY |
| thread newest-first | reads OLDEST first (+ the paging case) |
| cursor pages backwards (`gt`→`lt`) | pages FORWARD with `after` |
| drop the `limit + 1` probe | pages FORWARD with `after` |
| allow a reply's own thread | refuses a reply's own thread |
| `replyCount` always 0 | both replyCount cases |
| `resolvedAt` always null | «Решено» is OBSERVABLE |
| `kind` admits `CARD` | REFUSES CARD, which is machine-written |

The `CARD` test carries a control asserting `CARD` is still a member of the
Prisma enum — without it the refusal would also pass if the member had been
renamed or removed, and the file would be asserting nothing about a forgery
surface.
