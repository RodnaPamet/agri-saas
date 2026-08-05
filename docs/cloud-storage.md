# Cloud Storage Architecture

> Provider-agnostic file storage with tenant isolation, AV scanning, and migration tooling.

## Provider Abstraction

All file operations go through `getStorageProvider()` from `@/lib/storage`. Two implementations:

| Provider | Backend | Use When |
|---|---|---|
| `local` | Local filesystem (`FILE_STORAGE_ROOT`) | Development, testing |
| `s3` | S3/R2/MinIO via `@aws-sdk/client-s3` | **Production** |

### Production Guard

`getStorageProvider()` logs a warning if `local` is used in production. All production deployments
MUST set `STORAGE_PROVIDER=s3`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STORAGE_PROVIDER` | Yes (prod) | `local` | `local` or `s3` |
| `S3_BUCKET` | Yes (s3) | — | Bucket name |
| `S3_REGION` | Yes (s3) | — | AWS region |
| `S3_ENDPOINT` | No | — | Custom endpoint (R2/MinIO) |
| `S3_ACCESS_KEY_ID` | Yes (s3) | — | AWS access key |
| `S3_SECRET_ACCESS_KEY` | Yes (s3) | — | AWS secret key |
| `FILE_STORAGE_ROOT` | Yes (local) | — | Local storage root path |
| `AV_WEBHOOK_SECRET` | Yes (prod) | — | HMAC key for AV webhook |
| `AV_SCAN_MODE` | No | `strict` | `strict`, `permissive`, `disabled` — only meaningful with `CLAMAV_HOST` set; with no scanner every upload is recorded `SKIPPED` regardless |

## Object Key Format

All keys are tenant-scoped with date partitioning:

```
tenants/{tenantId}/{domain}/{yyyy}/{mm}/{uuid}_{sanitizedFilename}
```

**Domains**: `evidence`, `reports`, `exports`, `temp`, `general`

Key generation: `buildTenantObjectKey(tenantId, domain, filename)`
Key validation: `assertTenantKey(key, tenantId)` — throws on cross-tenant access or path traversal.

## File Lifecycle

```
PENDING → STORED (scanStatus=PENDING) → scanStatus=CLEAN/INFECTED/SKIPPED
                                       → INFECTED: auto-quarantine (status=FAILED)
                → FAILED
                → DELETED
```

## AV Scanning

### Webhook Endpoint

`POST /api/storage/av-webhook`

**Headers**: `X-AV-Signature: <HMAC-SHA256 hex digest>`

**Payload**:
```json
{
  "fileId": "cuid",
  "status": "clean|infected|skipped",
  "details": "scan engine output",
  "engine": "ClamAV 1.2.0"
}
```

**Behavior**: infected → quarantine (status=FAILED) + audit event.

### Download Guard

| scanStatus | strict | permissive | disabled |
|---|---|---|---|
| CLEAN | ✅ | ✅ | ✅ |
| PENDING | ❌ | ✅ | ✅ |
| INFECTED | ❌ | ❌ | ❌ |

## Migration Script

```bash
# Dry run
npx tsx scripts/migrate-files-to-cloud.ts --dry-run

# Migrate single tenant
npx tsx scripts/migrate-files-to-cloud.ts --tenant=<id>

# Full migration with local cleanup
npx tsx scripts/migrate-files-to-cloud.ts --delete-local --batch=100
```

Features: batch processing, SHA-256 integrity verification, rollback safety (local files kept by default).

### Dual-Read During Migration

Downloads use `getProviderByName(fileRecord.storageProvider)` — reads from the backend that
actually stored the file. Old `local` files remain accessible while app is configured for `s3`.

## Dev/Test vs Production

| | Dev/Test | Production |
|---|---|---|
| Provider | `local` | `s3` (required) |
| AV scanning | `disabled`/`permissive` | `strict`/`permissive` |
| Webhook auth | Optional | Required (`AV_WEBHOOK_SECRET`) |
| Migration | N/A | Run `migrate-files-to-cloud.ts` |
