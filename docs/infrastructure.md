# Infrastructure (Epic OI-1) — HISTORICAL

> **This describes infrastructure that no longer exists.** The Terraform/AWS
> stack was removed in #808: `infra/terraform/`, `terraform.yml` and
> `deploy.yml` are all deleted. Nothing below is provisioned, and none of the
> runbooks here can be executed.
>
> **The real production path is `deploy/`** — `deploy/apply.sh` with
> `deploy/docker-compose.vm.yml` onto a GCP VM. See `docs/deployment.md`.
>
> Kept as design history for Epic OI-1, not as an operator's manual. It was
> retired because the AWS side never ran: the staging GitHub Environment held
> no secrets, so every `Apply` failed at the OIDC credential step; `deploy.yml`
> never ran once; and production holds only GCP credentials.

The (former) inflect-compliance platform was provisioned via Terraform on AWS.
This document was the operator's manual — architecture, modules,
environments, secrets, costs, and the day-1 + day-2 runbooks.

> **Companion docs**
> - `infra/terraform/README.md` — Terraform layout + commands
> - `infra/terraform/environments/{staging,production}/README.md` — env-scoped setup
> - `infra/terraform/bootstrap/README.md` — one-shot state-bucket setup
> - `docs/epic-b-encryption.md` — DATA_ENCRYPTION_KEY rotation runbook
> - `docs/deployment.md` — application delivery (deploy.yml)
> - `docs/implementation-notes/2026-04-27-epic-oi-1-*.md` — design history

## Architecture overview

```
                 ┌──────────────────────────────────────────────────┐
                 │                  AWS Account                     │
                 │                                                  │
   internet ─▶ IGW                                                  │
                 │                                                  │
                 │   ┌── public  /24 × N AZs ───────────────┐       │
                 │   │   ALB                                │       │
                 │   │   NAT Gateway(s)                     │       │
                 │   └─────────────────┬────────────────────┘       │
                 │                     │                            │
                 │   ┌── private-app  /24 × N AZs ──────────┐       │
                 │   │   App workload (ECS/EC2)             │       │
                 │   │   ElastiCache Redis 7 (TLS, AUTH)    │       │
                 │   └─────┬──────────────┬─────────────────┘       │
                 │         │              │                         │
                 │         │ (5432)       │ IAM (S3 + Secrets)      │
                 │         ▼              ▼                         │
                 │   ┌── private-db  /24 × N AZs ──┐                │
                 │   │   RDS Postgres 16           │                │
                 │   │   (multi-AZ in production)  │                │
                 │   └─────────────────────────────┘                │
                 │                                                  │
                 │   AWS-region-global: S3 bucket (SSE-S3, IA-90d)  │
                 │   AWS-region-global: AWS Secrets Manager         │
                 │     - DB master credentials (RDS-managed)        │
                 │     - Redis AUTH token                           │
                 │     - DATA_ENCRYPTION_KEY (master KEK)           │
                 │     - AUTH_SECRET, JWT_SECRET (session+API)      │
                 │     - AV_WEBHOOK_SECRET                          │
                 │     - GOOGLE_CLIENT_SECRET (OAuth)               │
                 │     - MICROSOFT_CLIENT_SECRET (OAuth)            │
                 └──────────────────────────────────────────────────┘
```

**Networking invariants** (each enforced by structural ratchet):
- Database has `publicly_accessible = false` (hardcoded)
- Database SG ingress is from app SG only (no CIDR rule, exactly one rule)
- Redis has `transit_encryption_enabled = true` (hardcoded)
- Redis SG ingress is from app SG only
- private-db route table has no `0.0.0.0/0` route — DB tier never reaches internet
- S3 bucket has all four public-access-block flags `true` + deny-non-TLS bucket policy

**Workflow invariants** (in `.github/workflows/terraform.yml`):
- PRs touching `infra/terraform/**` show plans for both envs as sticky comments
- Push to main auto-applies staging
- Production apply is gated by the `production` GitHub Environment's required-reviewers protection
- Auth via OIDC (no long-lived AWS keys in the repo)

## Module inventory

