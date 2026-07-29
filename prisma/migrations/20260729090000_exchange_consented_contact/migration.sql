-- Exchange: consented contact exchange on ACCEPT.
--
-- The marketplace stopped at "Accept". Two farms who agreed had no way to
-- reach each other: `respondToInquiry` flipped a status and returned, the
-- models carried no contact fields at all, and the buyer's only signal was a
-- badge on a page they had to remember to revisit. Meanwhile the inquiry email
-- already promised "Contact details are shared only when you choose to
-- respond." — a sentence describing behaviour no code performed.
--
-- This implements the promise rather than deleting it.
--
-- ── Why contact-exchange and not an in-product thread ────────────────────
-- A thread keeps PII on-platform, which sounds strictly safer until you notice
-- the inquiry message is ALREADY emailed off-platform to up to 25 seller
-- admins. It would also require both parties to keep returning to an app the
-- buyer demonstrably does not revisit — which is the very defect being fixed.
-- Bulgarian grain trading happens by phone; a number lets two farms transact
-- today, where a thread makes them wait on each other's next login.
--
-- ── Why these columns ────────────────────────────────────────────────────
-- `sellerContact` is per-LISTING, not per-tenant: a seller can route different
-- offers to different people, and an anonymous seller stays anonymous in the
-- feed while still being reachable once they choose to be.
--
-- `contactSharedAt` IS the enforcement point, not a flag beside one. The
-- projections withhold BOTH contacts unless it is non-null, so a DECLINE — or
-- a still-PENDING inquiry — cannot leak either side. Same shape as
-- PromotionLead.consentedAt: the column is the control.
--
-- All three are NULLABLE by design. Existing listings and inquiries predate
-- the feature and have no consent to record; backfilling any value would
-- fabricate a consent that never happened. A listing without a contact simply
-- cannot complete the exchange until its seller adds one.

ALTER TABLE "ExchangeListing" ADD COLUMN IF NOT EXISTS "sellerContact"   TEXT;
ALTER TABLE "ExchangeInquiry" ADD COLUMN IF NOT EXISTS "inquirerContact" TEXT;
ALTER TABLE "ExchangeInquiry" ADD COLUMN IF NOT EXISTS "contactSharedAt" TIMESTAMP(3);

-- A contact may only be shared on an ACCEPTED inquiry. The application sets
-- both together in one update, but this is the database refusing to hold a
-- state the product does not have: a declined or pending inquiry whose
-- contacts are nevertheless revealed. Cheap to enforce, and it makes the
-- invariant true for anything that writes the table later — a backfill script,
-- a support fix, a future bulk action.
ALTER TABLE "ExchangeInquiry" DROP CONSTRAINT IF EXISTS "ExchangeInquiry_contact_shared_only_when_accepted";
ALTER TABLE "ExchangeInquiry" ADD CONSTRAINT "ExchangeInquiry_contact_shared_only_when_accepted"
    CHECK ("contactSharedAt" IS NULL OR "status" = 'ACCEPTED');
