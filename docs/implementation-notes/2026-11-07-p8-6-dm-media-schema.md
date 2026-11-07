# 2026-11-07 — P8.6 schema stage: direct-message photos

**Commit:** `<pending> feat(social): DM photo columns, and body becomes nullable`

## Design

Schema only — P8's rule ships tables one release before the code that writes
them, as P8.1 and P5.1 did. Two owner rulings settled first, because both are
expensive to change after rows exist.

```
DirectMessage
  body             String  →  String?     ← ruling: a photo alone is a message
  + attachmentKey    String?              ← ruling: ONE photo per message
  + attachmentMime   String?
  + attachmentBytes  Int?
  + attachmentSha256 String?
  + CHECK (deletedAt IS NOT NULL OR body IS NOT NULL OR attachmentKey IS NOT NULL)
  + partial index on attachmentKey WHERE NOT NULL
```

## Decisions

- **`body` is nullable** (owner ruling 2026-11-07). The alternative needing no
  migration — keep NOT NULL and store `''` — was rejected: a NOT NULL column
  that permits the empty string says nothing, and it leaves two spellings of
  "no text". Three things make the widening safe, each checked:
  `encryption-middleware` returns early on null on the encrypt path AND both
  decrypt paths; `DirectMessageView.body` and `MessageBubbleProps.body` were
  already `string | null` because a deleted message is presented as null; and
  the previous image cannot create a null-body row (its schema requires
  `body` min(1)) and renders one as an empty bubble rather than crashing — so
  an image rollback degrades a photo-only message instead of breaking the
  screen.

  Note the accident of history this leaves: `deleteDirectMessage` writes `''`,
  so NULL now means "photo-only" and `''` means "retracted". Read `deletedAt`,
  never the emptiness of the field.

- **One photo per message** (owner ruling), so columns rather than a
  `DirectMessageAttachment` link model. Several photos are several messages,
  which is what WhatsApp and Telegram do.

- **`LogEntryFile` could not be reused, and that decides the upload class.**
  The in-repo attachment precedent links to `FileRecord`, whose `tenantId` is
  NOT NULL — and a direct message has no tenant. Inventing one (the sender's
  current farm) would file a person-scoped photo as a farm record and then hide
  it from a recipient in a different tenant, since `FileRecord` is RLS-scoped
  by tenant. So a DM photo is the **record-less** upload class: `scanOrRefuse`
  BEFORE the write, because there is no download gate to defer to, and an
  egress route that authorises by **participation**. The code stage owes both.

- **A CHECK, not just a usecase rule.** "Text or a photo" lives in the one
  place that survives a bug in the usecase. The `deletedAt` arm is
  load-bearing: the code stage must clear `attachmentKey` on delete so a
  retracted photo stops being served, and a deleted photo-only message would
  then have nothing left — without that arm the database would refuse the
  clearing and the deletion would fail rather than the photo stopping.

- **`attachmentKey` is NOT encrypted**, which is `FileRecord.pathKey`'s call:
  an opaque locator is not content, and encrypting it would make the egress
  route decrypt on every byte served. It needed an `audit-redaction-covers-the-schema`
  entry as credential-shaped — given its own reason rather than joined to the
  `pathKey` / `storageKey` group, whose stated reason is "a stable slug chosen
  by the tenant" and describes neither.

## The link-card columns are NOT here, and a guard is why

They were, in the first draft — `linkUrl`, `linkTitle`, `linkDescription`,
`linkImageKey`, `linkFetchedAt`, with the two text columns in
`ENCRYPTED_FIELDS` because what somebody chose to SHARE privately is as
revealing as what they typed about it.

`sanitize-rich-text-coverage` refused that, correctly. Declaring a field
encrypted puts it in that guard's population, and the guard requires the field
to be sanitised BY NAME at its write path — `RICH_TEXT_COVERAGE` already points
`DirectMessage` at `direct-messages.ts`, which P8.2 made a live writer. A
schema-only stage cannot discharge that; `SEAM_COVERED` verifies a seam that
exists rather than promising one.

Shipping the columns and leaving them OUT of the manifest until the code stage
is worse in the direction that matters: third-party text would reach a column
nothing had decided to encrypt, with only a migration comment holding the
obligation. So the link-card columns land **with** their writer, where the
manifest entry and the `sanitizePlainText` call are one diff.

That is a weaker reading of "schema a release ahead", deliberately: the rule
exists so a NEW TABLE precedes its writer and a rollback stays safe, and an
additive nullable column on an existing table carries neither risk.

## Two false negatives worth recording

- **I probed the wrong database.** Checking that the CHECK constraint had
  applied, a `pg` client on `DATABASE_URL_TEST` reported ABSENT — while the
  suite asserting the refusal was passing with SQLSTATE 23514. Both cannot be
  true. jest's base is a per-checkout `agri_saas_test_<hash>`; there were three
  such databases and only `agri_saas_test_cde5cee23` had the migration. The
  contradiction is what caught it: a single ABSENT reading, believed, would
  have sent me to debug a migration that had applied fine.

- **The fixture wrote through a bare client and asserted its own plaintext.**
  The at-rest encryption assertions used `new PrismaClient(...)`, which carries
  no `$extends` encryption layer, so nothing was ever encrypted and the failure
  read as a broken manifest rather than a broken fixture. The suite now holds
  two clients with the split written down: the extended one writes, a bare one
  reads columns back.