```
infra/terraform/
├── modules/
│   ├── vpc/        — VPC + 3 subnet tiers × N AZs + ALB SG + app SG + NAT + flow logs
│   ├── database/   — RDS Postgres 16 + DB SG + parameter group (row_security=1, force_ssl) + RDS-managed master creds
│   ├── redis/      — ElastiCache Redis 7 + Redis SG + parameter group (maxmemory-policy=noeviction) + AUTH in Secrets Manager
│   ├── storage/    — S3 bucket (versioned, SSE-S3, IA-90d, CORS, deny-non-TLS, IAM access policy)
│   └── secrets/    — Aggregated runtime secrets in AWS Secrets Manager + IAM read policy
├── environments/
│   ├── staging/    — backend.hcl + terraform.tfvars + README.md
│   └── production/ — backend.hcl + terraform.tfvars + README.md
└── bootstrap/      — one-shot, local state, creates per-env state buckets + lock table
```

| Module | Resources created | Key inputs | Notable outputs |
|---|---|---|---|
| `vpc` | aws_vpc, aws_subnet × 3N, aws_internet_gateway, aws_nat_gateway × {1, N}, aws_route_table × N, aws_security_group {alb, app}, aws_flow_log + IAM | `cidr_block`, `az_count`, `single_nat_gateway`, `app_ingress_port` | `vpc_id`, `private_app_subnet_ids`, `private_db_subnet_ids`, `alb_security_group_id`, `app_security_group_id` |
| `database` | aws_db_subnet_group, aws_security_group, aws_db_parameter_group, aws_db_instance | `vpc_id`, `subnet_ids`, `app_security_group_id`, `engine_version`, `instance_class`, `multi_az`, `backup_retention_days` | `endpoint`, `address`, `port`, `db_name`, `secret_arn` (sensitive — RDS-managed master creds) |
| `redis` | aws_elasticache_subnet_group, aws_security_group, aws_elasticache_parameter_group, aws_elasticache_replication_group, random_password, aws_secretsmanager_secret + version, CloudWatch log groups | `vpc_id`, `subnet_ids`, `app_security_group_id`, `node_type`, `replicas_per_node_group` | `primary_endpoint_address`, `port`, `auth_secret_arn` (sensitive) |
| `storage` | aws_s3_bucket, aws_s3_bucket_versioning, aws_s3_bucket_server_side_encryption_configuration, aws_s3_bucket_public_access_block, aws_s3_bucket_lifecycle_configuration, aws_s3_bucket_cors_configuration (count-gated), aws_s3_bucket_policy, aws_iam_policy + optional role | `bucket_name`, `ia_transition_days`, `cors_allowed_origins`, `force_destroy` | `bucket_id`, `bucket_arn`, `bucket_regional_domain_name`, `access_policy_arn` |
| `secrets` | random_id × 4, aws_secretsmanager_secret × 6 + versions, aws_iam_policy | `additional_secret_arns` | `secret_names` (env-var → secret-name map), `runtime_secrets_read_policy_arn` |

Every module follows the canonical 3-file shape (`main.tf`,
`variables.tf`, `outputs.tf`) and accepts `tags` + `name_prefix`
inputs. Module shape is locked by `tests/guards/terraform-foundation.test.ts`.

## Environment model

Two environments shipped today: **staging** + **production**. Adding
a third (e.g. `dev` or `eu-prod`) requires a new directory under
`infra/terraform/environments/<name>/` plus a state bucket added to
the bootstrap stack's `var.environments` list.

| Knob | Staging | Production | Why |
|---|---|---|---|
| `vpc_az_count` | 2 | 3 | Min for RDS multi-AZ subnet group; prod tolerates AZ failure |
| `vpc_single_nat_gateway` | `true` | `false` | ~$32/mo savings per missing AZ vs HA egress |
| `db_instance_class` | `db.t4g.small` | `db.m6g.large` | Burstable in staging; sustained-perf in prod |
| `db_allocated_storage_gb` | 20 | 100 | + autoscaling to 100 / 1000 GB ceiling |
| `db_multi_az` | `false` | `true` | HA only in prod |
| `db_deletion_protection` | `false` | `true` | Allow staging re-create; protect prod |
| `db_skip_final_snapshot` | `true` | `false` | Accept staging loss-on-destroy; mandatory snapshot in prod |
| `db_backup_retention_days` | 7 | 14 | OI-1 floor 7; prod extends |
| `redis_node_type` | `cache.t4g.small` | `cache.t4g.medium` | |
| `redis_replicas_per_node_group` | 0 | 1 | HA + multi-AZ + automatic failover only in prod |
| `redis_snapshot_retention_days` | 1 | 7 | |
| `storage_force_destroy` | `true` | `false` | NEVER auto-destroy prod tenant evidence |
| `storage_cors_allowed_origins` | `["https://staging.example.com"]` | `["https://app.example.com"]` | Pre-signed-URL upload origins |

