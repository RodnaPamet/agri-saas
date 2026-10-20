-- #1769 — a provider message id, and what sent it.
--
-- ## What this is for
--
-- `sendEmail` has logged the provider's message id since #1759, which makes a
-- delivery failure VISIBLE. It cannot make one ACTIONABLE. A webhook handed
-- `messageId=abc` has no way to learn that `abc` was a DSA triage alert for
-- `ContentReport` X, so it logs the bounce and stops there.
--
-- That gap has a cost that is already recorded. On 2026-10-13 three Art 16
-- alerts were sent, `notice-triage-alert` stamped `alertedAt` on each report,
-- and all three bounced (#1753). `alertedAt` is precisely what stops the job
-- re-alerting — a deliberate design, so a FAILED send leaves the notice
-- unstamped and the next run retries. It depends on the send throwing. A
-- message the provider ACCEPTS and then fails to deliver defeats it: the
-- stamp lands, the retry never fires, and the DSA clock runs against a
-- mailbox nobody wrote to.
--
-- With this table the delivery webhook can clear the stamp.
--
-- ## `subjectIds` is a LIST, and that is a correction to #1769's proposal
--
-- The issue sketched a scalar `subjectId`. The sender does not work that way:
-- `notice-triage-alert` composes ONE digest covering every waiting notice and
-- stamps them in a single `updateMany(where: { id: { in: … } })`. A scalar
-- column would let the webhook clear one report's stamp and leave the rest
-- stamped — an alert that retries for one notice out of three, which is
-- exactly the "sometimes" state the issue argues is worse than none.
--
-- Found by reading the sender rather than the proposal.
--
-- ## Nothing writes it in this migration, deliberately
--
-- The column-then-writer split this repo uses (see #2062's
-- `derivedFromFileRecordId`): the table ships one release ahead of the code
-- that fills it, so a rollback of the application cannot leave a migration
-- that the running code requires.
--
-- ## Not tenant-scoped, and that is a decision rather than an omission
--
-- Several senders have no tenant at all — password resets, email
-- verification, the mail canary. A nullable `tenantId` on a table whose
-- entire purpose is lookup-by-id would invite a tenant-filtered query that
-- silently misses exactly those rows, which is the failure mode this table
-- exists to end. Nothing stored here is tenant data: an opaque provider id, a
-- purpose string, a subject reference, and a domain.
--
-- ## No recipient address column
--
-- Same rule as `mail.sent`'s log line (#1759) and Epic C.4's audit-actor rule:
-- the recipient DOMAIN answers the operational question — "the DSA mailbox" or
-- "a farmer's inbox" — and the address is the disclosure. A table of who was
-- invited, who reported what, and who asked to be deleted is exactly what this
-- product's design spends its effort avoiding.

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectIds" TEXT[],
    "recipientDomain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failedAt" TIMESTAMP(3),
    "failureKind" TEXT,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique: a delivery webhook's only key is this id, so two rows would make
-- the lookup ambiguous and the webhook's action arbitrary.
CREATE UNIQUE INDEX "OutboundMessage_messageId_key" ON "OutboundMessage"("messageId");

-- CreateIndex
CREATE INDEX "OutboundMessage_purpose_createdAt_idx" ON "OutboundMessage"("purpose", "createdAt");

-- CreateIndex
-- GIN, for the inverse question — "did anything we sent about THIS report
-- fail?" — which a moderator looking at a stuck notice needs. It is an
-- array-containment query and a btree on TEXT[] cannot serve it.
CREATE INDEX "OutboundMessage_subjectIds_idx" ON "OutboundMessage" USING GIN ("subjectIds");

-- CreateIndex
CREATE INDEX "OutboundMessage_failedAt_idx" ON "OutboundMessage"("failedAt");
