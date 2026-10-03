-- Reverse of 20261003090000_p1_9_platform_audit_log.
--
-- Trigger before table: dropping the table takes the trigger with it, but
-- naming both keeps this runnable against a partially-applied state.
DROP TRIGGER IF EXISTS platform_audit_log_immutable ON "PlatformAuditLog";
DROP FUNCTION IF EXISTS platform_audit_log_immutable_guard();
DROP TABLE IF EXISTS "PlatformAuditLog";
DROP TYPE IF EXISTS "PlatformAuditAction";
