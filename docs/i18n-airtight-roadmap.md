# Making the Bulgarian translation airtight

Written 2026-09-22, after the owner reported "a lot of not translated
words" in a product whose users are Bulgarian.

## The thing to explain first

**Every i18n guard is green.** Eight guard files, 45 tests, all passing:

```
tests/guardrails/i18n-completeness.test.ts
tests/guardrails/i18n-bulgarian-cyrillic.test.ts
tests/guards/no-hardcoded-ui-strings.test.ts
tests/guards/i18n-coverage.test.ts
tests/guards/i18n-key-exists.test.ts
…
```

So the English the owner is looking at is not a guard that failed. It is
a class of string **no guard is looking at**. That distinction is the
whole roadmap: adding translations without closing the blind spot means
doing this again in three months.

## What is actually untranslated, measured

### Class A — tracked, already falling

`no-hardcoded-ui-strings` tolerates a known backlog and ratchets it
downward:

| | count |
|---|---|
| hard-coded JSX strings | **17** |
| hard-coded config props (`label:` / `description:` / `placeholder:` in `.ts` modules) | **201** |

201 is down from ~380. The guard's own docblock records why the second
class exists at all, and it is the best summary of this whole problem in
the repo:

> The scan originally covered `.tsx` only, which is precisely why the
> contracts modal shipped English dropdowns to Bulgarian users: its
> labels came from a `.ts` filter-def module.

A guard that covers *almost* the right population produces exactly this
outcome — green, and wrong on screen.

**Status: healthy.** It is measured, it is enforced, it only falls. It
needs a burn-down cadence, not new machinery.

### Class B — invisible to every guard, and the largest

**502 user-facing English messages authored in the server layer** (530 when
this was first measured; batch one drained crop-planning, evidence, farm-task,
part of journal and the upload path, batch two the rest of journal plus field
operations).

That number is now ENFORCED by
`tests/guards/no-server-authored-user-copy.test.ts`, and it supersedes
the 382 this document carried first. Both were honest for their own
definition — 382 came from a grep requiring a capital first letter and
15+ characters; 530 counts any message of two or more latin words that is
not an ALL-CAPS identifier. **The enforced definition is the one that
means anything**, so it is the one quoted here.

By helper, on the narrower count that produced 382:

| helper | call sites |
|---|---|
| `notFound(...)` | 160 |
| `badRequest(...)` | 152 |
| `forbidden(...)` | 65 |
| `conflict(...)` | 5 |

Real examples, all of which a Bulgarian farmer can be shown:

```
Access review not found
A fertilizer dose and unit are required.
Adjustment delta must be non-zero.
A data-stream key is required.
```

**No guard scans this code.** `no-hardcoded-ui-strings` walks `src/app`
and `src/components`. These strings live in `src/app-layer/` and
`src/lib/`. Not one is counted by anything, which is why the count could
reach 382 without a single test going red.

**How much of it is on screen today is a different question, and the
honest answer is: not much, on the web.** The first draft of this
document claimed 48 render sites. That was wrong — it came from grepping
`.message}` and counting `form.notify.message`, `state.message` and
notification bodies as if they were errors. Measured properly:

| | count |
|---|---|
| JSX interpolations of an error's `.message` | **1** (`{markError.message}`) |
| toast calls passing an error message through | **3** |

Most failure toasts call a translated generic — `toast.error(t('createFailed'))` —
so the server's English is usually discarded before it reaches anyone.

That makes class B **latent rather than active on the web**, and it is
worth being exact about, because the two readings imply different
urgency. The argument for treating it as the priority is not that 382
strings are on screen today. It is that:

- 382 unguarded strings sit **one render site away** from being on
  screen, and nothing would go red when that happens; and
- the same class **is already active in payload fields** (below), which
  is where it was actually caught.

### Class B2 — English in payload fields, and this one IS on screen

Distinct from error messages and confused with them in the first draft.
`netWorthUnavailableReason` is not an error — it is a **field of a
successful response**, authored in English by the usecase and rendered
directly:

```ts
/** English, authored by the usecase — the FALLBACK for an unknown code. */
netWorthUnavailableReason: string | null;
```

