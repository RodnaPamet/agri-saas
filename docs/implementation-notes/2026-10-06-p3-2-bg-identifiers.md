# P3.2 — Bulgarian identifiers, and the circularity problem in their tests

*2026-10-06 · roadmap #1194*

`src/lib/bg-identifiers.ts`: ЕИК (БУЛСТАТ) checksum validation for 9- and
13-digit codes, an ЕГН detector, and one `classifyEikInput` that every surface
calls so they cannot disagree.

## The ЕГН detector exists to refuse, and that needed care

The roadmap says "an ЕГН detector, used only to refuse it", which reads like a
ban. It is not, and getting that wrong would break a regulatory form.

`FarmProfile.egn` **legitimately stores an ЕГН**, encrypted under the Epic B
manifest, because the БАБХ ДНЕВНИК (Прил. 1 към заповед РД 11-3194/31.12.2021)
has a field for it and a sole trader's form is invalid without one.

What the detector is for is narrower: a sole trader types their ЕГН into the
**ЕИК** field at registration. Without detection that is either accepted as
garbage or rejected with "invalid ЕИК" while the user stares at a number they
know is theirs. With it we can name the mistake and decline to keep the value.

So the refusal is scoped to the identifier being asked for, not to the number
existing. `looksLikeEgn` returns a bare boolean and the docblock forbids
logging it, echoing it into an error, or putting it in a URL or metric label.

## Why the ЕГН check requires a decodable date as well as a checksum

Ten digits with a valid mod-11 check but month 77 is far more likely a mistyped
ЕИК than a personal number. Calling that an ЕГН sends the user the wrong error.
The month also encodes the century (+40 → 2000s, +20 → 1800s), so decoding it
is nearly free once the digits are in hand.

## The test problem worth recording

The obvious test is "here are some valid ЕИК, assert they validate". Every
vector I can produce comes from the algorithm under test, so it proves the
module agrees with itself. **If the weights are wrong, the vectors are wrong the
same way and everything passes.**

Three things are done instead, none depending on my weights being right:

1. **An independent re-implementation** in the test file, written longhand from
   the БУЛСТАТ rules and deliberately not sharing the module's `mod11` helper.
   Vectors are generated from that and checked against the module.
2. **Digit uniqueness** — for any 8-digit prefix, at most one of the ten
   possible check digits may validate. A `return true`, a dropped modulo, or a
   fallback admitting a second answer all die here without the test needing to
   know the right answer.
3. **A rejection floor** over deterministic inputs — a validator that passes
   most strings is not validating. No RNG: a flaky guard is worse than none.

It paid immediately, though not as expected: the first failure was in the
**test's** 13-digit helper, which passed four sub-unit digits and built a
14-character string. A 13-digit ЕИК is 9 base digits + 3 sub-unit + 1 check,
and the check is computed over the base's own 9th digit plus those three.

**What none of this proves is conformance to the published standard.** That
needs one real ЕИК checked against Търговския регистър by a person. Both the
module and the test say so.

## A warning carried into the module for the iOS side

The roadmap asks for "test vectors shared with iOS". Shared vectors are only
evidence if the two implementations were derived independently — if iOS copies
these and my weights are wrong, both sides are wrong identically and agree
perfectly. The module docblock tells them to implement from the standard and
then compare.

## Also

`admin.farmProfile.fields.urn` relabelled: «УРН (регистрационен номер на
стопанина)» → «УРН в ИСАК (ДФЗ)». The old label said the number was a
registration number without saying which register; a farmer knows where their
УРН lives. English keeps the Bulgarian acronyms with a gloss, matching the 47
existing English strings that already do (`ЕИК (company ID)`).

## Not in this PR

No caller yet. This is the library P3.3 (`createFarmTenant`), P3.4
(`FarmIdentityClaim`) and P3.7 (`/api/public/eik-check`) consume — and
`/api/public/eik-check` in particular should call `isValidEik` before asking any
registry, so a number that cannot exist is never looked up.
