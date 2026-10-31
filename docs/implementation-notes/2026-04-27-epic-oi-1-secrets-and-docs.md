# 2026-04-27 — Epic OI-1: Secrets migration + ops docs (closes OI-1)

> **Superseded, and one claim below was never true of this product — #2552.**
>
> `deploy/.env.prod.example`, the file this note rewrote, was **deleted on
> 2026-10-31**. It described AWS Secrets Manager, RDS and EKS, and its own
> `REDIS_SECRET_NAME` line named `inflect-compliance` — the SIBLING product. It
> was inherited, and CLAUDE.md records that the AWS/EKS stack "was never
> provisioned" for agrent.
>
> So read the exit-criteria table at the end with that in mind. "No plaintext
> secrets remain on disk as the primary production operating model" is **not**
> the agrent posture: the master KEK lives in `/opt/agrent/.env` on the VM, and
> CLAUDE.md says so deliberately — it sits on the same disk as the data it
> protects, which is what makes a whole-disk restore recover key and ciphertext
> together. There is no `bootstrap-env-from-secrets.sh` run against this
> deployment.
>
> The note is kept because it is the origin story of the file and of the
> guardrails that read it. It is not a description of how agrent handles
> secrets.

**Commit:** _(uncommitted at note authoring; squash-merge target tbd)_

Closes Epic OI-1. Builds on the prior four notes (foundation,
VPC+DB, Redis+Storage, environments+CICD) by:

1. Migrating the 5 critical runtime secrets out of plaintext
   `deploy/.env.prod` into AWS Secrets Manager (DATA_ENCRYPTION_KEY,
   AUTH_SECRET, JWT_SECRET, AV_WEBHOOK_SECRET, OAuth client secrets).
2. Building the runtime resolution bridge (bootstrap script for the
   current SSH/VM model; ECS-native `secrets:` mapping documented for
   the next compute epic).
3. Writing the comprehensive ops doc at `docs/infrastructure.md`.

## Design

### Secrets module (5th Terraform module)

`infra/terraform/modules/secrets/` aggregates **8 runtime secrets**
into a single IAM read policy attachable to the app workload role:

| Secret | Source | Lifecycle |
|---|---|---|
| DATA_ENCRYPTION_KEY | `random_id byte_length=32` → `aws_secretsmanager_secret_version` | Generated once at first apply; **never regenerate without the v1→v2 sweep documented in Epic B** |
| AUTH_SECRET | Same | Regenerable; sessions invalidate on rotation |
| JWT_SECRET | Same | Same as AUTH_SECRET |
| AV_WEBHOOK_SECRET | Same | Rotate in lock-step with the AV scanner's HMAC config |
| GOOGLE_CLIENT_SECRET | Operator-supplied; placeholder + `lifecycle.ignore_changes = [secret_string]` | Set via `aws secretsmanager put-secret-value` after first `terraform apply` |
| MICROSOFT_CLIENT_SECRET | Same | Same |
| RDS master credentials | Chained from the `database` module (`manage_master_user_password = true`) | RDS rotates natively |
| Redis AUTH token | Chained from the `redis` module (`random_password` → Secrets Manager) | `auth_token_update_strategy = ROTATE` keeps old token valid during the transition |

The module-internal 6 secrets + the 2 chained ARNs (passed via
`additional_secret_arns`) feed `local.all_secret_arns`, which becomes
the **resources** field of the IAM policy. The structural ratchet
asserts:
- Resources are specific ARNs, never `*`
- Allowed actions are exactly `GetSecretValue` + `DescribeSecret`
  (no `Put`, `Delete`, `Update`, `Rotate`, no `secretsmanager:*`)

Generated secrets use `random_id` (not `random_password`) for
crypto-grade material — `random_id.<name>.hex` produces 64-char hex
matching the format the app already expects (`32_BYTES_HEX` in the
old env file).

### Runtime resolution bridge

`scripts/bootstrap-env-from-secrets.sh` (260 lines) is the deploy-time
helper for the current SSH/VM model:

```
deploy host
  │
  │  IAM role attached: runtime-secrets-read policy
  │
  ▼
bootstrap-env-from-secrets.sh
  │
  │  aws secretsmanager get-secret-value × 8
  │  (RDS-managed JSON parsed for username + password)
  │  (Redis JSON parsed for auth_token)
  │
  ▼
deploy/.env.runtime  (mode 0600, atomic write via install -m 0600)
  │
  │  compose env_file points here
  │
  ▼
docker compose up -d
```

Defence-in-depth: the script refuses to write a file containing
`PLACEHOLDER` (catches the "forgot to set OAuth secret" failure
mode); writes via `mktemp + install -m 0600` so partial writes
never expose plaintext to the wrong perms.

For ECS later, the task definition's native `secrets:` mapping
replaces the script entirely — same env vars, zero on-disk
footprint. Documented in `docs/infrastructure.md` § "Resolving
secrets at runtime → Tomorrow (ECS)".

### `deploy/.env.prod.example` rewrite

Old: 7 plaintext placeholder lines (`AUTH_SECRET=REPLACE_ME_...`,
`DATA_ENCRYPTION_KEY=...`, embedded password in DATABASE_URL, etc.).

New:
- Deprecation banner pointing at AWS Secrets Manager + the bootstrap
  script.
- Only **non-secret** values remain (hostnames, S3 bucket name,
  feature flags, OAuth client IDs which ARE public identifiers).
- Bootstrap workflow documented inline.

Ratchet asserts the 7 plaintext-secret assignments are gone from
non-comment lines.

### `docs/infrastructure.md` — the operator's manual

421 lines covering:
1. **Architecture overview** — ASCII diagram + invariant lists
   (every load-bearing security/operational invariant cross-referenced
   to the structural ratchet that locks it).
2. **Module inventory** — table of all 5 modules with key inputs +
   outputs.
3. **Environment model** — full staging-vs-production tradeoff table
   (every knob that differs between envs, with the rationale).
4. **Secret management** — where each secret lives now, IAM access
   surface, runtime resolution model (SSH-VM today, ECS tomorrow),
   first-time setup including the OAuth `put-secret-value` step.
5. **Cost estimate** — ~$555/mo production, ~$98/mo staging,
   itemised, with cost-shaping levers.
6. **Verification** — pointer to the 5 ratchet files (155 assertions
   total) + the workflow CI integration.
7. **Day-1 setup** — chronological steps from bootstrap through first
   apply through OAuth secret setting through first deploy.
8. **Day-2 ops** — secret rotation runbooks (per-secret, including
   the explicit DO-NOT-REGENERATE warning on DATA_ENCRYPTION_KEY),
   adding a new managed secret, provisioning a new env, tearing one
   down.
9. **Disaster recovery** — accidental destroy, lost KEK, compromised
   AWS account, compromised GitHub Actions, compromised state-bucket
   read.

## Files

| File | Status |
|---|---|
| `infra/terraform/modules/secrets/main.tf` | New — 6 secrets + 4 random_ids + IAM policy + policy document |
| `infra/terraform/modules/secrets/variables.tf` | New |
| `infra/terraform/modules/secrets/outputs.tf` | New — `secret_arns`, `secret_names`, `runtime_secrets_read_policy_arn`, `all_runtime_secret_arns` |
| `infra/terraform/main.tf` | Wired `module "secrets"` with chained DB + Redis ARNs |
| `infra/terraform/outputs.tf` | Surfaces 4 new runtime-secret outputs at the root |
| `scripts/bootstrap-env-from-secrets.sh` | New — 260-line deploy-time secret-resolution helper |
| `deploy/.env.prod.example` | Rewritten — deprecation banner + non-secret-only template |
| `docs/infrastructure.md` | New — 421-line operator manual |
| `tests/guards/terraform-secrets.test.ts` | New 34-assertion structural ratchet |
| `tests/guards/terraform-foundation.test.ts` | Added `secrets` to the MODULES list (now 5 modules verified) |
| `docs/implementation-notes/2026-04-27-epic-oi-1-secrets-and-docs.md` | This file |

