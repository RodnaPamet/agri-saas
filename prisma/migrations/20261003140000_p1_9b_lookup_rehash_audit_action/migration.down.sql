-- Postgres cannot DROP a single enum value. Reversing this means rewriting the
-- type, which is only safe while no row uses the value — so the down path
-- refuses rather than silently dropping audit rows.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "PlatformAuditLog" WHERE "action" = 'LOOKUP_HASH_REHASHED'
    ) THEN
        RAISE EXCEPTION
            'Refusing to remove LOOKUP_HASH_REHASHED: % audit rows use it. '
            'Removing the value would require deleting append-only history.',
            (SELECT count(*) FROM "PlatformAuditLog" WHERE "action" = 'LOOKUP_HASH_REHASHED');
    END IF;

    ALTER TYPE "PlatformAuditAction" RENAME TO "PlatformAuditAction_old";
    CREATE TYPE "PlatformAuditAction" AS ENUM (
        'FEATURE_FLAG_UPSERTED',
        'FEATURE_FLAG_COHORT_ADDED',
        'FEATURE_FLAG_COHORT_REMOVED',
        'KEY_ROTATION_SWEEP_RUN',
        'KEY_ROTATION_DEK_REWRAPPED',
        'KEY_ROTATION_V2_REPAIRED'
    );
    ALTER TABLE "PlatformAuditLog"
        ALTER COLUMN "action" TYPE "PlatformAuditAction"
        USING "action"::text::"PlatformAuditAction";
    DROP TYPE "PlatformAuditAction_old";
END $$;