Every override is **explicit** in the env's `terraform.tfvars` —
nothing inherits silently from a module default. A reviewer reading
the env file sees the full posture.

## Secret management

OI-1 migrated production secrets out of plaintext on-disk env files
and into AWS Secrets Manager. The plaintext model (`deploy/.env.prod`
holding actual passwords, KEK, OAuth secrets) is **deprecated**.

### Where each secret lives now

| Secret | Provisioned by | Generated? | Rotation runbook |
|---|---|---|---|
| `POSTGRES_PASSWORD` | `database` module via `manage_master_user_password = true` (RDS-managed) | Yes (RDS) | RDS console → "Modify" → "Manage master credentials" → rotate, OR scheduled rotation via Secrets Manager |
| `REDIS_AUTH_TOKEN` | `redis` module via `random_password` → Secrets Manager | Yes (terraform) | `terraform apply` regenerates and rolls; `auth_token_update_strategy = ROTATE` keeps the old token valid during the transition |
| `DATA_ENCRYPTION_KEY` | `secrets` module via `random_id byte_length=32` | Yes (terraform) | **Never regenerate** without the v1→v2 sweep. Rotation runbook: `docs/epic-b-encryption.md` (set `DATA_ENCRYPTION_KEY_PREVIOUS`, deploy, run sweep, remove `_PREVIOUS`) |
| `AUTH_SECRET` (NextAuth) | `secrets` module | Yes (terraform) | Regenerate any time; existing sessions invalidate (one mass logout) |
| `JWT_SECRET` (API tokens) | `secrets` module | Yes (terraform) | Same as `AUTH_SECRET` |
| `AV_WEBHOOK_SECRET` | `secrets` module | Yes (terraform) | Regenerate + update the AV scanner's HMAC config in lock-step |
| `GOOGLE_CLIENT_SECRET` | `secrets` module (placeholder) | **No** — operator-supplied | Rotate in Google Cloud Console → `aws secretsmanager put-secret-value --secret-id ...-google-client-secret --secret-string '<new>'` → restart app |
| `MICROSOFT_CLIENT_SECRET` | Same | **No** — operator-supplied | Rotate in Entra Portal → `put-secret-value` → restart |

### IAM access surface

The `secrets` module emits **one** IAM policy
(`<name_prefix>-runtime-secrets-read`) that grants
`secretsmanager:GetSecretValue` + `secretsmanager:DescribeSecret`
on **specific ARNs only** — no `*` wildcard. The policy covers:

- The 6 secrets created by the secrets module
- The RDS-managed master credentials secret (passed via `additional_secret_arns`)
- The Redis AUTH secret (same)

Attach this policy to the app workload role. The structural ratchet
asserts no `*` wildcard appears in the resources field.

### Resolving secrets at runtime

**Today (SSH/VM deploy)**: `scripts/bootstrap-env-from-secrets.sh`
runs on the deploy host, fetches all 8 secrets via the AWS CLI, and
writes a 0600-mode `.env.runtime` file the compose stack consumes
via `env_file`. The file is regenerated before each deploy and never
copied off the host.

```bash
# On the deploy VM, after `terraform apply` completes:
./scripts/bootstrap-env-from-secrets.sh \
  --env-prefix inflect-compliance-production \
  --rds-secret <from terraform output db_secret_arn> \
  --redis-secret inflect-compliance-production-redis-auth \
  --db-host <from terraform output db_address> \
  --redis-host <from terraform output redis_primary_endpoint> \
  --s3-bucket <from terraform output storage_bucket_id> \
  --s3-region us-east-1 \
  --app-hostname app.example.com \
  --output deploy/.env.runtime

docker compose -f deploy/docker-compose.prod.yml up -d
```

The script is **idempotent and safe to re-run** — it overwrites
`.env.runtime` atomically, fails fast on missing secrets, refuses
to deploy if any OAuth placeholder is still un-filled.

**Tomorrow (ECS task definition)**: when compute migrates to ECS,
the bootstrap script becomes obsolete. The task definition's
native `secrets:` mapping resolves Secrets Manager values into env
vars at task launch with zero on-disk footprint:

