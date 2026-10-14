# Stage 2 acceptance run: replenishment queue, product outlook, scenario, draft from a
# recommendation, stale refusal, indicative / needs-information states, settings, mobile,
# forecast-service-down — through the REAL React pages, backend (5000), the real ML
# server (8000, frozen release) and PostgreSQL (nexus_demo6 = demo4 + 006). Screens + evidence.json.
import asyncio, json, os, subprocess, sys, time, urllib.request, uuid
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'shots_rep'
DB = 'nexus_demo6'
os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:5000/api'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '3000', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
log, ev = [], {}

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={**({'Authorization': f'Bearer {token}'} if token else {}), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, None
def sql(q):
    return subprocess.run(['psql', '-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-At', '-c', q], capture_output=True, text=True).stdout.strip()
TABLES = ['stock_snapshot_batches', 'stock_snapshots', 'stock_movements', 'inventory_policies', 'suppliers', 'product_suppliers',
          'purchase_orders', 'purchase_order_lines', 'purchase_order_events', 'sales', 'products']
def contents(tables=TABLES):
    return {t: sql(f"SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) FROM {t} x") for t in tables}

login = call('POST', '/auth/login', {'email': 'ayesha@lahorestore.pk', 'password': 'demo-pass-2026'})[1]
A = login['token']
pid = {r.split('|')[1]: int(r.split('|')[0]) for r in sql('SELECT id, name FROM products WHERE user_id = 1').splitlines()}

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1, reduced_motion='reduce', timezone_id='Asia/Karachi')
        await ctx.add_init_script(f"localStorage.setItem('nexus_token',{json.dumps(A)});localStorage.setItem('nexus_user',{json.dumps(json.dumps(login['user']))});")
        pg = await ctx.new_page()
        pg.on('console', lambda m: log.append(f'[{m.type}] {m.text}') if m.type == 'error' else None)
        pg.on('pageerror', lambda e: log.append(f'[pageerror] {e}'))
        async def shot(name, full=False, width=1440):
            if full:
                hh = await pg.evaluate("document.querySelector('.shell-content') ? document.querySelector('.shell-content').scrollHeight + 60 : document.body.scrollHeight")
                await pg.set_viewport_size({'width': width, 'height': max(900, hh)})
            await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'{OUT}/{name}.png', full_page=full)
            await pg.set_viewport_size({'width': width, 'height': 900})
        async def dialog_shot(name, width=1440):
            h = await pg.evaluate("(() => { const d = document.querySelector('dialog[open]'); return d ? d.scrollHeight + 80 : 900; })()")
            await pg.set_viewport_size({'width': width, 'height': max(900, min(h, 5000))})
            await pg.wait_for_timeout(600)
            await pg.screenshot(path=f'{OUT}/{name}.png')
            await pg.set_viewport_size({'width': width, 'height': 900})
        D = 'dialog[open] >> '
        async def tab(label):
            await pg.goto('http://localhost:3000/index.html?page=inventory'); await pg.wait_for_timeout(1800)
            await pg.click(f'[aria-label="Inventory section"] >> button:has-text("{label}")')
            await pg.wait_for_timeout(2500)
        async def open_outlook(name):
            await pg.click(f'tr[aria-label="Open the outlook for {name}"]'); await pg.wait_for_timeout(2500)
        async def close():
            await pg.click(D + 'button:has-text("Close")'); await pg.wait_for_timeout(500)

        before_all = contents()
        # ── Queue ───────────────────────────────────────────────────────────
        await tab('Replenishment'); await shot('01_queue', full=True)
        q = call('GET', '/inventory/replenishment', token=A)[1]
        ev['1_queue'] = {'planning_date': q['planning_date'], 'counts': q['counts'],
                         'rows': [{k: i[k] for k in ['status', 'suggested_quantity', 'shortage_7_units', 'shortage_28_units', 'before_arrival_shortage', 'next_step']} | {'product': i['product']['name']} for i in q['items']]}
        await pg.click('[aria-label="Filter"] >> button:has-text("Short before arrival")'); await pg.wait_for_timeout(1800)
        await shot('02_filter_short_before_arrival')

        # ── Lawn Suit outlook (provisional) ─────────────────────────────────
        await tab('Replenishment'); await open_outlook('Lawn Suit 3-Piece')
        await dialog_shot('03_outlook_provisional')
        await pg.click(D + 'summary:has-text("How this was worked out")'); await pg.click(D + 'summary:has-text("What the assumptions mean")')
        await dialog_shot('04_outlook_explanation')
        lawn = call('GET', f"/inventory/items/{pid['Lawn Suit 3-Piece']}/replenishment", token=A)[1]
        ev['2_lawn'] = {k: lawn[k] for k in ['status', 'actionable', 'recommendation_id', 'inputs_sha256', 'stock', 'outlook', 'before_arrival', 'suggestion', 'assumptions', 'limitations']}

        # ── Scenario (not saved) ────────────────────────────────────────────
        log_before = contents(['replenishment_recommendations'])
        await pg.click(D + 'summary:has-text("Try a scenario")'); await pg.wait_for_timeout(300)
        await pg.fill('#sc-review', '14'); await pg.fill('#sc-safety', '10')
        await pg.click(D + 'button:has-text("Run scenario")'); await pg.wait_for_timeout(2000)
        await dialog_shot('05_scenario_not_saved')
        ev['3_scenario'] = {'tables_unchanged': contents() == before_all, 'log_unchanged': contents(['replenishment_recommendations']) == log_before,
                            'policy_after': call('GET', f"/inventory/items/{pid['Lawn Suit 3-Piece']}/policy", token=A)[1]['effective']}

        # ── Create draft from the recommendation ────────────────────────────
        moves_before = sql('SELECT COUNT(*), COALESCE(SUM(quantity), 0) FROM stock_movements')
        await pg.click(D + 'button:has-text("Create draft order for")'); await pg.wait_for_timeout(2500)
        await dialog_shot('06_draft_created')
        po = sql(f"SELECT id || '|' || status || '|' || source_recommendation_id FROM purchase_orders WHERE source_recommendation_id = {lawn['recommendation_id']}")
        retry = call('POST', '/purchase-orders/from-recommendation', {'recommendation_id': lawn['recommendation_id'], 'inputs_sha256': lawn['inputs_sha256']}, token=A)
        ev['4_draft'] = {'order': po, 'retry_status': retry[0], 'retry_replayed': retry[1].get('replayed'),
                         'orders_for_recommendation': sql(f"SELECT COUNT(*) FROM purchase_orders WHERE source_recommendation_id = {lawn['recommendation_id']}"),
                         'stock_movements_unchanged': sql('SELECT COUNT(*), COALESCE(SUM(quantity), 0) FROM stock_movements') == moves_before,
                         'line': sql(f"SELECT product_id || '|' || quantity_ordered FROM purchase_order_lines WHERE po_id = {po.split('|')[0]}")}
        await close()
        # Reopened: the draft is now an unplaced order — warned, and no second draft is offered.
        await open_outlook('Lawn Suit 3-Piece'); await dialog_shot('06b_after_draft_no_second_draft')
        lawn2 = call('GET', f"/inventory/items/{pid['Lawn Suit 3-Piece']}/replenishment", token=A)[1]
        ev['4_draft']['after'] = {'status': lawn2['status'], 'actionable': lawn2['actionable'], 'draft_blocked': lawn2['draft_blocked'],
                                  'draft_button': await pg.locator(D + 'button:has-text("Create draft order")').count()}
        await close()

        # ── Ceramic Mug: overdue order, short before arrival, then stale refusal ──
        await open_outlook('Ceramic Mug Set'); await dialog_shot('07_outlook_overdue_short_before_arrival')
        mug = call('GET', f"/inventory/items/{pid['Ceramic Mug Set']}/replenishment", token=A)[1]
        ev['5_mug'] = {k: mug[k] for k in ['status', 'warnings', 'before_arrival', 'alternative_if_uncertain_incoming_arrives']} | {'quantity': mug['suggestion']['quantity'], 'raw_need': mug['suggestion']['raw_need']}
        # Someone records a new count while the page is open:
        call('POST', '/inventory/snapshots', {'idempotency_key': str(uuid.uuid4()), 'observed_at': datetime.now(timezone.utc).isoformat(),
                                              'items': [{'product_id': pid['Ceramic Mug Set'], 'quantity': 40}]}, token=A)
        orders_before = sql('SELECT COUNT(*) FROM purchase_orders')
        await pg.click(D + 'button:has-text("Create draft order for")'); await pg.wait_for_timeout(2500)
        await dialog_shot('08_stale_refused_recomputed')
        ev['6_stale'] = {'orders_unchanged': sql('SELECT COUNT(*) FROM purchase_orders') == orders_before,
                         'notice_shown': await pg.locator(D + 'text=has changed since it was shown').count() > 0}
        await close()

        # ── Indicative (forecast behind) and needs-information ─────────────
        await open_outlook('Pashmina Shawl'); await dialog_shot('09_outlook_indicative_partial_coverage')
        pash = call('GET', f"/inventory/items/{pid['Pashmina Shawl']}/replenishment", token=A)[1]
        ev['7_pashmina'] = {'status': pash['status'], 'actionable': pash['actionable'], 'lag': pash['forecast']['lag_days'],
                            'outlook28': {k: pash['outlook']['28'][k] for k in ['start', 'end', 'covered_days', 'label']},
                            'outlook7': {k: pash['outlook']['7'][k] for k in ['start', 'end', 'covered_days']},
                            'draft_button': await pg.locator(D + 'button:has-text("Create draft order")').count()}
        await close()
        await open_outlook('Bridal Clutch'); await dialog_shot('10_outlook_needs_information')
        clutch = call('GET', f"/inventory/items/{pid['Bridal Clutch']}/replenishment", token=A)[1]
        ev['8_clutch'] = {'status': clutch['status'], 'missing': [m['code'] for m in clutch['missing']], 'indicative': [r['code'] for r in clutch['indicative_reasons']],
                          'cover': clutch['outlook']['approximate_cover_days'], 'method': clutch['forecast']['method']}
        await pg.click(D + '[aria-label="Action"] >> button:has-text("Settings")'); await pg.wait_for_timeout(1200)
        await dialog_shot('11_product_settings_review_safety')
        await close()

        # ── Mobile ──────────────────────────────────────────────────────────
        await pg.set_viewport_size({'width': 390, 'height': 844})
        await tab('Replenishment'); await shot('12_queue_mobile', full=True, width=390)
        await open_outlook('Lawn Suit 3-Piece'); await dialog_shot('13_outlook_mobile', width=390)
        await pg.set_viewport_size({'width': 1440, 'height': 900})
        # ── Review fix 1: a movement at the count's exact instant ───────────
        counted_at = call('GET', f"/inventory/items/{pid['Lawn Suit 3-Piece']}", token=A)[1]['stock']['last_count']['observed_at']
        # Cancel the earlier draft so the product is actionable again, then introduce the ambiguity.
        call('POST', f"/purchase-orders/{po.split('|')[0]}/cancel", {'version': 1, 'reason': 'evidence: free the product'}, token=A)
        lawn_free = call('GET', f"/inventory/items/{pid['Lawn Suit 3-Piece']}/replenishment", token=A)[1]
        mv = call('POST', '/inventory/movements', {'idempotency_key': str(uuid.uuid4()), 'kind': 'damage', 'product_id': pid['Lawn Suit 3-Piece'],
                                                   'quantity': 2, 'reason': 'evidence: broken at count time', 'effective_at': counted_at}, token=A)
        await tab('Replenishment'); await open_outlook('Lawn Suit 3-Piece'); await dialog_shot('15_reconciliation_indicative')
        lawn_rec = call('GET', f"/inventory/items/{pid['Lawn Suit 3-Piece']}/replenishment", token=A)[1]
        old = call('POST', '/purchase-orders/from-recommendation', {'recommendation_id': lawn_free['recommendation_id'], 'inputs_sha256': lawn_free['inputs_sha256']}, token=A)
        ev['10_reconciliation'] = {'movement_status': mv[0], 'free_before': [lawn_free['status'], lawn_free['actionable']],
            'after': [lawn_rec['status'], lawn_rec['actionable'], lawn_rec['stock']['reconciliation']['state']],
            'fingerprint_changed': lawn_rec['inputs_sha256'] != lawn_free['inputs_sha256'],
            'older_recommendation': [old[0], (old[1] or {}).get('error')], 'draft_button': await pg.locator(D + 'button:has-text("Create draft order")').count()}
        await close()

        # ── Review fix 2: sales source timezone differs from the stock location ──
        src = call('GET', '/data/sources', token=A)[1]['sources']
        for x in src: call('PATCH', f"/data/sources/{x['id']}", {'timezone': 'America/Los_Angeles'}, token=A)
        await tab('Replenishment'); await shot('16_timezone_mismatch_queue', full=True)
        await open_outlook('Ceramic Mug Set'); await dialog_shot('17_timezone_mismatch_outlook')
        mug_tz = call('GET', f"/inventory/items/{pid['Ceramic Mug Set']}/replenishment", token=A)[1]
        ev['11_timezone'] = {'status': mug_tz['status'], 'missing': [m['code'] for m in mug_tz['missing']], 'outlook': mug_tz['outlook'],
            'suggestion': mug_tz['suggestion'], 'forecast_totals': mug_tz['forecast']['totals'], 'dates_timezone': mug_tz['forecast']['dates_timezone'],
            'stock_on_hand': mug_tz['stock']['on_hand'], 'queue_counts': call('GET', '/inventory/replenishment', token=A)[1]['counts']}
        for x in src: call('PATCH', f"/data/sources/{x['id']}", {'timezone': x['timezone']}, token=A)
        await close()
        ev['9_console_errors'] = log
        await b.close()

asyncio.run(main())
srv.terminate()
json.dump(ev, open(f'{OUT}/evidence.json', 'w'), indent=2, default=str)
print(json.dumps({k: v for k, v in ev.items() if k not in ('2_lawn',)}, indent=1, default=str)[:6000])
