const pool = require('../config/db');

// Returns the product only if it belongs to `userId`. Products with no owner
// (user_id IS NULL) never match, because NULL = $2 is never true in SQL.
async function findOwnedProduct(productId, userId, db = pool) {
  if (!Number.isInteger(productId) || productId <= 0 || !userId) return null;
  const { rows } = await db.query(
    'SELECT id, name, category FROM products WHERE id = $1 AND user_id = $2',
    [productId, userId],
  );
  return rows[0] || null;
}

module.exports = { findOwnedProduct };
