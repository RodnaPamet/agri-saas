# CLAUDE.md: restoring the summary-plus-pointer shape

*2026-10-06 · first section: Field Encryption (Epic B)*

CLAUDE.md is 226,690 bytes — about 56,700 tokens — and it is part of the input
on **every** request, not once per session. Prompt caching makes repeat reads
much cheaper, but full price is paid again at session start, after every
compaction, and **in every subagent**, each of which carries its own copy. Three
agents ran on 2026-10-06; each paid it from a cold start.

## What this is not

It is not a token-saving exercise dressed as tidying, and the file already
argues the case itself. The Epic B section's own last line read:

> **See `docs/epic-b-encryption.md`** for deployment order, …

So summary-plus-pointer was the intended shape. The section had simply grown to
262 lines past it. CLAUDE.md's opening also states the principle outright: *"a
contract, not a scrapbook"*.

## What moved, and what did not

Every RULE stayed in CLAUDE.md as an imperative. What moved is the reasoning,
the incident history and the mechanism detail — to the doc the section already
pointed at, under a heading that says why to read it.

Epic B: 262 lines → 45, about **3,100 tokens per session**.

Rules kept: never add or remove encrypted columns outside the manifest;
plaintext exceptions go in `DELIBERATELY_PLAINTEXT` keyed per FIELD; narrowing
stops decryption so declaring must land first; `Tenant.encryptedDek` is in
neither manifest; "zero `v1:` rows" is not a rotation stop condition; the master
KEK is required in production with three checks enforcing it.

Moved: the #1222 `'*'`-collision incident, the sentinel's failure modes, the
#698 worker/scheduler divergence, rotation and fan-out preflight, the
lookup-hash population.

## The measurement that changed the plan

I expected some of this to be duplicated in the epic docs — free wins. Measured
across all seven candidate sections, the overlap is **0–2%**. The docs and
CLAUDE.md hold genuinely different content, so every byte moved really does
leave the always-loaded context. That is the risk the owner accepted, and it is
real rather than theoretical: the mitigation is that the rules stay, and the
pointer says what the doc is for.

## Constraints, verified rather than assumed

- **No guard reads CLAUDE.md's content** — zero `readFileSync` on it, so
  removing text cannot redden CI.
- **One guard requires CLAUDE.md to LINK to `docs/runbooks/production-vm.md`**
  (`toContain`, nothing more). Still present.
- **Six section names are cited by guards in docblocks** — `"Key Conventions"`,
  `"Testing Conventions → E2E tests"`, `"Green is not the same as executed"`,
  `"Action button vocabulary"` and two others. Those headings must survive as
  headings or a dozen citations rot. A rotted citation proves the reference
  moved, not that the claim changed, which is how such references quietly stop
  being trusted.

All 8 guards that reference CLAUDE.md pass (54 tests).

## Remaining

Six sections, about 12,700 further tokens, tracked separately. One of them
(Offline outbox durability, ~4,100 tokens) has no existing doc to move into and
needs a new one rather than an append.