The web translates it via the sibling `netWorthUnavailableCode`. The iOS
app decodes only `reason`, so it prints English on a Bulgarian screen
every time net worth cannot be computed — a normal state, not an edge
case. That is `PARITY.md` Gap 1, and it is the observed instance of this
whole family.

### Class C — the iOS app

`agrent-ios` has no i18n framework; every string is hard-coded
Bulgarian, which is correct for a single-locale app and means the app
authors no English of its own.

So English reaches the phone **only from B1 and B2**, and the phone is
where B2 was actually caught — it has no translated-generic layer to
absorb it the way the web's `toast.error(t('createFailed'))` does. What
the server sends is what the operator reads.

That inverts the usual assumption: the client with no i18n framework is
not the weak one here. It is the one with no place left to hide an
untranslated string, which is why it surfaced the bug first.

## Why class B cannot be fixed by translating 382 strings

The obvious plan — put all 382 in `messages/bg.json` — does not work, and
understanding why determines the real plan.

A client can only translate what it can **identify**. The wire carries
`error.code`, but:

```ts
export const badRequest = (message: string, details?: unknown) =>
    new ValidationError(message, details);
```

There is no `code` parameter. All 152 `badRequest` call sites produce the
same category code. **A code shared by 152 different messages is not an
identity**, so there is nothing for a translation table to key on. The
client would have to match on English prose — which breaks the moment
anyone edits a message, and silently.

## The rule already exists here — it was simply never applied to this class

This is not a new pattern to adopt. `CLAUDE.md` already states it as a
convention, and the codebase already follows it for outbound email:

> **A value shown to a recipient must not be a pre-rendered sentence.**
> `DueItem.reason` was English prose built in the monitor jobs; a monitor
> produces each item ONCE and the digest routes it to SEVERAL recipients
> whose languages differ, so the language is not knowable where the item
> is built. It is a descriptor now — `{ key, params }` resolved under
> `notificationEmail.digest.reason.*` at render time.

That is exactly class B, with the same reasoning: **the language is not
knowable where the string is authored.** A usecase does not know whether
its caller is the web app, a Bulgarian operator's phone, or a future SDK
consumer. The email path solved it; the error path and the payload
fields did not.

So the roadmap below is not "introduce descriptors". It is: **apply the
repo's own documented rule to the two places it was never applied, and
add the guard that would have caught the omission.**

## The mechanism already exists here, and is proven

Nothing needs inventing. Three pieces are already in the codebase:

**0. The convention, in `CLAUDE.md`, and a worked example.** `DueItem.reason`
above — English prose replaced by `{ key, params }` resolved at render
time, because a monitor produces the item once and several recipients
read it in different languages.

**1. `AppError` carries a per-error code.**

```ts
export class AppError extends Error {
    public readonly code: string;
}
```

It is already used with specific codes — `STALE_DATA`, `RATE_LIMITED` —
and the route serialiser puts it on the wire (`payload.error.code =
error.code`). It is used this way at **5 call sites out of ~382**. The
capability is there; it is simply not the default.

**2. The translate-or-fall-back rule is written and shipping.**

`src/lib/grain/uncertainty.ts`:

```ts
export function explainRefusal(code, params, fallbackEnglish, translate) {
    if (isKnownRefusalCode(code)) return translate(`refusal.${code}`, params ?? {});
    return fallbackEnglish;
}
```

The calculator's net-worth refusals already work exactly this way on the
web, with four codes and Bulgarian strings in `messages/bg.json`. **The
English string stays** as the fallback for an unrecognised code, so a new
code degrades to English rather than to blank — which is the property
that makes incremental adoption safe.

So the work is: apply an existing, proven pattern to the error path, and
add the guard that keeps it applied.

## An adjacent class, recorded because it is the same shape

Not a translation problem — a FORMAT one — but it belongs here because it
fails identically: **a value authored in one representation and read by a
client that assumed another, invisible until something displayed it.**

`LogEntry.notes` is rich-text HTML. `journal.ts:245` stores
`sanitizeRichTextHtml(data.notes)`, the usecase docblock says "title →
plain text, notes → rich-text HTML", and the web renders it through
`dangerouslySetInnerHTML`. The iOS app displayed it for the first time in
2026-09 and printed the tags:

```
Бележки
<p>Sample input-application record.</p>
```

Measured on live data: of the entries carrying notes, **2 of 2 contain
HTML**. That is the format, not an outlier. It surfaced only when a
screen finally displayed the field — `JournalRow` shows title, type, date
and status and never touched it. **The first client to display a field is
the first chance to learn what is in it.**

Two consequences worth keeping, both measured against the real sanitiser:

- **A literal `<` is escaped, not lost.** `температура < 5` stores as
  `температура &lt; 5`, so the server is safe — but any client that
  flattens the HTML must DECODE ENTITIES or it shows `&lt;` on screen.
  `htmlNotesToPlainText` (the ДНЕВНИК path) already does.
- **Newlines survive storage and collapse on render.** `ред едно\nред
  две` passes the sanitiser unchanged, then renders as one line under
  `prose` (no `whitespace-pre-line`). A multi-paragraph note typed on a
  plain-text client is stored faithfully and displayed as a run-on
  paragraph on the web — both clients defensible, the record different in
  each.

The resolution is the same principle as the rest of this document: the
field has a declared representation, so **the producer emits it** rather
than each consumer guessing. Normalising server-side would mean deciding
whether a `\n` inside an HTML field is a paragraph break, and applying
that guess retroactively to rows of a legally-filed register.

## Roadmap

### Phase 1 — stop the bleeding (the guard comes first)

Do this **before** translating anything. Otherwise the backlog is
refilled while it is being drained.

1. ~~Widen the hard-coded-string scan to `src/app-layer/` and `src/lib/`,
   counting user-facing throws~~ — **DONE**:
   `tests/guards/no-server-authored-user-copy.test.ts`, a separately
   ratcheted class, the same way config props were split from JSX rather
   than folded into one inflated number.
2. ~~Baseline it at the measured count.~~ **DONE** — 530, now 502, with a drift
   sentinel so slack cannot accumulate and a positive control so a broken
   walk cannot read as a clean repo. A throw carrying a CODE is exempt,
   so the ratchet rewards the migration rather than only forbidding
   growth.
3. Give `badRequest` / `notFound` / `forbidden` / `conflict` an optional
   `code` parameter. Optional is deliberate: a required one is a 382-site
   change that cannot be reviewed.

**Done when** a new `badRequest('English sentence.')` without a code
fails CI, and the existing 382 do not.

### Phase 2 — the paths a farmer actually walks

Not alphabetically, and not all 382. Codes and Bulgarian strings for the
errors reachable from the screens the product is for:

- journal entry create / edit (the legally-filed register)
- field operations and spray recording
- locations and parcels
- exchange listings and inquiries
- the grain calculator

Each becomes `code` + `params` + the English left in place as fallback.

**Done when** a Bulgarian operator can hit every validation error on
those paths and see Bulgarian.

### Phase 3 — burn down class A

The 17 JSX strings, then the 201 config props. Mechanical, reviewable in
batches, and the ratchet already proves progress. Lowest risk of the
three phases, which is why it is last, not first.

### Phase 4 — the phone

Once class B carries codes, `agrent-ios` needs the same rule: a Swift
`code → Bulgarian` map with the server's English as fallback. PARITY.md
Gap 1 is the first instance and the natural pilot.

Shape and location of that map are the iOS side's call — whoever
maintains it should choose where it lives.

## What makes it airtight, as opposed to merely fixed

One sentence: **a translation is airtight when adding untranslated text
fails a test, not when the current text is translated.**

Today classes A and C have that property and class B does not. Every
guard passing while a Bulgarian user reads English is the proof. So the
order matters — Phase 1 before Phase 2 — and the measure of success is
not "382 → 0" but "the number can no longer rise without someone
noticing".

Two standing traps worth naming, because both have already been paid for
here:

- **A guard that covers almost the right population reads exactly like
  one that covers all of it.** The contracts-modal case is the repo's own
  example. When widening a scan, print the count before and after.
- **A code that is a category is not an identity.** `VALIDATION_ERROR`
  across 152 messages cannot be translated. If a code is being added so
  something can be translated, it has to be specific enough to key on.
