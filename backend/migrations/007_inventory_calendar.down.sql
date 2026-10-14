-- Reverses 007 ONLY while no calendar setting, confirmation, entry or declared lead-time range exists.
-- Otherwise it refuses and changes nothing. Preservation path: restore the backup taken before migrating
-- (docs/migration-runbook.md). Switching the calendar off without data loss: INVENTORY_CALENDAR_ENABLED=false.
DO $$
DECLARE
  counts TEXT;
BEGIN
  SELECT format('country settings=%s, holiday confirmations=%s, calendar entries=%s, declared lead-time ranges=%s',
    (SELECT COUNT(*) FROM calendar_settings), (SELECT COUNT(*) FROM calendar_holiday_confirmations),
    (SELECT COUNT(*) FROM calendar_entries), (SELECT COUNT(*) FROM product_suppliers WHERE lead_time_max_days IS NOT NULL))
  INTO counts;
  IF EXISTS (SELECT 1 FROM calendar_settings) OR EXISTS (SELECT 1 FROM calendar_holiday_confirmations)
     OR EXISTS (SELECT 1 FROM calendar_entries) OR EXISTS (SELECT 1 FROM product_suppliers WHERE lead_time_max_days IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot reverse 007: calendar data was recorded after the migration (%). Restore the pre-migration backup instead.', counts;
  END IF;
END $$;

ALTER TABLE product_suppliers DROP CONSTRAINT product_suppliers_lead_time_range_check;
ALTER TABLE product_suppliers DROP COLUMN lead_time_max_days;
DROP TABLE calendar_entry_events;
DROP TABLE calendar_entries;
DROP TABLE calendar_holiday_confirmations;
DROP TABLE calendar_settings;