```json
{
  "secrets": [
    { "name": "DATA_ENCRYPTION_KEY", "valueFrom": "arn:aws:secretsmanager:...-data-encryption-key" },
    { "name": "AUTH_SECRET",         "valueFrom": "arn:aws:secretsmanager:...-auth-secret" }
  ]
}
```

The runtime-secrets-read IAM policy is attached to the ECS task role
and the app process reads env vars exactly as it does today — no
SDK code change required in either model.

### Operator-supplied secrets — first-time setup

After the very first `terraform apply`, the OAuth secret containers
hold a placeholder (`PLACEHOLDER_set_via_aws_secretsmanager_put-secret-value`).
The bootstrap script REFUSES to deploy when it detects this, so
"forgot to set OAuth" fails fast with a useful message. To unblock:

```bash
# Google
aws secretsmanager put-secret-value \
  --secret-id inflect-compliance-production-google-client-secret \
  --secret-string '<google-oauth-client-secret-from-google-cloud-console>'

# Microsoft (Entra ID)
aws secretsmanager put-secret-value \
  --secret-id inflect-compliance-production-microsoft-client-secret \
  --secret-string '<microsoft-app-secret-from-entra-portal>'
```

Terraform's `lifecycle.ignore_changes = [secret_string]` on these
resources means a subsequent `terraform apply` will NOT drift-revert
the operator's value back to the placeholder.

## Cost estimate

Rough monthly figures, us-east-1, on-demand pricing, before data
egress and per-request charges. Real costs depend on traffic.

### Production (~$555/month)

| Component | Spec | Cost |
|---|---|---|
| 3 NAT Gateways | per-AZ HA | ~$130 |
| RDS Postgres | `db.m6g.large` multi-AZ + 100 GB gp3 | ~$304 |
| ElastiCache Redis | `cache.t4g.medium` × 2 nodes | ~$105 |
| S3 | 100 GB Standard with IA-90d transition | ~$3 |
| Secrets Manager | 8 secrets | ~$3 |
| CloudWatch logs | RDS + Redis + VPC flow logs | ~$10 |
| **Total** | | **~$555** |

### Staging (~$98/month)

| Component | Spec | Cost |
|---|---|---|
| 1 NAT Gateway | shared across AZs | ~$37 |
| RDS Postgres | `db.t4g.small` single-AZ + 20 GB | ~$27 |
| ElastiCache Redis | `cache.t4g.small` single-node | ~$25 |
| S3 | minimal | ~$1 |
| Secrets Manager | 8 secrets | ~$3 |
| CloudWatch logs | minimal retention | ~$5 |
| **Total** | | **~$98** |

### Cost-shaping levers (production)

If the bill needs to drop:
- **Reserved instances** for RDS and ElastiCache: ~30% saving for 1-year, ~50% for 3-year, no behavioural change.
- **Single NAT Gateway** in production (`vpc_single_nat_gateway = true`): saves ~$95/mo at the cost of egress losing one AZ's worth of redundancy. Acceptable for some compliance bars; not recommended.
- **Smaller DB instance**: `db.t4g.medium` (~$55/mo + multi-AZ doubling) cuts ~$200/mo if the workload tolerates burstable.
- **S3 Intelligent-Tiering** instead of explicit IA-90d: better fit for unpredictable access patterns; same ~$3 baseline.

If the bill needs to grow (ramping):
- **Read replica** for RDS: ~$150/mo for an additional `db.m6g.large` reader. Wire the app via `module.database.reader_endpoint` once it lands.
- **Performance Insights** retention extension: 731 days = paid tier; default 7-day is free.

## Verification

The full OI-1 stack is locked by **5 structural ratchet test files**
totalling **170+ assertions** that fail CI on regression:

