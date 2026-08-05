-- Auto-evidence titles were persisted as `Farm record — {entry title}`.
--
-- The prefix was written server-side, in English, into the database. That put
-- it somewhere next-intl can never reach: a Bulgarian operator's evidence list
-- showed an English marker on every auto-collected row, and no render-time
-- translation could fix it. The marker is now derived from `category` and
-- rendered in the reader's locale, so the stored prefix is both untranslatable
-- and redundant.
--
-- Scope is deliberately narrow: only rows this job wrote (category =
-- 'AUTO_FARM_RECORD' AND sourceLogEntryId IS NOT NULL) and only where the
-- exact machine-written prefix is present. A title a person happened to start
-- with those words is not touched, because a hand-filed row has no
-- sourceLogEntryId.
--
-- The em dash is U+2014, matching the template literal that produced it.

UPDATE "Evidence"
SET "title" = substring("title" FROM char_length('Farm record — ') + 1)
WHERE "category" = 'AUTO_FARM_RECORD'
  AND "sourceLogEntryId" IS NOT NULL
  AND "title" LIKE 'Farm record — %';
