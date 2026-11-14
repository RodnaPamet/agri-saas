-- P9.4 (#2938) — card identity, so a retry cannot double-post.
--
-- The phase asks for cards on their own queue and for identity unique per
-- (channel, kind, day). `ChannelPostKind` already has CARD, so a card IS a
-- post (P9.1 decided that, and P9.3 completed it by refusing CARD on the post
-- request so a member cannot forge platform data) — what it lacks is a way to
-- say WHICH card and FOR WHEN.
--
-- `cardDay` is a real DATE column rather than a derivation from `createdAt`,
-- because Prisma cannot declare a unique index on an expression and the
-- uniqueness is the whole point: with it, the retry question dissolves and
-- there is no `generated` flag for anything to forget to set (the P5.5b
-- pattern, `NoticeScore.reportId`).

CREATE TYPE "ChannelCardKind" AS ENUM ('NEWS', 'LISTING', 'SCHEME', 'EVENT');

ALTER TABLE "ChannelPost" ADD COLUMN "cardKind" "ChannelCardKind";
ALTER TABLE "ChannelPost" ADD COLUMN "cardDay"  DATE;

-- The card's DATA, locale-independent. A card cannot put its text in `body`
-- alone and be correct: one channel is read in both languages, so a composed
-- sentence would pick a language at generation time for every future reader —
-- and P9.4 asks for bg + en copy per card kind, which a text column cannot
-- hold. The facts live here, the framing copy in the catalogue by `cardKind`,
-- and the reader composes.
ALTER TABLE "ChannelPost" ADD COLUMN "cardPayloadJson" JSONB;

-- ONE card per channel per kind per day.
--
-- Postgres treats NULLs as DISTINCT in a unique index (the default,
-- `NULLS DISTINCT`), so every POST and QUESTION row carries NULL in both
-- columns and is unconstrained by this — no partial index and no exemption
-- needed. That is also why the index is safe to add to a populated table: a
-- tree of existing rows all carrying NULL cannot collide.
CREATE UNIQUE INDEX "ChannelPost_channelId_cardKind_cardDay_key"
    ON "ChannelPost"("channelId", "cardKind", "cardDay");
