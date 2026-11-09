-- ═══════════════════════════════════════════════════════════════════
--  P9.3b (#2937) — let a post's AUTHOR write its mentions.
-- ═══════════════════════════════════════════════════════════════════
--
--  P9.1 gave `ChannelPostMention` a SELECT arm and nothing else, on the
--  grounds that "a mention is a PUSH TRIGGER, so a caller able to insert one
--  directly could push to any person on the platform without posting anything
--  they would read". That was the right default while no writer existed.
--
--  ── WHY AN ARM IS NEEDED AT ALL, rather than a privileged write ──
--
--  A post and its mentions must be ATOMIC, and P9.3a deliberately inserts a
--  post in USER context so that `channel_post_insert`'s WITH CHECK is what
--  enforces the three access rules (no forged author, no non-member, no banned
--  member) rather than a usecase, which is the layer a refactor removes.
--
--  You cannot mix session contexts inside one transaction. So the options were:
--  make the post privileged too (throwing away that guarantee), write mentions
--  in a second transaction (non-atomic, and a second pool connection taken
--  while the first is held — #1191's P0.8 deadlock), or narrow an INSERT arm
--  until it is safe. This is the third.
--
--  ── WHY IT ANSWERS P9.1's OBJECTION RATHER THAN OVERRIDING IT ──
--
--  A caller may insert a mention ONLY on a post they authored. Authoring
--  requires `channel_post_insert` to admit them, which requires an unbanned
--  membership. So the push vector is bounded by membership AND authorship,
--  instead of being open to anyone who can name a `postId`.
--
--  It queries `ChannelPost` — a DIFFERENT table from the one being guarded —
--  so P8.1's recursion rule is satisfied. A WITH CHECK on this table that read
--  this table would fail with `infinite recursion detected in policy for
--  relation` and refuse every insert.
--
--  ── WHAT IT DOES NOT BOUND: HOW MANY ──
--
--  P9.3's cap of five is a USECASE check, because counting the rows already
--  inserted for a post is a query against the table being guarded. So SQL
--  bounds WHO and the usecase bounds HOW MANY — the same split as the access
--  rules versus slow mode in P9.3a.
--
--  ADDITIVE: no `DROP`, no `RENAME`, so `destructive-migration-has-inverse`
--  does not require an inverse and the previous image simply never inserts a
--  mention. An image-only rollback degrades to "mentions stop being written",
--  not to an error.

CREATE POLICY channel_post_mention_insert ON "ChannelPostMention"
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "ChannelPost" p
            WHERE p."id" = "ChannelPostMention"."postId"
              AND p."authorUserId" = current_setting('app.user_id', true)::text
        )
    );

-- The author's own retraction of a mention, for an edit that removes an @name.
-- Same bound: only on a post they authored.
CREATE POLICY channel_post_mention_delete ON "ChannelPostMention"
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM "ChannelPost" p
            WHERE p."id" = "ChannelPostMention"."postId"
              AND p."authorUserId" = current_setting('app.user_id', true)::text
        )
    );
