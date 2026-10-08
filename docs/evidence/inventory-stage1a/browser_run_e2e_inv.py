# Stage 1a inventory acceptance run against the REAL backend (5000) and PostgreSQL
# (nexus_demo4, migrated to 004 after a passing rehearsal), with the actual React
# pages served on port 3000. Writes screenshots + evidence.json to OUT.
import asyncio, json, os, subprocess, sys, time, urllib.request, uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from playwright.async_api import async_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'shots_inv'
os.makedirs(OUT, exist_ok=True)
KHI = ZoneInfo('Asia/Karachi')
BASE = 'http://localhost:5000/api'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '3000', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
log, ev = [], {}

def call(method, path, body=None, token=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={**({'Authorization': f'Bearer {token}'} if token else {}), 'Content-Type': ctype})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, None

login = call('POST', '/auth/login', {'email': 'ayesha@lahorestore.pk', 'password': 'demo-pass-2026'})[1]
A = login['token']
def items(token=A):
    return {i['name']: {'on_hand': i['stock']['on_hand'], 'known': i['stock']['known'], 'state': i['readiness']['stock']['state'],
                        'tracking': i['stock']['movement_tracking'], 'alert': i['threshold_alert'],
                        'legacy': (i['stock']['legacy'] or {}).get('quantity')}
            for i in call('GET', '/inventory/items?page_size=200', token=token)[1]['items']}
