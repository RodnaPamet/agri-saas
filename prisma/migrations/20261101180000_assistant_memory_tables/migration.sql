-- Assistant memory — TABLES ONLY (#2671).
--
-- P5's standing rule: tables ship one release before the code that writes
-- them. Nothing reads or writes these yet.
--
-- The KEY DECISION is the tenant split, and it is visible in the policies
-- below rather than only in prose:
--
--   * AssistantConversation / AssistantTurn are TENANT-SCOPED. A question is
--     answered against whichever farm is open, so a conversation belongs to
--     that farm and exactly one tenant reads its turns. Ordinary
--     `tenant_isolation`, and the per-tenant DEK in `ENCRYPTED_FIELDS`.
--
--   * AssistantMemoryFact has NO tenantId. "Per person, across farms" is the
--     owner's decision, so more than one tenant must read the same row — which
--     is why it is in `GLOBAL_KEK_MODELS` and why its policies key on a USER
--     rather than a tenant.

-- ─── AssistantConversation ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AssistantConversation" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTurnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantConversation_tenantId_userId_lastTurnAt_idx"
    ON "AssistantConversation" ("tenantId", "userId", "lastTurnAt");

ALTER TABLE "AssistantConversation"
    ADD CONSTRAINT "AssistantConversation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantConversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssistantConversation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "AssistantConversation";
DROP POLICY IF EXISTS tenant_isolation_insert ON "AssistantConversation";
DROP POLICY IF EXISTS superuser_bypass        ON "AssistantConversation";

CREATE POLICY tenant_isolation ON "AssistantConversation"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY tenant_isolation_insert ON "AssistantConversation"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY superuser_bypass ON "AssistantConversation"
    USING (current_setting('role') != 'app_user');

-- ─── AssistantTurn ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AssistantTurn" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role"           TEXT NOT NULL,
    -- ENCRYPTED at rest under the TENANT's DEK. Verbatim user text for a
    -- `user` turn, which is why a replayed turn must re-enter the prompt
    -- FENCED as data rather than as instruction.
    "content"        TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantTurn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantTurn_tenantId_conversationId_createdAt_idx"
    ON "AssistantTurn" ("tenantId", "conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantTurn_tenantId_conversationId_idx"
    ON "AssistantTurn" ("tenantId", "conversationId");

ALTER TABLE "AssistantTurn"
    ADD CONSTRAINT "AssistantTurn_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantTurn"
    ADD CONSTRAINT "AssistantTurn_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssistantTurn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssistantTurn" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation        ON "AssistantTurn";
DROP POLICY IF EXISTS tenant_isolation_insert ON "AssistantTurn";
DROP POLICY IF EXISTS superuser_bypass        ON "AssistantTurn";

CREATE POLICY tenant_isolation ON "AssistantTurn"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY tenant_isolation_insert ON "AssistantTurn"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY superuser_bypass ON "AssistantTurn"
    USING (current_setting('role') != 'app_user');

-- ─── AssistantMemoryFact ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AssistantMemoryFact" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    -- Both ENCRYPTED under the GLOBAL KEK (`GLOBAL_KEK_MODELS`), because no
    -- single tenant's key can serve a row read while any of the person's farms
    -- is open.
    "text"           TEXT NOT NULL,
    -- The person's OWN sentence. Rule 3 (learn only from their words) and
    -- rule 7 (keep the evidence server-side).
    "sourceQuote"    TEXT NOT NULL,
    "sourceAt"       TIMESTAMP(3) NOT NULL,
    -- Rule 6: a point the person edited is theirs; the extractor never
    -- rewrites it.
    "editedByPerson" BOOLEAN NOT NULL DEFAULT false,
    -- Rule 5: «Изтрий» sets this and the row SURVIVES, so the extractor can
    -- refuse to re-learn the same point from the same evidence. A hard delete
    -- would let the next conversation undo the deletion.
    "deletedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantMemoryFact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantMemoryFact_userId_deletedAt_sourceAt_idx"
    ON "AssistantMemoryFact" ("userId", "deletedAt", "sourceAt");

ALTER TABLE "AssistantMemoryFact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssistantMemoryFact" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_fact_owner_read_user  ON "AssistantMemoryFact";
DROP POLICY IF EXISTS memory_fact_owner_read_actor ON "AssistantMemoryFact";
DROP POLICY IF EXISTS superuser_bypass             ON "AssistantMemoryFact";

-- TWO SELECT arms, one per session variable, and this is #1664 avoided rather
-- than rediscovered.
--
-- `app.user_id` is set by `runInUserContext` (person-scoped, no tenant) and
-- `app.actor_user_id` by `runInTenantContext` (alongside a tenant). They are
-- different variables set by different runners, and picking the wrong one
-- fails SILENTLY: the unset one yields NULL and the arm matches nothing.
--
-- This row is read from BOTH contexts, which is exactly why one arm is not
-- enough:
--   * the ASSISTANT reads the profile mid-answer, inside a tenant transaction
--     -> `app.actor_user_id`
--   * «Какво помни асистентът» reads it person-scoped under /api/account/**
--     -> `app.user_id`
--
-- #1664 is the cost of getting this wrong: `UserBlock`'s arm keyed on
-- `app.user_id` while enforcement ran under `app.actor_user_id`, so it
-- selected from an empty view and returned false for every pair, always, with
-- nothing erroring. Two arms admit the SAME person in the two contexts, so
-- this widens nothing.
CREATE POLICY memory_fact_owner_read_user ON "AssistantMemoryFact"
    FOR SELECT
    USING ("userId" = current_setting('app.user_id', true)::text);

CREATE POLICY memory_fact_owner_read_actor ON "AssistantMemoryFact"
    FOR SELECT
    USING ("userId" = current_setting('app.actor_user_id', true)::text);

-- SELECT only. There is deliberately no app_user INSERT/UPDATE/DELETE arm:
-- every write goes through the privileged client in a usecase that sets
-- `userId` itself, so a caller cannot forge a fact about somebody else or
-- resurrect one they deleted. That is P5.2a's arrangement for `ContentReport`,
-- for the same reason.
CREATE POLICY superuser_bypass ON "AssistantMemoryFact"
    USING (current_setting('role') != 'app_user');
