// Inventory readiness (Stage 1a): what the stock figure is, how far it can be
// trusted, and what the seller should do next. Never invents a value — unknown
// stock stays unknown and is never reported as healthy.
//
// Two things are reported separately (architect review 1a, item 2):
//   * measurement age   — when the selected count was taken (last_count.age_days);
//   * position coverage — whether every movement since that count is known
//     (movement_tracking: absent | partial | declared_unverified; 'complete' is
//     reserved for verified synchronisation coverage, which Stage 1a does not record).
// A count from yesterday with no shipment feed is a LAST-KNOWN position, not a
// current one, however recent it is.
const { productHistory, addDays, daysBetween } = require('./coverage');
const { todayIn } = require('./imports');

const dim = (state, reason, action = null) => ({ state, reason, action });

function stockDimension(pos, policy) {
  if (!pos.known) {
    if (pos.legacy) {
      return dim('unverified_only',
        `Only an unverified value from before the inventory ledger (${pos.legacy.quantity}) exists. It has no count time, so it is not used for stock figures.`,
        'Record a stock count.');
    }
    return dim('missing', 'No stock count has been recorded for this product.', 'Record a stock count.');
  }
  if (pos.on_hand < 0) {
    return dim('inconsistent',
      `Recorded movements since the last count take stock below zero (${pos.on_hand}). A movement is missing or wrong, or the count was wrong.`,
      'Recount this product.');
  }
  if (pos.last_count.age_days > policy.stale_after_days) {
    return dim('stale',
      `The last count is ${pos.last_count.age_days} days old; your tolerance is ${policy.stale_after_days} days.`,
      'Record a new stock count.');
  }
  if (pos.movement_tracking === 'complete') { // reserved: verified sync coverage (not recorded in Stage 1a)
    return dim('tracked', 'Counted, and every shipment since the count is recorded by a connected source.');
  }
  const why = {
    absent: 'No source is declared to send shipments for this location, so sales since the count are not subtracted.',
    partial: 'Some sales since the count came from a source, or a day, that no declared shipment feed covers.',
    declared_unverified: 'A shipment feed is declared for this location, but its delivery is not verified, so missing shipments cannot be ruled out.',
  }[pos.movement_tracking] || 'Not every movement since the count is known to be recorded.';
  return dim('last_known', `Last-known count position. ${why}`,
    pos.movement_tracking === 'absent' ? 'Recount before relying on this figure, or connect a shipment feed.' : 'Recount before relying on this figure.');
}

function reconciliationDimension(pos) {
  if (pos.same_instant_events > 0) {
    return dim('needs_review',
      `${pos.same_instant_events} movement(s) from another source carry exactly the count's time, so it cannot be established whether the count already includes them. They are treated as included.`,
      'Check those events, or record a new count.');
  }
  if (pos.events_without_count > 0) {
    return dim('needs_review',
      `${pos.events_without_count} movement(s) are recorded but there is no count to apply them to.`,
      'Record a stock count.');
  }
  return dim('none', 'Nothing to reconcile.');
}

function salesDimension(history, today, staleAfterDays) {
  if (!history || !history.first_sale) return dim('no_sales', 'No sales are recorded for this product.');
  if (!history.usable) {
    return dim('needs_confirmation', 'Sales are recorded but no period has been confirmed as complete.',
      'Confirm the period on the Data Integration page.');
  }
  const days = history.usable.days;
  const behind = daysBetween(history.usable.end, today);
  const base = days < 28
    ? dim('insufficient', `${days} confirmed day(s); at least 28 are needed.`, 'Upload and confirm more history.')
    : days < 180
      ? dim('average_only', `${days} confirmed days: recent-average outlook only (model needs 180).`)
      : dim('sufficient', `${days} confirmed days.`);
  return { ...base, usable_days: days, ends_on: history.usable.end,
    stale: behind > staleAfterDays, days_since_history_end: behind };
}

function thresholdAlert(pos, policy) {
  if (policy.reorder_threshold === null || policy.reorder_threshold === undefined) return 'not_set';
  if (!pos.known) return 'unknown_stock';
  if (pos.on_hand < policy.reorder_threshold) return 'below';
  if (pos.on_hand === policy.reorder_threshold) return 'at';
  return 'above';
}

// Cheap part (no per-product history query) — used for counts across all products.
function assess(pos, policy) {
  const stock = stockDimension(pos, policy);
  return {
    stock,
    reconciliation: reconciliationDimension(pos),
    commitments: dim('not_tracked', 'Reservations and backorders are not tracked yet, so on-hand is not available-to-sell stock.'),
    policy: policy.reorder_threshold === null
      ? dim('threshold_not_set', 'No reorder threshold is set.', 'Set a reorder threshold.')
      : dim('threshold_set', `Reorder threshold: ${policy.reorder_threshold}.`),
    overall: ['missing', 'unverified_only', 'inconsistent'].includes(stock.state) ? 'blocked' : 'provisional',
    threshold_alert: thresholdAlert(pos, policy),
  };
}

async function withSalesHistory(db, sellerId, location, productId, assessment, policy) {
  const history = await productHistory(db, sellerId, productId);
  return { ...assessment, sales_history: salesDimension(history, todayIn(location.timezone), policy.stale_after_days) };
}

module.exports = { assess, withSalesHistory, thresholdAlert, salesDimension, addDays };
