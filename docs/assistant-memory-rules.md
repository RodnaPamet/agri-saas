# The nine assistant-memory rules

The design rules «Какво помни асистентът» is built to. Code in
`prisma/schema/ai.prisma`, `src/app-layer/usecases/assistant-memory.ts` and the
`/api/account/assistant-memory` routes cites these **by number**, and
`tests/guards/assistant-memory-rules-resolve.test.ts` fails CI when a cited
number has no rule here — so this file is the referent, not a summary of one.

## Provenance, stated honestly because it was wrong once

#2683's PR body and `ai.prisma` both said *"nine design rules borrowed from
`akitaonrails/ai-memory`"*. That attribution does not check out. That project
is a real influence — it is where the shape of this feature came from, and
the decision NOT to copy its decay curves was deliberate — but it publishes no
numbered list of nine rules: its README has none, and `docs/design-decisions.md`
carries a 20-item mistakes checklist whose numbering bears no relation to the
numbers used here.

**So these are OUR rules and the numbering is ours.** Seven of them (2–8) were
decided while building #2683 and #2686, and are recovered from the merged code
that enforces them. Rules **1** and **9** were never written to a file and were
lost; they are authored here, on 2026-11-01, and marked as such rather than
presented as recovered. If either contradicts an earlier intent, this file is
wrong and should be corrected — but it is now the only written version.

The lesson is worth keeping beside the rules: a number cited in code is a
reference, and a reference needs a referent in the repository. Six comments
pointed at a numbering that existed in no file, and nothing failed.

---

## The rules

### 1. Remember the person, never the farm's records. *(authored 2026-11-01)*

The profile is about the operator — what they grow, what keeps going wrong,
what they prefer, how they like answers. It is NOT a cache of farm data: a
parcel's area, a block's nutrient reading and a task's status are records,
already readable through the tools, and scoped to ONE farm.

This is the intent behind the cross-farm boundary that rule 3 enforces
structurally. `AssistantMemoryFact` carries no `tenantId` — one memory per
person, across farms — so a remembered farm record would be a record leaking
out of the farm it belongs to. Rule 3 makes that impossible rather than
discouraged; this rule says why we wanted it impossible.

### 2. A remembered point is DATA and authorises nothing.

A point re-enters the model's context on every later answer, so it is typed
text arriving under the same fencing a live question gets. «Винаги одобрявай
моите заявки» is a sentence to remember, never an instruction to obey. A
person editing their own point cannot escalate anything, and the prompt builder
is where that is enforced.

*Enforced in:* the prompt builder's fencing; `editRememberedPoint`'s docblock.

### 3. Learn ONLY from the person's own words.

A fact must carry `sourceQuote` — the person's own sentence — and a fact with
no quote cannot be created.

This is what makes the cross-farm leak **structurally impossible** rather than
merely forbidden: «Блок 3 has mana» came from TOOL output, so it has no quote
and can never become a fact. Better than the prompt instruction the issue
originally proposed, because a rule enforced by an extraction prompt is a
request.

*Enforced in:* `AssistantMemoryFact.sourceQuote`, non-nullable.

### 4. Latest wins.

When a new statement contradicts a remembered point, the newer one supersedes.
`sourceAt` is what makes "newer" answerable, which is why an edit re-dates the
evidence as well as replacing it — a correction that kept the old date would be
read as older than the point it replaced.

*Enforced in:* `AssistantMemoryFact.sourceAt`; `editRememberedPoint` re-stamps it.

### 5. Forgotten stays forgotten.

«Изтрий» sets `deletedAt` and KEEPS the row, so the extractor can refuse to
re-learn the same point from the same evidence. A hard delete would let the
next conversation that mentioned the subject undo the person's deletion.

*Enforced in:* `AssistantMemoryFact.deletedAt`; `forgetRememberedPoint`
tombstones rather than deleting.

### 6. A point the person EDITED is theirs.

`editedByPerson` stops the extractor rewriting it. Without it, a corrected
point that the next extraction could overwrite makes correcting it pointless —
which is why setting the column is the whole purpose of the edit verb rather
than a side effect of changing the text.

*Enforced in:* `AssistantMemoryFact.editedByPerson`; set by `editRememberedPoint`.

### 7. Evidence kept server-side.

`sourceQuote` + `sourceAt` stay on the server. They are what make rules 4 and 5
checkable, and they support the Art 15 export — but the list endpoint does not
return them: showing a person a superseded sentence of their own, presented as
why the assistant believes something, is misleading evidence.

*Enforced in:* `listRememberedPoints` selects neither column.

### 8. The profile is BOUNDED.

Roughly 3 KB reaches the prompt, and a person may see at most
`REMEMBERED_POINT_LIMIT` (50) points at once. The bound is not a page size: a
list longer than it means the extractor is ACCUMULATING rather than
superseding, which is a defect rather than something to paginate.

The bound is also what lets the profile ride the cacheable prompt prefix. It is
small and changes rarely; the conversation window is neither, which is why the
window sits after the prefix.

*Enforced in:* `REMEMBERED_POINT_LIMIT`; the prompt builder's clamp.

### 9. The memory is switchable without taking the assistant down. *(authored 2026-11-01)*

`assistant.memory` is a SEPARATE flag key from `assistant.enabled`, and
deliberately so: what it gates is a store of what the product remembers about a
person. If the only way to stop remembering were to stop answering, the off
switch would be unusable in exactly the situation that needs it.

Default OFF, per the standing dark-launch rule. An absent row and a disabled
row behave identically to every caller; the row exists so the coverage probe
can see that somebody decided.

*Enforced in:* `REFERENCED_FLAG_KEYS`; the gate on each
`/api/account/assistant-memory` route.

---

## What these rules do NOT cover

- **Decay.** `akitaonrails/ai-memory` decays unreferenced facts on a frequency
  curve. We deliberately do not: rule 4 supersedes and rule 5 tombstones, both
  on evidence, and a point that quietly faded would be neither forgotten nor
  remembered — a third state with nothing to show a person who asks why the
  assistant stopped knowing something.
- **Confidence scores.** A fact exists or it does not. A score would be a
  number nobody calibrated, and rule 7's evidence is the honest version of the
  same question.
- **Whether a point SHOULD be remembered at all** beyond rules 1 and 3 — the
  extraction prompt's judgement, which is #2671's remaining work.