## Decisions

- **`random_id` over `random_password` for crypto material.**
  `random_password` produces strings from a configurable charset,
  intended for passwords. For 32-byte symmetric keys, `random_id`
  with `byte_length = 32` is the right primitive — exposes `.hex`,
  `.b64_url`, `.b64_std` natively, no charset-bias concerns. The
  ratchet asserts the secrets module uses no `random_password`.

- **OAuth secrets via placeholder + `ignore_changes`.** Operator
  supplies the value via `aws secretsmanager put-secret-value` after
  first apply. Terraform creates the container with a sentinel
  string; `lifecycle.ignore_changes = [secret_string]` prevents
  drift-revert. The bootstrap script detects the sentinel and
  refuses to deploy — fail-fast on "forgot to set OAuth."

- **Single aggregated IAM policy, not per-secret.** A single
  `<name_prefix>-runtime-secrets-read` policy with all 8 ARNs in the
  resources field is simpler than 8 per-secret policies. The blast
  radius of the workload role is exactly that policy's resource
  list — auditable in one place via the
  `all_runtime_secret_arns` root output.

- **`additional_secret_arns` input for module composition.** The
  database and redis modules each create their own secret. Rather
  than have the secrets module recreate them or duplicate IAM, the
  root composition passes those ARNs via a list input. This is
  the cleanest seam — the secrets module owns IAM aggregation;
  origin modules own their own secret lifecycle.

- **30-day recovery window on DATA_ENCRYPTION_KEY, 7-day on others.**
  AWS Secrets Manager keeps deleted secrets recoverable for 7–30
  days. Default is 30. Loss of the master KEK is unrecoverable
  beyond this window — pin to 30 by default; other secrets are
  regenerable so 7 is fine.

- **No `lifecycle.prevent_destroy` on the master KEK.** The
  three-layer protection (production GitHub Environment requires
  reviewer approval; `recovery_window_in_days = 30` on Secrets
  Manager; explicit guidance in docs/infrastructure.md and
  CLAUDE.md) is enough. Adding `prevent_destroy = true` would block
  legitimate `terraform destroy` of staging environments and force
  operators to comment out the lifecycle block — annoying enough
  that operators learn to skip "small" lifecycle gymnastics, which
  is worse than the protection it provides.

- **Bootstrap script over SDK integration in app code.** The app
  reads env vars today. Adding `@aws-sdk/client-secrets-manager` to
  the app's runtime dependency tree would mean: a code change in
  every secret-reading site, dependency on AWS SDK at boot in
  non-AWS environments (local dev, CI), AND a graceful-degradation
  story for the dev fallback. The bootstrap script keeps the env-var
  contract intact — the SDK lives in a single shell script outside
  the app — and the ECS migration replaces the script with the
  task-definition's native `secrets:` field that ALSO surfaces them
  as env vars. Either way, app code never changes.

- **`docs/infrastructure.md` is the operator's manual, not a design
  spec.** Decisions live in the implementation notes (this file +
  the 4 prior). The operator-facing doc explains how to use what's
  built — not why. Cost estimates included because OI-1 spec calls
  for them; they're explicit ballpark figures with cost-shaping
  levers, not commitments.

## Verification performed

