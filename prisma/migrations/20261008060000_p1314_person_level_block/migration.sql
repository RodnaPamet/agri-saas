-- #1314 — an exchange block refuses a PERSON, not a farm (owner ruling).
--
-- Threads became per-person in #1323 (`ExchangeThread.inquirerUserId`), so the
-- block was the last part of this surface still reasoning in tenants: blocking
-- one buyer silenced their whole farm, including colleagues who had never
-- written to the seller.
--
-- A straight RENAME, not a drop-and-add. Production holds ZERO ExchangeBlock
-- rows (measured on the VM before writing this), so there is no data to
-- convert — which is the only reason this is simple. A farm-level block cannot
-- be mechanically converted to a person-level one anyway: there is no answer to
-- "which of that farm's people did you mean".
ALTER TABLE "ExchangeBlock" RENAME COLUMN "blockedTenantId" TO "blockedUserId";

ALTER INDEX IF EXISTS "ExchangeBlock_sellerTenantId_blockedTenantId_key"
    RENAME TO "ExchangeBlock_sellerTenantId_blockedUserId_key";
ALTER INDEX IF EXISTS "ExchangeBlock_blockedTenantId_idx"
    RENAME TO "ExchangeBlock_blockedUserId_idx";

-- The SELECT policy has to follow, and this is the subtle half.
--
-- The block is ENFORCED while running as the BLOCKED party — their own open or
-- send is what must be refused — so a row they cannot SEE cannot refuse them.
-- That is why SELECT is the wide arm. With a person-level block the reader to
-- admit is a PERSON, which `app.tenant_id` cannot express: two members of one
-- farm are indistinguishable to it.
--
-- `app.actor_user_id` is the variable for that, set by `runInTenantContext`
-- (#1298). Every one of this table's four read/write sites runs through that
-- helper — measured — and `notifyOtherParty`, the one path using
-- `withTenantDb` (which deliberately sets no actor), reads ZERO blocks. That
-- matters because an unset variable yields NULL and the arm matches nothing:
-- fail-closed, but SILENTLY, which for a BLOCK means it stops refusing rather
-- than erroring.
--
-- The INSERT/UPDATE/DELETE policies are unchanged and stay seller-only: a
-- single USING clause would govern DELETE as well as SELECT, letting a blocked
-- party delete the row and unblock themselves. The split is the point.
DROP POLICY IF EXISTS exchange_block_select ON "ExchangeBlock";
CREATE POLICY exchange_block_select ON "ExchangeBlock"
    FOR SELECT
    USING (
        "sellerTenantId" = current_setting('app.tenant_id', true)::text
        OR "blockedUserId" = current_setting('app.actor_user_id', true)::text
    );