| Ratchet | Assertions | Locks |
|---|---|---|
| `tests/guards/terraform-foundation.test.ts` | 40 | File presence; AWS provider `>= 5.0`; partial backend; per-env state isolation; bootstrap shape; module 3-file contract; secrets-hygiene scan over committed tfvars |
| `tests/guards/terraform-vpc-database.test.ts` | 26 | DB never publicly-accessible; storage-encrypted hardcoded; RDS-managed creds; ingress-from-app-only; private-db RT has no internet route; row_security=1 + rds.force_ssl in parameter group; postgres16 family; PITR mandatory |
| `tests/guards/terraform-redis-storage.test.ts` | 31 | Redis transit-encryption hardcoded; AUTH wired from random_password to Secrets Manager; ingress-only-from-app; redis7 family + maxmemory-policy=noeviction; HA toggles derive from replica count; S3 public-access-block all-on; SSE-S3 (not KMS); IA-90d lifecycle; CORS gated on origins (no wildcard); deny-non-TLS bucket policy; IAM policy always created |
| `tests/guards/terraform-workflow.test.ts` | 24 | Workflow YAML parses; PR plan + sticky comment per env; staging auto-applies on push; production gated by `environment: production`; OIDC; per-env concurrency; no plaintext AWS keys |
| `tests/guards/terraform-secrets.test.ts` | _(new)_ | DATA_ENCRYPTION_KEY generated via random_id 32-byte; OAuth secrets use ignore_changes; IAM policy uses GetSecretValue (not `*`); root composition wires DB + Redis ARNs into the secrets module |

Run all five together:

```bash
npx jest tests/guards/terraform-*.test.ts
```

`terraform fmt -check`, `terraform validate`, and `terraform plan` for
both envs run on every PR via `.github/workflows/terraform.yml` once
the IAM/OIDC trust + state buckets are wired up by an operator.

## Day-1 setup

One-time setup, by an admin operator with full AWS account access:

```bash
# 1. State backend (one-shot per AWS account).
cd infra/terraform/bootstrap
terraform init
terraform apply
# Capture state_buckets + lock_table_name from output for the next step.

# 2. Trust GitHub Actions OIDC.
# Create an IAM identity provider for token.actions.githubusercontent.com,
# then per-env IAM roles (staging + production) trusting:
#   repo:h0mele55/inflect-compliance:environment:<env>
# Attach permissions for: ec2:*, vpc:*, rds:*, elasticache:*, s3:*,
#                        iam:*, secretsmanager:*, kms:*, logs:*, sts:*,
#                        cloudwatch:*, dynamodb:* (for state lock)

# 3. Configure GitHub Environments in repo Settings → Environments:
#   - staging: secret AWS_ROLE_TO_ASSUME = arn:aws:iam::<acct>:role/<staging-role>
#   - production: secret AWS_ROLE_TO_ASSUME = arn:aws:iam::<acct>:role/<prod-role>
#                 + REQUIRED REVIEWERS (≥ 1) — this IS the manual gate.

# 4. First apply against staging.
cd infra/terraform
terraform init -backend-config=environments/staging/backend.hcl
terraform plan  -var-file=environments/staging/terraform.tfvars
terraform apply -var-file=environments/staging/terraform.tfvars

# 5. Set the OAuth client secrets (one-shot per env).
aws secretsmanager put-secret-value \
  --secret-id inflect-compliance-staging-google-client-secret \
  --secret-string '<google-oauth-client-secret>'
aws secretsmanager put-secret-value \
  --secret-id inflect-compliance-staging-microsoft-client-secret \
  --secret-string '<microsoft-oauth-client-secret>'

# 6. Capture terraform outputs for the .env.prod template.
terraform output > /tmp/staging-outputs.txt

# 7. Repeat steps 4–6 for production.
```

After this, all subsequent infra changes go through the
`.github/workflows/terraform.yml` pipeline (PR → plan-comment → merge
→ auto-apply staging → manual-approval-gated apply production).

## Day-2 ops

### Rotating a generated secret

```bash
# DB master password (RDS-managed)
aws secretsmanager rotate-secret --secret-id <rds-secret-id>
# RDS rotates without downtime; app re-reads on next request.

# Redis AUTH (terraform-managed)
# Just `terraform apply` — random_password regenerates on
# `auth_token_update_strategy = ROTATE`, which preserves the old
# token until rotation completes.

# AUTH_SECRET / JWT_SECRET (terraform-managed)
# Edit module/secrets/main.tf to bump the random_id `keepers`,
# then `terraform apply`. Restart the app — sessions invalidate.

# OAuth secrets (operator-rotated)
aws secretsmanager put-secret-value \
  --secret-id <env>-google-client-secret \
  --secret-string '<new-value-from-google-console>'
# Restart the app to pick up the new value.
```

