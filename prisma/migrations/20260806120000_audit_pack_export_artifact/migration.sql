-- `EXPORT_ARTIFACT` for AuditPackItem.entityType.
--
-- `packs.ts` has been inserting this value since the SoA attachment was
-- written, casting it with `as AuditPackItemEntityType` and a comment saying
-- the enum member was "pending schema migration". It never landed, so every
-- insert failed on the enum constraint — and the failure was swallowed by a
-- bare `catch {}` around the whole attachment block. The result: an audit pack
-- frozen for a certifier shipped with no Statement of Applicability, silently,
-- every time.
--
-- The value names what it is: a generated document attached to a pack, as
-- opposed to a snapshot of an existing row.

ALTER TYPE "AuditPackItemEntityType" ADD VALUE IF NOT EXISTS 'EXPORT_ARTIFACT';