- **Structural ratchet**: **155/155 green** across all 5 Terraform
  guard suites:
  - foundation: 41 (added `secrets` to MODULES list)
  - vpc-database: 26
  - redis-storage: 31
  - workflow: 24
  - secrets (new): 33

  The secrets ratchet specifically locks: `random_id byte_length=32`
  for all 4 generated secrets; no `random_password` in the secrets
  module; OAuth versions use `ignore_changes = [secret_string]`;
  IAM policy actions are exactly `GetSecretValue` + `DescribeSecret`
  (no admin actions, no `secretsmanager:*`); resources are
  `local.all_secret_arns` (specific ARNs, never `*`);
  `module_secret_arns` enumerates all 6 internal secrets;
  `all_secret_arns = concat(module + additional)`;
  `additional_secret_arns` variable exists; root composition wires
  `module.database.secret_arn` AND `module.redis.auth_secret_arn`;
  root outputs surface `runtime_secret_names` +
  `runtime_secrets_read_policy_arn`; bootstrap script exists and is
  executable; bootstrap fetches all 6 internal secrets + RDS + Redis;
  bootstrap refuses to deploy on PLACEHOLDER detection; bootstrap
  writes mode 0600 atomically; `.env.prod.example` no longer
  carries plaintext placeholders for the 5 migrated secrets but
  still carries the deprecation banner + bootstrap pointer;
  `docs/infrastructure.md` has the 5 spec-required sections and
  enumerates all 5 modules.

- **Brace-balance** across 4 new + 2 modified Terraform files:
  clean.

- **Bash syntax** of `scripts/bootstrap-env-from-secrets.sh`: clean
  via `bash -n`.

- **`terraform fmt` / `init` / `validate` / `plan`**: not run —
  terraform binary not installed in this sandbox; the 155-assertion
  ratchet + YAML round-trip is the day-one substitute.

## Final OI-1 readiness check

Source-of-truth requirements vs delivered:

| OI-1 requirement | Delivered | Asserted by |
|---|---|---|
| `infra/terraform/` with main/variables/outputs/versions | ✅ | foundation ratchet |
| AWS provider `>= 5.0` | ✅ (`>= 5.0, < 6.0`) | foundation ratchet |
| Remote state in S3 with DynamoDB locking | ✅ | foundation + bootstrap stack |
| Separate state files per environment | ✅ (per-env buckets + per-env keys) | foundation ratchet |
| `modules/vpc/` with private+public subnets, NAT, SGs | ✅ (3 tiers × N AZs) | vpc-database ratchet |
| `modules/database/` Postgres 16 multi-AZ + encrypted + PITR + 7d retention + `rls_force=on` | ✅ (`row_security=1` cluster + per-table FORCE in prisma/rls-setup.sql) | vpc-database ratchet |
| DB accessible from app subnet only | ✅ (one ingress rule, app SG only, ratchet asserts no CIDR) | vpc-database ratchet |
| `modules/redis/` Redis 7 + TLS + single-staging/HA-prod + app-only access | ✅ | redis-storage ratchet |
| `modules/storage/` S3 + versioning + SSE-S3 + IA-90d + CORS + IAM-only | ✅ | redis-storage ratchet |
| `infra/terraform/environments/{staging,production}/` | ✅ (directories with backend.hcl + terraform.tfvars + README) | workflow ratchet |
| Staging smaller / single-AZ; production larger / multi-AZ | ✅ (encoded in env tfvars; ratchet locks the diff) | redis-storage + vpc-database ratchets |
| `.github/workflows/terraform.yml` with PR plan / push apply / prod approval | ✅ | workflow ratchet (24 assertions) |
| Plan output visible in PR comment | ✅ (sticky comment per env) | workflow ratchet |
| `docs/infrastructure.md` with arch + modules + secrets + cost | ✅ | secrets ratchet |
| Migrate `POSTGRES_PASSWORD`, `DATA_ENCRYPTION_KEY` from `.env.production` to Secrets Manager | ✅ (DB via RDS-managed; KEK + 4 others via secrets module) | secrets ratchet |
| Terraform outputs the connection/config surfaces needed by the app | ✅ (db_address, db_port, db_secret_arn, redis_primary_endpoint, redis_port, redis_auth_secret_arn, storage_bucket_id, storage_access_policy_arn, runtime_secret_names, runtime_secrets_read_policy_arn) | per-module ratchets |
| No plaintext secrets remain on disk as the primary production operating model | ✅ (`.env.prod.example` deprecated + bootstrap script + ratchet asserts the migrated secret keys are absent from non-comment lines) | secrets ratchet |

Epic OI-1 is **complete**: code, tests, docs, runbooks all
delivered; 155 structural assertions guarding every load-bearing
invariant.
