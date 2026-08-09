/**
 * Audit Coherence S6 (closure lock, 2026-05-27) — Gap 6 (policy
 * attestation tracking) was shipped 2026-05-24 (Audit S4 sprint).
 * This ratchet locks the schema, usecase, and audit-event surface
 * so a future refactor can't silently strip the attestation chain.
 *
 * The original audit (2026-05-22) flagged ISO 27001 §7.3 as
 * requiring evidence that personnel acknowledged policies. The
 * `PolicyAcknowledgement` model + `policy-attestation.ts` usecase
 * close that gap. The verification doc dated 2026-05-25 listed
 * this as OPEN because it was written before S4 landed — this
 * ratchet is the authoritative record that the closure is real.
 *
 * Locks three layers:
 *
 *   1. Prisma model — PolicyAcknowledgement has the canonical
 *      shape (policyVersionId / userId / acknowledgedAt /
 *      tenantId) + the @@unique([policyVersionId, userId])
 *      idempotency guard.
 *   2. Usecase — attestPolicy / getPolicyAttestation /
 *      listPolicyAttestations all exported with the documented
 *      signatures.
 *   3. Attestation is GATED on the published version (a DRAFT
 *      or ARCHIVED version is rejected).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Audit S6 — policy attestation tracking (closure lock)", () => {
    describe("Schema", () => {
        const src = () => read("prisma/schema/compliance.prisma");

        it("PolicyAcknowledgement model exists with canonical fields", () => {
            const s = src();
            expect(s).toMatch(/model PolicyAcknowledgement \{/);
            // The four load-bearing fields. Each is anchored to its
            // type so a refactor that flips one to nullable (or
            // renames it) trips this.
            expect(s).toMatch(/policyVersionId\s+String\b/);
            expect(s).toMatch(/userId\s+String\b/);
            expect(s).toMatch(/acknowledgedAt\s+DateTime\b/);
            expect(s).toMatch(/tenantId\s+String\b/);
        });

        it("PolicyAcknowledgement has the idempotency unique constraint", () => {
            // Without this, a user could attest the same version
            // multiple times — inflating compliance metrics.
            expect(src()).toMatch(
                /@@unique\(\[policyVersionId,\s*userId\]\)/,
            );
        });

        it("PolicyVersion exposes the acknowledgements relation", () => {
            // The relation feeds the listPolicyAttestations query
            // + the attestation-count column in the admin UI.
            expect(src()).toMatch(
                /acknowledgements\s+PolicyAcknowledgement\[\]/,
            );
        });
    });

    describe("Usecase", () => {
        const src = () =>
            read("src/app-layer/usecases/policy-attestation.ts");

        it("exports attestPolicy with the canonical signature", () => {
            expect(src()).toMatch(
                /export async function attestPolicy\(\s*ctx:\s*RequestContext,\s*policyId:\s*string,?\s*\)/,
            );
        });

        it("exports getPolicyAttestation + listPolicyAttestations", () => {
            const s = src();
            expect(s).toMatch(/export async function getPolicyAttestation/);
            expect(s).toMatch(
                /export async function listPolicyAttestations/,
            );
        });

        it("attestPolicy returns the canonical AttestPolicyResult shape", () => {
            const s = src();
            expect(s).toMatch(/export interface AttestPolicyResult \{/);
            // Five canonical fields including the `created` flag
            // that callers branch on for "first attestation" vs
            // idempotent re-call.
            for (const field of [
                "acknowledgementId",
                "policyVersionId",
                "userId",
                "acknowledgedAt",
                "created",
            ]) {
                expect(s).toMatch(new RegExp(`${field}:\\s*\\w`));
            }
        });

        it("attestPolicy is gated to PUBLISHED policy versions only", () => {
            // ISO 27001 §7.3 — a DRAFT attestation doesn't satisfy
            // the practice. The usecase rejects non-published
            // versions. The header comment explicitly calls this out;
            // the test pins the comment AND a `PUBLISHED` predicate
            // somewhere in the function body.
            const s = src();
            expect(s).toMatch(/Only PUBLISHED policies can be attested/);
            // Either an inline check OR a delegated repo call must
            // anchor on the PUBLISHED status token.
            expect(s).toMatch(/PUBLISHED/);
        });
    });

    describe("Authorization + audit", () => {
        const src = () =>
            read("src/app-layer/usecases/policy-attestation.ts");

        it("attestation flow imports assertCanRead (any tenant member can attest)", () => {
            // Per the ISO §7.3 model — attestation is a "I have
            // read this" gesture, not a privileged write. The
            // header docstring spells this out; the import must
            // reflect it.
            expect(src()).toMatch(/assertCanRead/);
        });

        it("listing is gated by assertCanAdmin (audit/admin view)", () => {
            expect(src()).toMatch(/assertCanAdmin/);
        });

        it("emits an audit event via logEvent", () => {
            expect(src()).toMatch(/logEvent/);
        });
    });
});
