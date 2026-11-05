-- Normalise `Promotion.validFrom` / `validTo` to the instant that LABELS their
-- farm-zone calendar day (#2752).
--
-- These two columns are calendar DAYS stored in `DateTime`. The console's date
-- picker wrote LOCAL midnight, so «30 Nov» was stored `2026-11-29T22:00:00Z` —
-- and `validTo >= now` then expired the campaign at 00:00 Sofia on the very day
-- the operator chose as its last. The query now compares day to day against the
-- instant labelling today, which requires the stored value to be that same
-- label rather than a zone-shifted one.
--
-- WHY THE STRING IS BUILT EXPLICITLY. `(col AT TIME ZONE 'Europe/Sofia')::date
-- AT TIME ZONE 'UTC'` reads correctly and is not: the intermediate cast and the
-- session TimeZone make the result depend on who is connected. Formatting the
-- farm-zone day and re-parsing it with an explicit `+00` offset has one reading.
-- Verified against this schema by composing it with the application's own
-- `dayKeyInTz`: every case — winter local midnight, summer local midnight, an
-- already-normalised value, and a midday value — lands on the instant whose
-- farm-zone day key equals the original's.
--
-- IDEMPOTENT, MEASURED rather than reasoned. Applied to a probe table with
-- these column types, snapshotted, applied again, snapshotted: the second run
-- changed nothing, every non-null value was the instant labelling its own farm
-- day, and NULLs were untouched. Cases covered: winter local midnight, summer
-- local midnight (the other UTC offset), an already-normalised value, a midday
-- value, and nulls.
--
-- Stated this way because the first version of this comment asserted
-- idempotence on the strength of having checked the EXPRESSION on sample
-- values, which is a different thing from having run the migration twice.
--
-- NO ROLLBACK SCRIPT. This is REASONING, not a measurement, and is labelled as
-- such deliberately: verifying it would mean building the previous image and
-- running it against a normalised database, which has not been done.
--
-- The reasoning, shown so it can be disagreed with: `deploy/rollback/` is owed
-- when a migration would BREAK the previous image. The previous image compares
-- these columns against `now` and serves them with `.toISOString()`, and both
-- work on a UTC-midnight value — so the visible difference is that a
-- campaign's last day becomes two hours long instead of zero, which is an
-- improvement under the old code rather than a break. The write path is
-- additive from that image's point of view, because it never reads the format
-- back.
--
-- If that is wrong, the symptom is a rolled-back deployment serving campaigns
-- whose last day is short rather than absent — which is why the risk was
-- judged acceptable without the build.

UPDATE "Promotion"
SET "validFrom" = (
        to_char("validFrom" AT TIME ZONE 'Europe/Sofia', 'YYYY-MM-DD') || ' 00:00:00+00'
    )::timestamptz
WHERE "validFrom" IS NOT NULL;

UPDATE "Promotion"
SET "validTo" = (
        to_char("validTo" AT TIME ZONE 'Europe/Sofia', 'YYYY-MM-DD') || ' 00:00:00+00'
    )::timestamptz
WHERE "validTo" IS NOT NULL;