def ids(): return {p['name']: p['id'] for p in call('GET', '/products', token=A)[1]['products']}
def iso(dt): return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
def stock_tables():
    out = subprocess.run(['psql', '-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', 'nexus_demo4', '-At', '-c',
        "SELECT (SELECT COUNT(*) FROM stock_snapshots)||','||(SELECT COUNT(*) FROM stock_movements)||','||(SELECT COUNT(*) FROM inventory)||','||(SELECT COALESCE(SUM(stock_level),0) FROM inventory)"],
        capture_output=True, text=True).stdout.strip().split(',')
    return dict(zip(['snapshots', 'movements', 'legacy_inventory_rows', 'legacy_inventory_units'], map(int, out)))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        async def page(token=A, user=None, w=1440, h=900, routes=None):
            ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1, reduced_motion='reduce', timezone_id='Asia/Karachi')
            await ctx.add_init_script(f"localStorage.setItem('nexus_token',{json.dumps(token)});localStorage.setItem('nexus_user',{json.dumps(json.dumps(user or login['user']))});")
            pg = await ctx.new_page()
            def failing(status):
                async def handler(route):
                    await route.fulfill(status=status, content_type='application/json', body=json.dumps({'error': 'server_error', 'message': 'Simulated failure.'}))
                return handler
            for pattern, status in (routes or []):
                await pg.route(pattern, failing(status))
            pg.on('console', lambda m: log.append(f'[{m.type}] {m.text}') if m.type == 'error' else None)
            pg.on('pageerror', lambda e: log.append(f'[pageerror] {e}'))
            return pg
        async def shot(pg, name, full=True):
            if full:
                hh = await pg.evaluate("document.querySelector('.shell-content') ? document.querySelector('.shell-content').scrollHeight + 60 : document.body.scrollHeight")
                await pg.set_viewport_size({'width': pg.viewport_size['width'], 'height': max(900, hh)})
            await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'{OUT}/{name}.png', full_page=full)
        async def inventory(pg):
            await pg.goto('http://localhost:3000/index.html?page=inventory'); await pg.wait_for_timeout(2200)
        async def open_product(pg, name):
            await pg.click(f'tr[aria-label="Open {name}"]'); await pg.wait_for_timeout(1200)

        P = ids()
        ev['0_after_migration_and_demo_script'] = {'items': items(), 'tables': stock_tables()}

        # 1. Distinct states on the overview.
        pg = await page(); await inventory(pg); await shot(pg, '01_overview')
        ev['1_overview_text'] = {n: await pg.locator(f'tr[aria-label="Open {n}"] td:nth-child(2)').inner_text() for n in ['Pashmina Shawl', 'Prayer Mat', 'Lawn Suit 3-Piece']}
        await open_product(pg, 'Lawn Suit 3-Piece'); await shot(pg, '02_lawn_drawer', full=False)
        await pg.click('dialog[open] >> button:has-text("History")'); await pg.wait_for_timeout(500); await shot(pg, '03_lawn_history', full=False)

        # 2. Count -> shipments -> newer count (entered in the UI): no double deduction.
        lawn_before = items()['Lawn Suit 3-Piece']['on_hand']
        await pg.click('dialog[open] >> button:has-text("Record count")'); await pg.wait_for_timeout(300)
        await pg.fill('#cnt-qty', '54')
        await pg.click('dialog[open] >> button.btn-primary:has-text("Record count")'); await pg.wait_for_timeout(1500)
        await shot(pg, '04_lawn_newer_count', full=False)
        lawn_after_count = items()['Lawn Suit 3-Piece']['on_hand']
        detail = call('GET', f"/inventory/items/{P['Lawn Suit 3-Piece']}", token=A)[1]
        ev['2_count_shipment_newer_count'] = {'before_newer_count': lawn_before, 'newer_count_entered': 54, 'on_hand_after': lawn_after_count,
            'movements_relation': [(m['quantity'], m['relation']) for m in detail['movements']]}

        # 4. Shipment after the newer count, its replay, and a conflicting replay.
        src = [s for s in call('GET', '/data/sources', token=A)[1]['sources'] if s['kind'] == 'api'][0]['id']
        event = {'external_event_id': f'e2e-{uuid.uuid4().hex[:8]}', 'kind': 'shipment', 'product_id': P['Lawn Suit 3-Piece'], 'quantity': 4,
                 'effective_at': iso(datetime.now(timezone.utc)), 'order_ref': 'DRZ-E2E-1'}
        r1 = call('POST', '/inventory/movements', {'source_id': src, 'events': [event]}, token=A)
        oh1 = items()['Lawn Suit 3-Piece']['on_hand']
        t_before = stock_tables()
        r2 = call('POST', '/inventory/movements', {'source_id': src, 'events': [event]}, token=A)
        r3 = call('POST', '/inventory/movements', {'source_id': src, 'events': [{**event, 'external_event_id': event['external_event_id'] + '-new'}, {**event, 'quantity': 6}]}, token=A)
        ev['4_replay'] = {'first': [r1[0], r1[1]['recorded']], 'on_hand_after_first': oh1,
            'replay': [r2[0], {'recorded': r2[1]['recorded'], 'replayed': r2[1]['replayed']}], 'on_hand_after_replay': items()['Lawn Suit 3-Piece']['on_hand'],
            'conflicting_replay': [r3[0], r3[1]['error'], r3[1]['message']], 'tables_unchanged_by_replay_and_conflict': t_before == stock_tables()}

        # 3. Revoke the newer count in the UI: the position is recomputed from the older count.
        await pg.close()
        pg = await page(); await inventory(pg); await open_product(pg, 'Lawn Suit 3-Piece')
        await pg.click('dialog[open] >> button:has-text("History")'); await pg.wait_for_timeout(500)
        await shot(pg, '05a_history_before_revoke', full=False)
        await pg.locator('dialog[open] >> button:has-text("Revoke")').first.click(); await pg.wait_for_timeout(1500)
        await shot(pg, '05b_after_revoke', full=False)
        ev['3_revoke_newer_count'] = {'on_hand_after_revoke': items()['Lawn Suit 3-Piece']['on_hand'], 'expected': '64 (older count) - 3 - 2 - 4 (demo shipments) - 4 (e2e shipment) = 51'}

        # Conflicting count at the same instant -> explicit replacement.
        bridal = call('GET', f"/inventory/items/{P['Bridal Clutch']}", token=A)[1]['stock']['last_count']
        local = datetime.fromisoformat(bridal['observed_at'].replace('Z', '+00:00')).astimezone(KHI).strftime('%Y-%m-%dT%H:%M')
        await pg.click('dialog[open] >> button:has-text("Close")'); await pg.wait_for_timeout(300)
        await open_product(pg, 'Bridal Clutch')
        await pg.fill('#cnt-qty', '5'); await pg.fill('#cnt-when', local)
        await pg.click('dialog[open] >> button.btn-primary:has-text("Record count")'); await pg.wait_for_timeout(1200)
        await shot(pg, '06_same_instant_conflict', full=False)
        conflict_shown = await pg.locator('dialog[open] >> text=already recorded for this product at exactly this time').count()
        await pg.click('dialog[open] >> button:has-text("Replace it with 5")'); await pg.wait_for_timeout(1500)
        await shot(pg, '07_replaced', full=False)
        ev['count_same_instant'] = {'conflict_prompt_shown': conflict_shown == 1, 'on_hand_after_replace': items()['Bridal Clutch']['on_hand'],
            'history': [(c['quantity'], c['status']) for c in call('GET', f"/inventory/items/{P['Bridal Clutch']}", token=A)[1]['counts']]}
        await pg.close()

        # 5. A historical sales upload with stock columns leaves inventory unchanged.
        today = datetime.now(KHI).strftime('%Y-%m-%d')
        csv = 'product_name,category,price,quantity,sale_date,revenue,stock_level,reorder_threshold\n' \
              f'Ceramic Mug Set,Home,1800,2,{today},3600,500,10\nSilk Dupatta,Clothing,3200,1,{today},3200,40,10\n'
        path = '/tmp/claude-0/sales_with_stock.csv'; open(path, 'w').write(csv)
        before = {'items': items(), 'tables': stock_tables()}
        pg = await page(); await pg.goto('http://localhost:3000/index.html?page=upload'); await pg.wait_for_timeout(1500)
        await pg.set_input_files('input[type=file]', path); await pg.wait_for_timeout(500)
        await pg.click('text=Process & upload file'); await pg.wait_for_timeout(4500)
        await shot(pg, '08_sales_upload_stock_columns_ignored')
        after = {'items': items(), 'tables': stock_tables()}
        ev['5_sales_upload'] = {'tables_before': before['tables'], 'tables_after': after['tables'],
            'on_hand_before': {k: v['on_hand'] for k, v in before['items'].items()},
            'on_hand_after': {k: v['on_hand'] for k, v in after['items'].items()},
            'mug_tracking_before_after': [before['items']['Ceramic Mug Set']['tracking'], after['items']['Ceramic Mug Set']['tracking']],
            'new_product': after['items'].get('Silk Dupatta')}
        await pg.close()
        pg = await page(); await inventory(pg); await shot(pg, '09_inventory_after_sales_upload'); await pg.close()

        # Stock-count file (bulk) with a rejected row, then its version and rollback.
        cpath = '/tmp/claude-0/stock_count.csv'
        open(cpath, 'w').write('product_name,quantity\nSilk Dupatta,14\nCeramic Mug Set,19\nGhost Item,3\nPrayer Mat,2.5\n')
        pg = await page(); await inventory(pg)
        await pg.click('button:has-text("Stock count file")'); await pg.wait_for_timeout(500)
        await pg.set_input_files('#cf-file', cpath)
        await pg.click('dialog[open] >> button:has-text("Import counts")'); await pg.wait_for_timeout(2000)
        await shot(pg, '10_count_file_result', full=False)
        await pg.close()
        vers = call('GET', '/data/versions', token=A)[1]['versions']
        pg = await page(); await pg.goto('http://localhost:3000/index.html?page=upload'); await pg.wait_for_timeout(1800)
        await pg.locator('#history-title').scroll_into_view_if_needed(); await shot(pg, '11_upload_history')
        await pg.close()
        mid = items()
        rb = call('POST', f"/data/rollback/{vers[0]['upload_id']}", token=A)
        ev['count_file'] = {'latest_version': {k: vers[0][k] for k in ('version_number', 'source', 'rows_added', 'rows_rejected')},
            'after_import': {k: mid[k]['on_hand'] for k in ('Silk Dupatta', 'Ceramic Mug Set')},
            'rollback': [rb[0], rb[1].get('kind'), rb[1].get('stock_counts_revoked')],
            'after_rollback': {k: items()[k]['on_hand'] for k in ('Silk Dupatta', 'Ceramic Mug Set')}}

        # Dashboard: unknown stock separated from risks.
        pg = await page(); await pg.goto('http://localhost:3000/index.html?page=dashboard'); await pg.wait_for_timeout(3500)
        await pg.locator('#risks-title').scroll_into_view_if_needed(); await shot(pg, '12_dashboard'); await pg.close()

        # 6. Another seller: empty page, and every attempt on seller A's records is refused.
        email = f'other-{uuid.uuid4().hex[:6]}@nexus.local'
        reg = call('POST', '/auth/register', {'name': 'Other Seller', 'email': email, 'password': 'secret123'})[1]
        B = reg['token']
        lawn = P['Lawn Suit 3-Piece']
        some_batch = call('GET', f'/inventory/items/{lawn}', token=A)[1]['counts'][0]['batch_id']
        t0 = stock_tables()
        attempts = {
            'GET item': call('GET', f'/inventory/items/{lawn}', token=B)[0],
            'PATCH policy': call('PATCH', f'/inventory/items/{lawn}/policy', {'reorder_threshold': 1}, token=B)[0],
            'POST count on A product id': call('POST', '/inventory/snapshots', {'idempotency_key': 'x', 'observed_at': iso(datetime.now(timezone.utc)), 'items': [{'product_id': lawn, 'quantity': 1}]}, token=B)[0],
            'POST count by A product name': call('POST', '/inventory/snapshots', {'idempotency_key': 'y', 'observed_at': iso(datetime.now(timezone.utc)), 'items': [{'product_name': 'Lawn Suit 3-Piece', 'quantity': 1}]}, token=B)[0],
            'POST movement on A product': call('POST', '/inventory/movements', {'idempotency_key': 'z', 'product_id': lawn, 'kind': 'damage', 'quantity': 1, 'effective_at': iso(datetime.now(timezone.utc)), 'reason': 'x'}, token=B)[0],
            'POST shipment via A source': call('POST', '/inventory/movements', {'source_id': src, 'events': [{'external_event_id': 'q', 'kind': 'shipment', 'product_id': lawn, 'quantity': 1, 'effective_at': iso(datetime.now(timezone.utc))}]}, token=B)[0],
            'POST revoke A count': call('POST', f'/inventory/snapshots/{some_batch}/revoke', token=B)[0],
            'GET A source mapping': call('GET', f'/inventory/sources/{src}', token=B)[0],
            'GET items list (B)': len(call('GET', '/inventory/items', token=B)[1]['items']),
            'GET alerts (B)': len(call('GET', '/inventory/alerts', token=B)[1]),
        }
        ev['6_isolation'] = {'responses': attempts, 'tables_unchanged': t0 == stock_tables()}
        pg = await page(token=B, user=reg['user']); await inventory(pg); await shot(pg, '13_other_seller_empty'); await pg.close()

        # 7. Failed API responses show real error states (no sample data).
        pg = await page(routes=[('**/api/inventory/items?*', 500)]); await inventory(pg); await pg.wait_for_timeout(4000)
        await shot(pg, '14_inventory_error'); ev['7_error_state_text'] = await pg.locator('.empty-state').first.inner_text(); await pg.close()
        pg = await page(routes=[('**/api/inventory/alerts', 500)]); await pg.goto('http://localhost:3000/index.html?page=dashboard'); await pg.wait_for_timeout(6000)
        await pg.locator('#risks-title').scroll_into_view_if_needed(); await shot(pg, '15_dashboard_alerts_error'); await pg.close()
        pg = await page(); await pg.goto('http://localhost:3000/index.html?page=inventory'); await pg.wait_for_timeout(2200)
        await pg.click('button:has-text("Below threshold")'); await pg.wait_for_timeout(800); await pg.fill('input[aria-label="Search products"]', 'zzz'); await pg.wait_for_timeout(1200)
        await shot(pg, '16_filter_no_match'); await pg.close()
        pg = await page(w=390, h=844); await inventory(pg); await shot(pg, '17_mobile'); await pg.close()

        ev['final'] = {'items': items(), 'tables': stock_tables()}
        await b.close()

try:
    asyncio.run(main())
finally:
    srv.terminate()
    json.dump(ev, open(f'{OUT}/evidence.json', 'w'), indent=2, default=str)
    open(f'{OUT}/console.log', 'w').write('\n'.join(log))
    print(json.dumps(ev, indent=1, default=str)[:6000]); print('console errors:', len(log)); print('\n'.join(log[:20]))
