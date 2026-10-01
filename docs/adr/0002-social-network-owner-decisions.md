# ADR 0002 — Owner decisions for Agrent as a social network

- **Status:** Accepted
- **Date:** 2026-10-01
- **Context:** the 12-phase roadmap (#1203), based on an 18-agent review of
  `agri-saas` main `97b9e0a` and `agrent-ios` master `55c79e3`
- **Supersedes nothing.** ADR 0001 exists twice under that number
  (`0001-product-identity.md`, `0001-ui-primitive-stack.md`); this file does not
  renumber them.

## Why this ADR exists

The roadmap was delivered as a file outside both repositories, and twenty-two of
its decisions are the owner's rather than the plan's. A decision that lives only
in a plan nobody committed is a decision that gets re-litigated — or worse,
quietly reversed by someone who never knew it was made. This records them where
the code is.

**These are the owner's rulings, not recommendations.** Where an entry carries
reasoning, the reasoning is recorded so a future reader can tell whether a
changed circumstance should reopen it.

## The decisions

| # | Decision |
|---|---|
| **OD1** | **A person speaks, with their farm as a badge** — «Иван Петров · ЗК Победа ✓ · обл. Добрич». Exchange deal threads stay farm-to-farm. |
| **OD2** | **The farm ID is ЕИК/БУЛСТАТ with checksum**, for legal entities and sole traders. Natural-person farmers register with no public ID. **ЕГН is never collected.** Staff verify against a registry extract or ОДЗ card. Only VERIFIED claims are unique; a duplicate goes to dispute. |
| **OD3** | **Public:** name, handle, logo/cover, bio, oblast, crops, size band, verified seal, opted-in listings. **Never public:** ЕГН, УРН, address, exact hectares, parcels. Default members-only; search-engine indexing is a separate opt-in. |
| **OD4** | **Apple:** finish the TestFlight setup, create an APNs .p8 key and a Sign in with Apple service ID. |
| **OD5** | **MECHANISATOR role gets no social features in v1.** |
| **OD6** | **Chat bodies encrypted at rest under the global key. No end-to-end encryption**, so moderation stays possible. |
| **OD7** | **Offline sending queues in memory only**, shown as «Чака сигнал». |
| **OD8** | **Follow the system theme**, plus a high-contrast «Слънце» theme. One gold brand colour; remove the leftover orange and navy. |
| **OD9** | **Fix the vocabulary now** (Борса, Тенденции). **Decide the five tabs only after 30 days of usage data.** |
| **OD10** | **Moderation is the owner plus one deputy.** 24h for DSA notices, 48h for farm claims. A lawyer reviews Terms and Privacy. |
| **OD11** | **No AI budget for a self-registered farm until it is verified**, then a cap. |
| **OD12** | **Listings link to the farm profile only via a per-listing opt-in, off by default.** |
| **OD13** | **Members of verified farms may DM directly.** Everyone else lands in «Заявки» and gets one message until accepted. |
| **OD14** | **Beta cohort:** the owner's farm plus one test farm, then 15–25 recruited farms across 3–4 oblasti. |
| **OD15** | **Profiles are `noindex` by default.** |
| **OD16** | **Chat recovery point: 24h during beta**; WAL archiving before national launch. |
| **OD17** | **Channels in v1 are official only:** 15 crops, 28 oblasti, plus #субсидии #техника #вредители-и-болести #пазар #времето #помощ. |
| **OD18** | **Push for DMs.** Channels notify on mentions and replies only. Quiet hours 22:00–06:00. |
| **OD19** | **Read receipts on by default and SYMMETRIC** — turning «Видяно» off also hides others' receipts from you. |
| **OD20** | **Minimum age 16+.** |
| **OD21** | **Import the Търговски регистър CC0 dump** to show the registered name as the user types their ЕИК. |
| **OD22** | **No permanent staging.** Runtime flags with cohorts, and a throwaway VM for load tests. |

## Consequences worth stating

**OD2 is the one with legal force.** ЕГН legally cannot be the sign-in identifier
(ЗЗЛД чл.25ж), and since 2022 more than 300,000 self-insured farmers hold a
9-digit БУЛСТАТ — so **ЕИК can itself be personal data**. "Use ЕИК, never ЕГН" is
therefore not a clean split between corporate and personal identifiers, and the
public-field allowlist in OD3 is what keeps it lawful rather than the choice of
identifier alone.

**OD2 also means registration cannot be automatic.** No public API proves a person
controls a farm, so a claim needs verification and a dispute path — which is why
P3 carries a staff verification console and `FarmIdentityClaim` is unique only
where `status='VERIFIED'`.

**OD9 and OD22 both defer to measurement.** The five tabs wait for 30 days of
usage data (P0.5 starts that clock; P10 consumes it), and there is no staging
environment to validate on — cohorted runtime flags are the substitute. Both
decisions make **P0.4 and P0.5 load-bearing for the whole plan** rather than
merely first.

**OD6 is a deliberate trade against the user.** Bodies are encrypted at rest but
not end-to-end, so the operator can read them. That is the price of being able to
moderate, and it should be said plainly in the privacy notice (P3.1) rather than
implied by omission.

**OD19's symmetry is a product constraint, not a UI detail.** "Off also hides
others' receipts from you" has to be enforced server-side, or a client can keep
reading receipts while withholding its own.

## Status of the decisions in code

None of these are implemented yet beyond the P0 rails. Tracking is per phase:
#1191 (P0) through #1202 (P11), indexed at #1203.
