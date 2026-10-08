-- P4.2 — Sign in with Apple nonce replay refusal.
--
-- Apple echoes a client-generated nonce into the identity token as its
-- SHA-256. Matching the hash proves the token was minted for THIS request; it
-- does not stop the same token being presented twice. The UNIQUE index below
-- is what does: the INSERT is the claim, so a replay is a constraint violation
-- rather than something a read has to notice — which is what makes it correct
-- under concurrency, where a read-then-write races itself.
--
-- Purely additive: a new table, no column dropped or renamed, so the previous
-- image keeps working against this schema and no inverse script is needed
-- under deploy/rollback/.
CREATE TABLE "AppleSignInNonce" (
    "id"        TEXT         NOT NULL,
    "nonceHash" TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppleSignInNonce_pkey" PRIMARY KEY ("id")
);

-- The replay defence itself, not an optimisation.
CREATE UNIQUE INDEX "AppleSignInNonce_nonceHash_key" ON "AppleSignInNonce"("nonceHash");
CREATE INDEX "AppleSignInNonce_expiresAt_idx" ON "AppleSignInNonce"("expiresAt");

-- NO row-level security, and that is deliberate rather than an omission.
--
-- The table is tenant-LESS and user-LESS by design: a nonce is claimed before
-- any principal is resolved, and a token that fails verification must still
-- burn its nonce. There is no tenant to scope a policy to, and the rows carry
-- nothing about anybody — a SHA-256 of a random client-generated value and two
-- timestamps. `tests/guardrails/rls-coverage.test.ts` derives its population
-- from models carrying `tenantId`, so this is outside it by construction
-- rather than by exemption.
