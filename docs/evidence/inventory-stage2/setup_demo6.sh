#!/bin/bash
# Stage 2 demo database: nexus_demo4 (Stage 1a/1b demo) copied to nexus_demo6, migration 006
# applied, then three seller actions through the API (lead time + terms for Ceramic Mug Set,
# an overdue order for it, a count + supplier link for Pashmina Shawl). Development only.
set -e
. /tmp/claude-0/demo_env.sh
pkill -f "^node server.js" || true; sleep 1
psql -h /tmp -p 5433 -U postgres -d postgres -qc "DROP DATABASE IF EXISTS nexus_demo6" -c "CREATE DATABASE nexus_demo6 TEMPLATE nexus_demo4"
cd /home/claude/nc/backend && DB_NAME=nexus_demo6 node db/migrate.js | tail -1
(DB_NAME=nexus_demo6 nohup node server.js > /tmp/claude-0/api.log 2>&1 &); sleep 4
T=$(curl -s -X POST localhost:5000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"ayesha@lahorestore.pk","password":"demo-pass-2026"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
H="Authorization: Bearer $T"; J='Content-Type: application/json'
q() { psql -h /tmp -p 5433 -U postgres -At -d nexus_demo6 -c "$1"; }
HYD=$(q "SELECT id FROM suppliers WHERE seller_id=1 AND name='Hyderabad Ceramics'"); FAI=$(q "SELECT id FROM suppliers WHERE seller_id=1 AND name='Faisalabad Textile Mills'")
curl -sf -X PUT localhost:5000/api/products/2/suppliers/$HYD -H "$H" -H "$J" -d '{"unit_cost":450,"currency":"PKR","lead_time_days":5,"min_order_qty":12,"pack_size":6,"is_preferred":true}' >/dev/null
PO=$(curl -sf -X POST localhost:5000/api/purchase-orders -H "$H" -H "$J" -d "{\"idempotency_key\":\"demo-s2-overdue\",\"supplier_id\":$HYD,\"expected_arrival\":\"2026-10-05\",\"lines\":[{\"product_id\":2,\"quantity\":12}]}" | python3 -c "import sys,json;print(json.load(sys.stdin)['purchase_order']['id'])")
curl -sf -X POST localhost:5000/api/purchase-orders/$PO/approve -H "$H" -H "$J" -d '{"version":1}' >/dev/null
curl -sf -X POST localhost:5000/api/purchase-orders/$PO/mark-ordered -H "$H" -H "$J" -d '{"version":2}' >/dev/null
curl -sf -X POST localhost:5000/api/inventory/snapshots -H "$H" -H "$J" -d "{\"idempotency_key\":\"demo-s2-pashmina\",\"observed_at\":\"$(date -u -d '-5 min' +%Y-%m-%dT%H:%M:%SZ)\",\"items\":[{\"product_id\":5,\"quantity\":15}]}" >/dev/null
curl -sf -X PUT localhost:5000/api/products/5/suppliers/$FAI -H "$H" -H "$J" -d '{"unit_cost":3500,"currency":"PKR","lead_time_days":7,"min_order_qty":5,"pack_size":5,"is_preferred":true}' >/dev/null
# Keep the demo current: confirm the file-upload source's sales up to yesterday (Karachi),
# so its products' forecasts start today on whatever day this runs. Pashmina Shawl comes
# from another source and stays behind on purpose (indicative case).
YDAY=$(TZ=Asia/Karachi date -d yesterday +%F)
LAST=$(q "SELECT MAX(declared_end) FROM data_coverage WHERE seller_id=1 AND source_id=1 AND status='confirmed'")
if [[ "$LAST" < "$YDAY" ]]; then
  FIRST=$(date -d "$LAST + 1 day" +%F)
  python3 - "$FIRST" "$YDAY" > /tmp/claude-0/demo6_fill.csv <<'PY'
import sys, datetime as dt
a, b = (dt.date.fromisoformat(x) for x in sys.argv[1:3])
print('product_name,quantity,sale_date,revenue')
d = a
while d <= b:
    for name, q, price in [('Lawn Suit 3-Piece', 5, 4500), ('Ceramic Mug Set', 4, 1200)]:
        print(f'{name},{q},{d},{q * price}')
    d += dt.timedelta(days=1)
PY
  curl -sf -X POST localhost:5000/api/data/upload -H "$H" -F "file=@/tmp/claude-0/demo6_fill.csv;type=text/csv" \
    -F coverage_start=$FIRST -F coverage_end=$YDAY -F coverage_scope=all_products -F coverage_confirmed=true >/dev/null
  echo "confirmed $FIRST..$YDAY on the file-upload source"
fi
echo "demo6 ready (overdue PO-$PO)"
