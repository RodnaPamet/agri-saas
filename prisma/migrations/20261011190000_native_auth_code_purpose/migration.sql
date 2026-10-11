-- Apple native sign-in at a two-factor farm: the pending-MFA ticket.
--
-- Apple's sign-in happens inside the app, with no browser sheet to type a
-- TOTP code into, so the gate added for the other providers (refuse to issue
-- an auth code while `mfaPending` is set on the cookie) has nowhere to stand.
-- Until now this route simply refused with MFA_REQUIRED.
--
-- A ticket is how the app collects the code instead: the route issues a
-- `NativeAuthCode` row that is NOT a grant, the app posts the TOTP code
-- against it, and only then does a token pair exist.
--
-- ## Why reuse NativeAuthCode rather than add a table
--
-- Because this row has to be exactly what that one already is: server-stored,
-- SHA-256 hashed, single-use via an atomic `consumedAt` claim, short-TTL,
-- PKCE-bound, RLS-covered, and carrying no claims of its own. A ticket that
-- is a JWT with session claims is the bug class this whole change set exists
-- to remove. Every property is already here and already reviewed.
--
-- ## Why `purpose` and not a boolean
--
-- The exchange route reads by `codeHash` alone today. It will read
-- `{ codeHash, purpose: 'SESSION' }`, so a `PENDING_MFA` ticket is NOT FOUND
-- there — refused by the absence of a matching row rather than by an `if`
-- someone can later delete. A boolean would read as an optional flag; an enum
-- forces each issuer to say which thing it is making.
--
-- DEFAULT 'SESSION' so every existing row and every existing issuer is
-- unchanged, and the column is backfilled by the default rather than by a
-- data migration.
--
-- ## No RLS change
--
-- `NativeAuthCode` already has row-level security from 20260819120000 and is
-- listed in `rls-coverage`'s expectations. Adding columns to a table whose
-- policies key on `userSessionId` changes nothing about who can see a row.

CREATE TYPE "NativeAuthCodePurpose" AS ENUM ('SESSION', 'PENDING_MFA');

ALTER TABLE "NativeAuthCode"
    ADD COLUMN "purpose" "NativeAuthCodePurpose" NOT NULL DEFAULT 'SESSION',
    -- Wrong codes presented against a ticket. A 6-digit secret is guessable
    -- by brute force in a way a 32-byte code is not, so this row needs an
    -- attempt limit its SESSION sibling never did.
    ADD COLUMN "mfaAttempts" INTEGER NOT NULL DEFAULT 0;

-- The exchange's lookup becomes `(codeHash, purpose)`. `codeHash` is already
-- UNIQUE, so that read stays a single indexed hit and this index is NOT added
-- — a second index on a table whose rows live for seconds would cost writes
-- and buy nothing. Stated because its absence should look deliberate.
