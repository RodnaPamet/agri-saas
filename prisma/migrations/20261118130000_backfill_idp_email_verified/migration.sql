-- #3178 — accounts created through Google, Microsoft Entra or a tenant's SSO
-- never had `User.emailVerified` set, because only the e-mail-code path wrote
-- it, so slow mode read every one of them as "never confirmed" for ever.
-- Sign-in now stamps the column (`markEmailVerifiedByIdp`); this backfills the
-- accounts that already exist, so a long-lived session whose claims re-mint on
-- refresh (no fresh IdP sign-in) is not held in slow mode until it happens to
-- sign in again.
--
-- An identity-provider account (any `Account` row — the credentials provider
-- creates none) or a tenant SSO link is the evidence an IdP vouched for the
-- address. The value is NOW(): the moment of the first confirmation is not
-- recorded anywhere, and this migration must not invent one. Slow mode's age
-- half reads `createdAt`, so the choice does not change any verdict.
--
-- Additive in effect: the previous image reads a non-null timestamp as
-- verified, so no inverse script is needed.
UPDATE "User" AS u
SET "emailVerified" = NOW()
WHERE u."emailVerified" IS NULL
  AND (
    EXISTS (SELECT 1 FROM "Account" a WHERE a."userId" = u."id")
    OR EXISTS (SELECT 1 FROM "UserIdentityLink" l WHERE l."userId" = u."id")
  );
