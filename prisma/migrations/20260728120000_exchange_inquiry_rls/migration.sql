-- ExchangeInquiry: row-level security on the marketplace's private messages.
--
-- `ExchangeInquiry` holds private buyer↔seller messages and is keyed on
-- `inquirerTenantId` — a PLAIN foreign key, deliberately not a `tenantId` RLS
-- column, so the Exchange tables stay global and cross-tenant readable. The
-- consequence was that it never entered the rls-coverage inventory (which keys
-- off `tenantId`): `grep -c "Exchange" tests/guardrails/rls-coverage.test.ts`
-- returned 0. Meanwhile migration 20260323180000 grants `app_user` full DML on
-- ALL tables. One forgotten `where` in a future repository method would read
-- every tenant's inquiries with no DB-side backstop.
--
-- Cross-tenant write safety on the Exchange is currently enforced ONLY at the
-- usecase layer (`ctx.tenantId === listing.sellerTenantId`). That layer is
-- correct today; this migration means it no longer has to be correct forever.
--
-- Its structural twin, `PromotionLead`, got exactly this treatment in
-- 20260721090000_promotion_lead_consent_rls. Same shape, one difference: a
-- PromotionLead belongs to ONE tenant, so its policy is a single equality. An
-- inquiry legitimately has TWO parties — the inquirer who wrote it and the
-- seller whose listing it targets — so the predicate is a disjunction, with
-- the seller side resolved through the listing.
--
-- ── Why ONE policy rather than per-command policies ──────────────────────
-- Same reasoning as Epic D.1's UserSession policy. Multiple policies for the
-- SAME command are OR'd by PostgreSQL, so a split pair is a permissive sibling
-- and the looser half wins. One policy carrying the full predicate has no such
-- seam. `inquirerTenantId` is NOT NULL, so there is no nullable-row case
-- needing a permissive USING with a strict WITH CHECK — both clauses are the
-- same disjunction.
--
-- ── The residual, stated plainly ─────────────────────────────────────────
-- Because WITH CHECK must admit the seller (respondToInquiry UPDATEs the
-- status, and an UPDATE's WITH CHECK is evaluated against the NEW row), a
-- seller with direct `app_user` SQL access could INSERT a fabricated inquiry
-- on their OWN listing attributed to another tenant. Tightening this needs
-- per-command policies, which reintroduces the permissive-sibling seam above.
-- The trade is deliberate: reaching that hole requires app-level RCE, at which
-- point the attacker has capabilities this policy was never the control for.
-- The hole this policy DOES close — a missing `where` exposing every tenant's
-- private messages to a read — is the one that happens by accident.

ALTER TABLE "ExchangeInquiry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExchangeInquiry" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_inquiry_party_isolation ON "ExchangeInquiry";
DROP POLICY IF EXISTS superuser_bypass                 ON "ExchangeInquiry";

CREATE POLICY exchange_inquiry_party_isolation ON "ExchangeInquiry"
    USING (
        "inquirerTenantId" = current_setting('app.tenant_id', true)::text
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeInquiry"."listingId"
              AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text
        )
    )
    WITH CHECK (
        "inquirerTenantId" = current_setting('app.tenant_id', true)::text
        OR EXISTS (
            SELECT 1 FROM "ExchangeListing" l
            WHERE l."id" = "ExchangeInquiry"."listingId"
              AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text
        )
    );

-- Privileged paths (the expiry sweep, seeds, migrations, platform admin) run
-- as a non-`app_user` role and bypass, exactly as every other table does.
CREATE POLICY superuser_bypass ON "ExchangeInquiry"
    USING (current_setting('role') != 'app_user');

-- The seller branch resolves through the listing on every row test, so the
-- lookup must be an index seek. `ExchangeListing` is the PK side of
-- `ExchangeInquiry.listingId`, so `l."id"` is already covered; this index
-- serves the `sellerTenantId` half for the planner when the subquery is
-- evaluated the other way round.
CREATE INDEX IF NOT EXISTS "ExchangeListing_id_sellerTenantId_idx"
    ON "ExchangeListing" ("id", "sellerTenantId");

-- NOTE: ExchangeListing itself stays GLOBAL and RLS-free. Its cross-tenant
-- readability IS the product — a marketplace whose offers only their author
-- can see is not a marketplace. That is recorded as an explicit exemption in
-- tests/guardrails/rls-coverage.test.ts so the next reader finds a decision
-- rather than an omission.
