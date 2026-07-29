# 2026-07-29 — Escaping at the sink, and RLS for the marketplace's private half

**Commit:** _(this PR)_ — first of the Exchange roadmap.

The Exchange is the one surface in the product with no RLS safety net, by
design: tenants must read each other's offers. Two consequences of that design
had gone unexamined.

## 1. Sanitising at the source is not escaping at the sink

`inquiry-email.ts` interpolated the inquirer's message straight into email
HTML. The message *is* sanitised — `sanitizePlainText` at `exchange.ts:228` —
but that function **decodes entities by design**, and
`tests/unit/security/sanitize.test.ts:192-198` pins the behaviour deliberately,
on the rationale that a plain-text consumer is safe.

An HTML template is not a plain-text consumer. The round trip is the whole bug:

| stage | value |
|---|---|
| typed by the inquirer | `&lt;a href="https://evil/"&gt;Reset your password&lt;/a&gt;` |
| after `sanitizePlainText` | `<a href="https://evil/">Reset your password</a>` |
| interpolated into HTML | a working anchor |

Email is the one channel the Exchange crosses the tenant boundary on. So an
EDITOR in any tenant could deliver arbitrary anchors or remote images — from
the platform's own signed domain — into another tenant's OWNER/ADMIN inbox.
Credential phishing and read-receipt/IP disclosure, neither of which needs a
`<script>` tag to work.

**`sanitizePlainText` is unchanged.** It is correct for its documented purpose
and other callers depend on the decoded form. Tightening it to fix one template
would have broken those callers and still left the next template unprotected.
The fix is at the sink, and the guardrail is what makes it stay fixed.

### The sweep found this is a class

| site | what was raw |
|---|---|
| `inquiry-email.ts` | `message`, `commodity`, `side`, `quantityTonnes`, `inquiriesUrl` |
| `invite-email.ts` | `inviter`, `spaceName`, `roleLabel`, `acceptUrl` |
| `templates.ts` / `digest-templates.ts` | 14 sites, mostly `link` into an `href` |

`invite-email.ts` is worth calling out: an invitation reaches someone who is
**not yet a member**, so they have no prior trust relationship with the sender
and every reason to click.

Everything is escaped now, including values that look safe today. Whether
`commodity` is attacker-controlled is a property of upstream code that can
change, and a template with a mix of escaped and unescaped holes teaches the
next editor the wrong rule.

### One definition, not three

`escapeHtml` had three copies (`templates.ts`, `digest-templates.ts`,
`RichTextEditor.tsx`). Two drifting copies is how one ends up missing a
character class. The notification/email pair now share
`src/lib/security/escape-html.ts`, which additionally escapes `'` — harmless in
the existing double-quoted contexts, and correct the day someone writes a
single-quoted attribute. `RichTextEditor.tsx` keeps its own: different context,
different consumer, not in the guarded set.

## 2. `ExchangeInquiry` had no second layer

`ExchangeInquiry` holds private buyer↔seller messages and keys on
`inquirerTenantId` — a plain FK, deliberately not a `tenantId` RLS column. The
rls-coverage ratchet builds its inventory from models *with* a `tenantId`, so
this table sat outside it. `grep -c "Exchange"` on that file returned **0**,
while migration `20260323180000` grants `app_user` full DML on every table. One
forgotten `where` in a future repository method would have read every tenant's
private messages, with no DB-side backstop and nothing watching.

Its structural twin `PromotionLead` got exactly this treatment three weeks
earlier. Same shape, one real difference: **a lead has one party, an inquiry
has two.** The inquirer wrote it; the seller owns the listing and must read and
respond. So the policy is a disjunction, with the seller side resolved through
the listing:

```sql
USING/WITH CHECK (
    "inquirerTenantId" = current_setting('app.tenant_id', true)::text
    OR EXISTS (SELECT 1 FROM "ExchangeListing" l
               WHERE l."id" = "ExchangeInquiry"."listingId"
                 AND l."sellerTenantId" = current_setting('app.tenant_id', true)::text)
)
```

That two-party shape is why the behavioural suite asserts the **seller** can
read an inquiry written by someone else. A single-equality policy would pass a
naive isolation test while silently emptying every seller's inbox.

## Files

| File | Role |
|---|---|
| `src/lib/security/escape-html.ts` | new — the single `escapeHtml` definition |
| `src/lib/email/inquiry-email.ts` | escaped at the sink; the reported flag |
| `src/lib/email/invite-email.ts` | same pattern, found by the sweep |
| `src/app-layer/notifications/{templates,digest-templates}.ts` | local copies removed, 14 sites escaped |
| `tests/guardrails/html-template-escaping.test.ts` | new — the class-level ratchet |
| `prisma/migrations/20260728120000_exchange_inquiry_rls/` | FORCE + two-party policy + bypass |
| `prisma/schema/exchange.prisma` | header corrected — the two tables differ now |
| `tests/guardrails/rls-coverage.test.ts` | inquiry registered; listing exempted with a reason |
| `tests/integration/exchange-inquiry-rls.test.ts` | new — 7 behavioural cases |

## Decisions

- **`ExchangeInquiry.message` is NOT encrypted.** Two structural reasons, not a
  preference. The Epic B manifest keys by **field name**, and `message` is
  carried by `Notification` / `ExchangeInquiry` / `InsuranceLead` /
  `PromotionLead` — adding `PromotionLead: ['message']` once already wrote
  ciphertext into this very column, which is why
  `tests/unit/encryption-fanout-model-resolution.test.ts` pins all four out and
  why `PromotionLead` uses the unique name `requestMessage`. Separately, the
  per-tenant DEK model assumes one owning tenant, which a two-party row does
  not have: encrypting under the inquirer's DEK makes the row unreadable to the
  seller. That test is left untouched.

- **One policy, not per-command policies.** Per-command policies would tighten
  the residual below, but multiple policies on the same command are OR'd by
  PostgreSQL — the permissive-sibling seam Epic D.1 documents. One policy
  carrying the whole predicate has no such seam.

- **The residual is stated in the migration.** `WITH CHECK` must admit the
  seller, because an UPDATE's `WITH CHECK` runs against the new row and
  `respondToInquiry` is a seller-side status update. So a seller with direct
  `app_user` SQL could insert a fabricated inquiry on their own listing
  attributed to another tenant. Reaching that requires app-level RCE, at which
  point this policy was never the control. The hole it *does* close — a missing
  `where` exposing every tenant's messages — is the one that happens by
  accident.

- **`ExchangeListing` stays global, as an explicit exemption.** Cross-tenant
  readability is the product. It is now listed in `GLOBAL_BY_DESIGN_MODELS`
  with a written reason and a staleness check that fails if anyone later adds
  RLS to it, so the next reader finds a decision rather than an omission.

- **The guardrail's allowlist admits only two reasons** — the value is numeric,
  or it is an already-escaped fragment from the same guarded set. "Unlikely to
  be user-supplied" is not admissible, because that is exactly what was assumed
  about the inquiry message.
