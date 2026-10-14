-- Reverses 008 ONLY while no seller has answered the upper-estimate applicability questions.
-- Otherwise it refuses and changes nothing. Switching the feature off without data loss:
-- FORECAST_UPPER_ESTIMATES_ENABLED=false (the forecast itself is unaffected either way).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM upper_estimate_events) OR EXISTS (SELECT 1 FROM upper_estimate_settings)
     OR EXISTS (SELECT 1 FROM upper_estimate_product_types) THEN
    RAISE EXCEPTION 'cannot reverse 008: upper-estimate answers were recorded (settings=%, product types=%, events=%). Restore the pre-migration backup instead.',
      (SELECT COUNT(*) FROM upper_estimate_settings), (SELECT COUNT(*) FROM upper_estimate_product_types), (SELECT COUNT(*) FROM upper_estimate_events);
  END IF;
END $$;

DROP TABLE upper_estimate_events;
DROP TABLE upper_estimate_product_types;
DROP TABLE upper_estimate_settings;
