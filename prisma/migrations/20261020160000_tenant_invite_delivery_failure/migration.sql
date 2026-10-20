-- #1769 PR 2 — make a bounced invite visible as something other than pending.
--
-- ## The gap this closes
--
-- A bounced invite and an unopened one were the same row. The phone's Члене
-- screen lists pending invitations and shows «Поканен»; agrent-ios's own note
-- says "Has my invite actually gone out?" is the main reason anyone opens that
-- screen, so a bounce that renders as "still pending" answers it wrongly.
--
-- ## A kind, not a boolean
--
-- The provider's event type, so a complaint is distinguishable from a bounce
-- without a second column. A plain string rather than an enum so a new
-- provider event cannot be blocked on a migration — the same choice
-- `OutboundMessage.failureKind` makes.
--
-- ## Nullable, no default, no backfill
--
-- NULL means "nothing has come back", which is NOT "delivered". The join from
-- a bounce to an invite runs through `OutboundMessage`, which only exists for
-- sends made after #1769 PR 1 shipped, so older invites have nothing to
-- backfill from. A default of 'delivered' or `false` would be a claim the
-- product cannot support, for exactly the rows where it is least true.
ALTER TABLE "TenantInvite" ADD COLUMN "deliveryFailureKind" TEXT;
ALTER TABLE "TenantInvite" ADD COLUMN "deliveryFailedAt" TIMESTAMP(3);

-- And `OrgInvite`, which is a SEPARATE model reached through the same
-- `sendInviteEmail`. Found while wiring the sender: the org route creates an
-- OrgInvite, not a TenantInvite, so recording one subject type for both would
-- have made the webhook's updateMany match zero rows for every org invite —
-- silently, because updateMany reports a count nobody was reading. The sender
-- derives which to record from its existing `kind` param.
ALTER TABLE "OrgInvite" ADD COLUMN "deliveryFailureKind" TEXT;
ALTER TABLE "OrgInvite" ADD COLUMN "deliveryFailedAt" TIMESTAMP(3);
