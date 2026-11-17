-- #3095: platform-audit actions for agro calendar overrides. Additive.
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'AGRO_CALENDAR_OVERRIDE_SET';
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'AGRO_CALENDAR_OVERRIDE_CLEARED';
