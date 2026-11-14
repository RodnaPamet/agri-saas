-- #3020 — a person-scoped push held back by quiet hours needs somewhere to be
-- COUNTED, so the 06:00 summary does not wake somebody to tell them about zero
-- things.
--
-- `Notification.tenantId` is NOT NULL with an FK to Tenant, so a channel
-- mention or a direct message — which belong to a PERSON who may have no farm
-- or several — cannot write a row there. That is the wall P5.4a hit with
-- `NotificationOutbox`, and the reason `StatementOfReasons` became its own
-- outbox rather than borrowing a tenant-scoped one.

CREATE TYPE "PersonPushDeferralKind" AS ENUM (
    'CHANNEL_MENTION',
    'CHANNEL_REPLY',
    'DIRECT_MESSAGE'
);

CREATE TABLE "PersonPushDeferral" (
    "id"              TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "nightKey"        TEXT NOT NULL,
    "kind"            "PersonPushDeferralKind" NOT NULL,
    "channelId"       TEXT,
    "postId"          TEXT,
    "conversationId"  TEXT,
    "settledAt"       TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonPushDeferral_pkey" PRIMARY KEY ("id")
);

-- The summary read: this person's undelivered rows, oldest first.
CREATE INDEX "PersonPushDeferral_recipientUserId_settledAt_createdAt_idx"
    ON "PersonPushDeferral"("recipientUserId", "settledAt", "createdAt");

-- "what did the window hold back last night", which is the operator question
-- #3020 was filed to make answerable without reading a log.
CREATE INDEX "PersonPushDeferral_nightKey_idx"
    ON "PersonPushDeferral"("nightKey");

ALTER TABLE "PersonPushDeferral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonPushDeferral" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS superuser_bypass ON "PersonPushDeferral";

-- `superuser_bypass` is the ONLY policy, which is the `NoticeScore` posture and
-- deliberate: nothing on a request path reads or writes this table. The
-- deferral is written by a JOB (`person-push-send`) and drained by a JOB
-- (`person-push-summary`), both privileged, so no arm grants `app_user` any
-- access at all.
--
-- That matters in one specific direction. The rows name a person and say that
-- somebody mentioned them or wrote to them, which is exactly the kind of fact
-- `UserBlock` and `ContentReport` are careful about — and unlike
-- `ContentReport`, there is no reason for the subject to read their own rows:
-- the only thing they are entitled to is the push, which they get. A reporter
-- arm here would be a disclosure surface with no feature behind it.
CREATE POLICY superuser_bypass ON "PersonPushDeferral"
    USING (current_setting('role') != 'app_user');
