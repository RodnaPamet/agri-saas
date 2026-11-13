-- ═══════════════════════════════════════════════════════════════════
--  LIBRARY — «Вдъхновение» (#2980). Book + BookChapter.
--  SCHEMA ONLY: no route, usecase, seed, UI or flag.
-- ═══════════════════════════════════════════════════════════════════
--
--  ── THE SELECT ARM ADMITS BOTH SESSION VARIABLES ──
--
--  `runInUserContext` sets `app.user_id`. `runInTenantContext` sets
--  `app.actor_user_id` and NOT the other. Picking the wrong one fails
--  SILENTLY — the arm matches nothing, the read returns zero rows, and
--  nothing errors. That is #1664, and it cost a whole feature.
--
--  Every other tenantless table here picks ONE, because its rows BELONG to
--  somebody and the policy has to name them. A book belongs to nobody: the
--  only question is whether the caller is authenticated, and both runners
--  answer it. So the arm admits either, and the trap is gone rather than
--  written down.
--
--  It widens nothing: the same population is admitted under both contexts,
--  which is exactly what `user_block_select_actor` did for #1664.
--  `tests/integration/library-books-rls.test.ts` asserts BOTH directions and
--  asserts an UNAUTHENTICATED context (neither variable set) sees zero — the
--  control without which "admits both" is indistinguishable from "admits
--  everyone".
--
--  ── `publishedAt` IS A DISCLOSURE BOUNDARY, in the POLICY as well ──
--
--  The owner's constraint is that publishing waits for their review of the
--  text, so production WILL hold unpublished rows for a while — that window
--  is the whole purpose of the column. #2980 §3(d) names the failure mode:
--  the flag "works in the seed and leaks through a read nobody filtered".
--
--  A `where` clause is one line somebody deletes while refactoring a list
--  query. This arm is the layer that survives that, and the read filters
--  too — the same two-layer arrangement as P5.5b's shadow score, where the
--  guard is the source half and the migration is the database half.
--
--  `BookChapter` asks the SAME question of its parent. Without it the book
--  row is hidden and its text is not, which is the whole of the leak. The
--  subquery reads `Book`, a DIFFERENT table from the one being guarded, so
--  the recursion rule (P8.1) is satisfied.
--
--  ── NO `app_user` WRITE ARM ──
--
--  `Channel`'s reasoning: these rows are seeded and administered, and a
--  caller able to insert one could publish a text under the platform's own
--  name. Writing is privileged; the read is policy-governed. `ContentReport`'s
--  arrangement one axis over (P5.2a).

-- ─────────────────────────────────────────────── enum

CREATE TYPE "BookUseCase" AS ENUM ('STRATEGY');

-- ─────────────────────────────────────────────── tables

CREATE TABLE "Book" (
    "id"          TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "author"      TEXT NOT NULL,
    "locale"      TEXT NOT NULL,
    "summary"     TEXT,
    "sourceNote"  TEXT NOT NULL,
    "licenseNote" TEXT NOT NULL,
    "version"     INTEGER NOT NULL DEFAULT 1,
    "useCases"    "BookUseCase"[] NOT NULL DEFAULT ARRAY[]::"BookUseCase"[],
    "publishedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Book_slug_key" ON "Book"("slug");
CREATE INDEX "Book_publishedAt_idx" ON "Book"("publishedAt");

CREATE TABLE "BookChapter" (
    "id"            TEXT NOT NULL,
    "bookId"        TEXT NOT NULL,
    "number"        INTEGER NOT NULL,
    "title"         TEXT NOT NULL,
    "originalTitle" TEXT,
    "paragraphs"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "BookChapter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookChapter_bookId_number_key" ON "BookChapter"("bookId", "number");

-- A chapter with no paragraphs is a chapter whose text failed to parse, and it
-- would render as a heading over nothing. The seed reads the text from a file
-- the owner supplies, so this is the one place that can refuse a bad parse.
--
-- `cardinality(...) > 0` and NOT `array_length("paragraphs", 1) >= 1`:
-- `array_length` returns NULL for an EMPTY array, and a CHECK whose expression
-- is NULL PASSES. The wrong spelling would be a constraint that admits exactly
-- the row it exists to refuse.
ALTER TABLE "BookChapter"
    ADD CONSTRAINT "BookChapter_paragraphs_nonempty"
    CHECK (cardinality("paragraphs") > 0);

ALTER TABLE "BookChapter" ADD CONSTRAINT "BookChapter_bookId_fkey"
    FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────── RLS

ALTER TABLE "Book"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Book"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "BookChapter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookChapter" FORCE  ROW LEVEL SECURITY;

-- A PUBLISHED book is readable by any authenticated caller, in EITHER session
-- context. An unpublished one is readable by nobody holding `app_user`.
CREATE POLICY book_select ON "Book"
    FOR SELECT
    USING (
        "publishedAt" IS NOT NULL
        AND (
            COALESCE(current_setting('app.user_id', true), '') <> ''
            OR COALESCE(current_setting('app.actor_user_id', true), '') <> ''
        )
    );

CREATE POLICY superuser_bypass ON "Book"
    USING (current_setting('role') != 'app_user');

-- The chapter asks the same question of its PARENT. Hiding the book row while
-- serving its text is the leak, not a partial fix of it.
CREATE POLICY book_chapter_select ON "BookChapter"
    FOR SELECT
    USING (
        (
            COALESCE(current_setting('app.user_id', true), '') <> ''
            OR COALESCE(current_setting('app.actor_user_id', true), '') <> ''
        )
        AND EXISTS (
            SELECT 1 FROM "Book" b
            WHERE b."id" = "BookChapter"."bookId"
              AND b."publishedAt" IS NOT NULL
        )
    );

CREATE POLICY superuser_bypass ON "BookChapter"
    USING (current_setting('role') != 'app_user');
