-- P3.5b — a 6-digit email-verification code, issued BEFORE any farm exists.
--
-- Why a new table rather than columns on `VerificationToken`: a 6-digit code
-- has a 10^6 keyspace, so an attempt counter is a correctness requirement
-- rather than a nicety, and its TTL is minutes against that table's 24 hours.
-- Adding a nullable `attempts` to the link-token table would have made the
-- counter optional on the one flow that cannot function without it.
--
-- Keyed on `emailHash` (deterministic HMAC, as `User.emailHash`) and NOT on
-- the plaintext address, so a dump of this table identifies nobody. The
-- `emailHash` index is deliberately NOT unique: key rotation makes a lookup
-- try several candidate hashes, and during a rotation window the same person
-- can legitimately have a row under each key.
--
-- No RLS policy and no `tenantId`: this row exists before the farm does,
-- which is the inversion P3.5 is for. Same posture as `User` and
-- `PasswordResetToken`.

-- CreateTable
CREATE TABLE "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailVerificationCode_emailHash_idx" ON "EmailVerificationCode"("emailHash");

-- CreateIndex
CREATE INDEX "EmailVerificationCode_expiresAt_idx" ON "EmailVerificationCode"("expiresAt");