### Rotating DATA_ENCRYPTION_KEY (Master KEK)

**Do NOT regenerate via Terraform.** Doing so makes every encrypted
column unreadable. Instead, use Epic B's documented sweep procedure.

See `docs/epic-b-encryption.md` for the full runbook. Summary:
1. Generate a new KEK locally.
2. Store as `DATA_ENCRYPTION_KEY_PREVIOUS` in Secrets Manager + the new value as `DATA_ENCRYPTION_KEY`.
3. Deploy.
4. Run `POST /api/t/{slug}/admin/key-rotation` per tenant — sweeps all v1: ciphertexts to v2: under the new KEK.
5. When all tenants report zero v1: rows under the old key, remove `DATA_ENCRYPTION_KEY_PREVIOUS`.

### Adding a new managed secret

1. Add a `random_id` (or operator-supplied `aws_secretsmanager_secret`) + `aws_secretsmanager_secret_version` in `modules/secrets/main.tf`.
2. Add the ARN to `local.module_secret_arns` so the IAM policy includes it.
3. Add to the `secret_arns` and `secret_names` outputs.
4. Add the env-var key to `scripts/bootstrap-env-from-secrets.sh`'s fetch list.
5. Bump the structural ratchet's expected secret count.
6. Document the rotation runbook in this file.

### Provisioning a new environment

1. Add the env name to `infra/terraform/bootstrap/variables.tf::var.environments`.
2. `terraform apply` in `bootstrap/`.
3. Create `infra/terraform/environments/<new>/{backend.hcl,terraform.tfvars,README.md}`.
4. Configure the GitHub Environment + IAM role + OIDC trust.
5. First apply via `terraform -chdir=infra/terraform init -backend-config=...` then `apply`.
6. Set OAuth client secrets via `aws secretsmanager put-secret-value`.
7. Update the structural ratchets that enumerate env names.

### Tearing down an environment

```bash
# Staging — designed for it. db_skip_final_snapshot + storage_force_destroy
# both default true in staging tfvars.
terraform -chdir=infra/terraform init -backend-config=environments/staging/backend.hcl
terraform -chdir=infra/terraform destroy -var-file=environments/staging/terraform.tfvars
# (Note: AWS Secrets Manager retains deleted secrets for 7-30 days; you
# can `aws secretsmanager restore-secret --secret-id ...` if you destroyed
# by mistake.)

# Production — protected by db_deletion_protection=true + storage_force_destroy=false.
# Destroy will fail until you flip those flags AND empty the bucket manually.
# Don't.
```

### Disaster recovery

| Scenario | Recovery path |
|---|---|
| Accidental `terraform destroy` on prod (within recovery window) | `aws secretsmanager restore-secret` for each secret; restore RDS from the latest automated snapshot via `aws rds restore-db-instance-to-point-in-time`; recreate the VPC stack via `terraform apply` (will re-import existing resources where possible, recreate where not). |
| Lost `DATA_ENCRYPTION_KEY` | Within 30-day Secrets Manager recovery window: `restore-secret` recovers the prior version. **Beyond 30 days**: encrypted columns are unrecoverable; restore from a pre-loss DB backup taken when the KEK was still known. |
| Compromised AWS account | Rotate every Secrets-Manager secret (RDS via `rotate-secret`, terraform-managed via `apply` with bumped keepers, OAuth via `put-secret-value`); rotate the `DATA_ENCRYPTION_KEY` via the v1→v2 sweep; rotate the AUTH_SECRET to log everyone out; rebuild the AWS account from the bootstrap stack. |
| Compromised GitHub Actions | Revoke + recreate the OIDC IAM trust policies; rotate every Secrets-Manager secret as above; review the audit log for any `terraform apply` with the compromised role. |
| Compromised IAM principal with state-bucket read | The state files contain generated secret values (DATA_ENCRYPTION_KEY, AUTH_SECRET, JWT_SECRET, AV_WEBHOOK_SECRET, Redis AUTH). Treat all as compromised; rotate per the above. RDS-managed creds are NOT in state — RDS handles them — so DB credentials are safe unless the attacker also had Secrets Manager read. |

The combination of `recovery_window_in_days = 30` on the master KEK
secret + `db_deletion_protection = true` + the production GitHub
Environment's required-reviewers gate gives three independent locks
on a destructive prod operation. Stack it deeper than that only at
the cost of operator friction.
