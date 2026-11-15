-- P9.7 (#2941) — the opt-in 07:15 channel digest.
--
-- Columns on `User` rather than a table, for the reason `bottomTabOrder`
-- records: `UserNotificationPreference` is a table because it has per-farm
-- rows with their own lifecycle, and these are one value each per person. A
-- channel has no tenant, so a per-farm row could not express them anyway.
--
-- `DEFAULT false` is the opt-in direction stated in the schema: absence reads
-- as off, so a deploy does not start mailing anybody.

ALTER TABLE "User" ADD COLUMN "channelDigestOptIn" BOOLEAN NOT NULL DEFAULT false;

-- The idempotence marker: has TODAY's digest gone out for this person. A DATE,
-- because the question is the day and not the instant — the job runs every 15
-- minutes and without this would push four times an hour from 07:15 onward.
ALTER TABLE "User" ADD COLUMN "channelDigestSentOn" DATE;

-- The job's population read: opted-in people who have not had today's digest.
-- Partial, because the opted-out rows are the overwhelming majority and will
-- stay so — an index over every user would be mostly dead weight.
CREATE INDEX "User_channelDigest_pending_idx"
    ON "User"("channelDigestSentOn")
    WHERE "channelDigestOptIn" = true;
