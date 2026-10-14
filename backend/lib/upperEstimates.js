// Forecast upper estimates — applicability policy upper-estimates-policy-1 (server-enforced).
//
// The ML service (POST /v2/upper-estimates, ml/v2/upper_estimates.py) computes one-sided 80% and 90% upper demand
// estimates for the 12 cells that passed the one-time Stage 3 final evaluation, and enforces the DATA conditions
// it was evaluated under (180+ confirmed days, regular/occasional/rare pattern, evaluated model release and route).
// This module enforces the STORE and PRODUCT conditions before the ML service is called, because the evidence comes
// from US Walmart (M5) food, household and hobby products and a country alone does not establish that it applies:
//   1. switched on (FORECAST_UPPER_ESTIMATES_ENABLED=true, with FORECAST_V2_ENABLED=true);
//   2. the store's country is confirmed by the seller (inventory calendar) — never inferred from a timezone;
//   3. that country is the US (Pakistan and others: evaluated as not supported / not evaluated);
//   4. the seller confirmed the benchmark profile 'us_general_retail' and that the estimates are a benchmark
//      reference not calibrated to the store (withdrawable);
//   5. the seller placed the product in a benchmark department (food, household or hobbies), not 'not_covered'.
// Any failed condition answers 'unavailable' with its reason; the forecast itself is never changed or withheld.
// Upper estimates are display-only: nothing here is read by replenishment, safety stock or purchasing.
'use strict';

const { callMLServer } = require('./forecastService');

const POLICY_VERSION = 'upper-estimates-policy-1';
const PROFILE = 'us_general_retail';
const enabled = () => process.env.FORECAST_UPPER_ESTIMATES_ENABLED === 'true' && process.env.FORECAST_V2_ENABLED === 'true';

const DEPARTMENTS = {
  foods: 'Food and grocery',
  household: 'Household',
  hobbies: 'Hobbies, toys and crafts',
  not_covered: 'None of these',
};
const PROFILE_TEXT = 'My store is in the US and sells individual units of food, household or hobby products. '
  + 'I understand that the upper estimates were evaluated on US Walmart benchmark data and are not calibrated to my store.';
const LIMITATION = 'Evaluated on US Walmart benchmark data; not calibrated to your store.';

const REASONS = {
  disabled: 'Upper demand estimates are switched off on this server. Your forecast is not affected.',
  country_not_confirmed: 'Confirm your store\'s country first (Inventory → Calendar). A country is never assumed from a timezone.',
  market_pakistan: 'Upper estimates were evaluated only on US Walmart benchmark data. For Pakistan the check was descriptive only: '
    + 'the 90% and 28-day estimates did not meet the coverage check and were very wide. Your forecast is shown without an upper estimate.',
  market_not_evaluated: 'Upper estimates were evaluated only on US Walmart benchmark data, not for stores in this country. Your forecast is shown without an upper estimate.',
  profile_not_confirmed: 'Being in the US is not enough to apply benchmark results. Confirm that your store sells individual units of food, '
    + 'household or hobby products and that you understand the estimates are not calibrated to your store.',
  profile_withdrawn: 'You withdrew the store profile confirmation, so upper estimates are not shown.',
  product_type_not_set: 'Say which benchmark department this product belongs to — food, household or hobbies — or that it is none of these.',
  product_type_not_covered: 'You marked this product as not a food, household or hobby product. The benchmark did not cover it, so only the forecast is shown.',
  service_unavailable: 'The upper-estimate service is unavailable right now. Your forecast is not affected.',
};

async function readSettings(db, sellerId) {
  const { rows } = await db.query(
    `SELECT profile, status, policy_version, updated_at, version FROM upper_estimate_settings WHERE seller_id = $1`, [sellerId]);
  return rows[0] || null;
}

async function readProductType(db, sellerId, productId) {
  const { rows } = await db.query(
    `SELECT department, updated_at, version FROM upper_estimate_product_types WHERE seller_id = $1 AND product_id = $2`, [sellerId, productId]);
  return rows[0] || null;
}

async function readCountry(db, sellerId) {
  const { rows } = await db.query('SELECT country_code FROM calendar_settings WHERE seller_id = $1', [sellerId]);
  return rows[0]?.country_code ?? null;
}

// The store/product checks, in order, each with its result. reason = the first failed check (or null).
async function storeChecks(db, sellerId, productId) {
  const country = await readCountry(db, sellerId);
  const settings = await readSettings(db, sellerId);
  const type = productId ? await readProductType(db, sellerId, productId) : null;
  const checks = [
    { code: 'disabled', ok: enabled(), text: 'Upper estimates switched on' },
    { code: 'country_not_confirmed', ok: Boolean(country), text: 'Store country confirmed by you' },
    { code: country === 'PK' ? 'market_pakistan' : 'market_not_evaluated', ok: country === 'US', text: 'Store in the US (the benchmark market)' },
    { code: settings?.status === 'withdrawn' ? 'profile_withdrawn' : 'profile_not_confirmed',
      ok: settings?.status === 'confirmed' && settings.profile === PROFILE, text: 'Store profile matches the benchmark (confirmed by you)' },
  ];
  if (productId) {
    checks.push({ code: 'product_type_not_set', ok: Boolean(type), text: 'Product department chosen' });
    checks.push({ code: 'product_type_not_covered', ok: Boolean(type) && type.department !== 'not_covered',
      text: 'Product is a food, household or hobby product' });
  }
  const failed = checks.find(c => !c.ok);
  return { country, settings, type, checks, reason: failed ? { code: failed.code, text: REASONS[failed.code] } : null };
}

// ML call for a product whose store checks passed. The ML service re-checks the data conditions.
async function fromHistory(history) {
  return callMLServer('POST', '/v2/upper-estimates', { start: history.usable.start, quantities: history.usable.quantities }, 60000);
}

module.exports = {
  POLICY_VERSION, PROFILE, PROFILE_TEXT, DEPARTMENTS, LIMITATION, REASONS,
  enabled, readSettings, readProductType, readCountry, storeChecks, fromHistory,
};
