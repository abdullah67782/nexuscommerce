# Stage 1b acceptance run: suppliers, purchase orders, receipts, correction, supplier
# return and cancellation after a partial receipt — through the REAL React pages,
# backend (5000) and PostgreSQL (nexus_demo4 migrated to 005). Screens + evidence.json.
import asyncio, json, os, subprocess, sys, time, urllib.request, uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from playwright.async_api import async_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'shots_po'
os.makedirs(OUT, exist_ok=True)
KHI = ZoneInfo('Asia/Karachi')
BASE = 'http://localhost:5000/api'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '3000', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
log, ev = [], {}

def call(method, path, body=None, token=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={**({'Authorization': f'Bearer {token}'} if token else {}), 'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, None

login = call('POST', '/auth/login', {'email': 'ayesha@lahorestore.pk', 'password': 'demo-pass-2026'})[1]
A = login['token']
def stock(name):
    items = call('GET', '/inventory/items?page_size=200', token=A)[1]['items']
    i = next(x for x in items if x['name'] == name)
    return {'on_hand': i['stock']['on_hand'], 'incoming': i['inbound']['open_quantity'], 'approved_not_sent': i['inbound']['approved_not_sent'],
            'overdue': i['inbound']['overdue_quantity'], 'inbound_state': i['readiness']['inbound']['state'], 'supplier_state': i['readiness']['supplier']['state']}
def moves():
    return int(subprocess.run(['psql', '-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', 'nexus_demo4', '-At', '-c',
        'SELECT COUNT(*) FROM stock_movements'], capture_output=True, text=True).stdout.strip())
def order(i): return call('GET', f'/purchase-orders/{i}', token=A)[1]
def day(offset): return (datetime.now(KHI) + timedelta(days=offset)).strftime('%Y-%m-%d')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1, reduced_motion='reduce', timezone_id='Asia/Karachi')
        await ctx.add_init_script(f"localStorage.setItem('nexus_token',{json.dumps(A)});localStorage.setItem('nexus_user',{json.dumps(json.dumps(login['user']))});")
        pg = await ctx.new_page()
        pg.on('console', lambda m: log.append(f'[{m.type}] {m.text}') if m.type == 'error' else None)
        pg.on('pageerror', lambda e: log.append(f'[pageerror] {e}'))
        async def shot(name, full=False):
            if full:
                hh = await pg.evaluate("document.querySelector('.shell-content') ? document.querySelector('.shell-content').scrollHeight + 60 : document.body.scrollHeight")
                await pg.set_viewport_size({'width': 1440, 'height': max(900, hh)})
            await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'{OUT}/{name}.png', full_page=full)
            await pg.set_viewport_size({'width': 1440, 'height': 900})
        async def dialog_shot(name):
            # The whole open dialog, scrolled content included.
            h = await pg.evaluate("(() => { const d = document.querySelector('dialog[open]'); return d ? d.scrollHeight + 80 : 900; })()")
            await pg.set_viewport_size({'width': 1440, 'height': max(900, min(h, 4000))})
            await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'{OUT}/{name}.png')
            await pg.set_viewport_size({'width': 1440, 'height': 900})
        D = 'dialog[open] >> '
        async def tab(label):
            await pg.goto('http://localhost:3000/index.html?page=inventory'); await pg.wait_for_timeout(1800)
            await pg.click(f'[aria-label="Inventory section"] >> button:has-text("{label}")')
            await pg.wait_for_timeout(1200)

        ev['0_before'] = {n: stock(n) for n in ['Lawn Suit 3-Piece', 'Prayer Mat', 'Ceramic Mug Set']}

        # ── Suppliers and terms ─────────────────────────────────────────────
        await tab('Suppliers'); await shot('01_suppliers_empty')
        async def add_supplier(name, currency='PKR'):
            await pg.click('button:has-text("Add supplier")'); await pg.wait_for_timeout(500)
            await pg.fill('#sup-name', name); await pg.fill('#sup-cur', currency)
            await pg.click(D + 'button:has-text("Add supplier")'); await pg.wait_for_timeout(1500)
        async def link(product, cost, lead, moq, pack, preferred=False):
            await pg.click(D + 'button:has-text("Link a product")'); await pg.wait_for_timeout(600)
            await pg.select_option('#t-prod', label=product)
            await pg.fill('#t-cost', cost); await pg.fill('#t-lead', lead); await pg.fill('#t-moq', moq); await pg.fill('#t-pack', pack)
            if preferred: await pg.check(D + 'text=Preferred supplier')
            await pg.click(D + 'button:has-text("Save terms")'); await pg.wait_for_timeout(1200)
        await add_supplier('Faisalabad Textile Mills')
        await link('Lawn Suit 3-Piece', '2800', '10', '20', '10', True)
        await link('Prayer Mat', '900', '7', '12', '6', True)
        await dialog_shot('02_supplier_terms')
        await pg.click(D + 'button:has-text("Close")'); await pg.wait_for_timeout(500)
        await add_supplier('Hyderabad Ceramics')
        await link('Ceramic Mug Set', '', '', '1', '1')
        await pg.click(D + 'button:has-text("Close")'); await pg.wait_for_timeout(800)
        await shot('03_suppliers_list')
        ev['1_suppliers'] = call('GET', '/suppliers', token=A)[1]['suppliers']
        ev['1_mug_supplier_readiness'] = stock('Ceramic Mug Set')['supplier_state']

        # ── New draft with live pack/minimum validation ────────────────────
        await tab('Purchase orders')
        await pg.click('button:has-text("New purchase order")'); await pg.wait_for_timeout(600)
        await pg.select_option('#po-sup', label='Faisalabad Textile Mills'); await pg.wait_for_timeout(1200)
        await pg.fill('input[aria-label="Quantity of Lawn Suit 3-Piece"]', '25')
        await pg.fill('input[aria-label="Quantity of Prayer Mat"]', '12')
        await pg.fill('#po-eta', day(5))
        await dialog_shot('04_new_draft_pack_warning')
        await pg.fill('input[aria-label="Quantity of Lawn Suit 3-Piece"]', '30')
        moves_before = moves()
        await pg.click(D + 'button:has-text("Create draft")'); await pg.wait_for_timeout(2000)
        await dialog_shot('05_draft')
        po1 = (call('GET', '/purchase-orders?status=draft', token=A)[1]['purchase_orders'])[0]['id']

        # ── Approve → ordered: no stock change ──────────────────────────────
        await pg.click(D + 'button:has-text("Approve")'); await pg.wait_for_timeout(1500)
        ev['2_after_approve'] = {'status': order(po1)['status'], 'lawn': stock('Lawn Suit 3-Piece'), 'movements_unchanged': moves() == moves_before}
        await pg.click(D + 'button:has-text("Mark as ordered")'); await pg.wait_for_timeout(1500)
        await dialog_shot('06_ordered')
        ev['3_after_ordered'] = {'status': order(po1)['status'], 'lawn': stock('Lawn Suit 3-Piece'), 'prayer_mat': stock('Prayer Mat'),
                                 'movements_unchanged': moves() == moves_before}
        await pg.click(D + 'button:has-text("Close")'); await pg.wait_for_timeout(400)
        await tab('Stock'); await shot('07_stock_incoming_separate', full=True)

        # ── Partial receipt, then completion ────────────────────────────────
        await tab('Purchase orders')
        await pg.click(f'tr[aria-label="Open purchase order {po1}"]'); await pg.wait_for_timeout(1200)
        await pg.click(D + 'button:has-text("Receive goods")'); await pg.wait_for_timeout(400)
        lines = {l['product_name']: l['id'] for l in order(po1)['lines']}
        await pg.fill(f"#rq-{lines['Lawn Suit 3-Piece']}", '20')
        await pg.click(D + 'button:has-text("Record receipt")'); await pg.wait_for_timeout(1800)
        await dialog_shot('08_partial_receipt')
        ev['4_partial'] = {'status': order(po1)['status'], 'lawn': stock('Lawn Suit 3-Piece')}
        await pg.click(D + 'button:has-text("Receive goods")'); await pg.wait_for_timeout(400)
        await pg.fill(f"#rq-{lines['Lawn Suit 3-Piece']}", '10'); await pg.fill(f"#rq-{lines['Prayer Mat']}", '12')
        await pg.click(D + 'button:has-text("Record receipt")'); await pg.wait_for_timeout(1800)
        await dialog_shot('09_received_complete')
        o = order(po1)
        ev['5_complete'] = {'status': o['status'], 'completed_at': o['completed_at'], 'lawn': stock('Lawn Suit 3-Piece'), 'prayer_mat': stock('Prayer Mat')}

        # Receipt replay through the API: same id, same content → nothing added.
        r2 = o['receipts'][1]
        n0, oh0 = moves(), stock('Prayer Mat')['on_hand']
        replay = call('POST', f'/purchase-orders/{po1}/receipts', {'idempotency_key': r2['idempotency_key'], 'received_at': r2['received_at'],
            'lines': [{'line_id': lines['Lawn Suit 3-Piece'], 'quantity': 10}, {'line_id': lines['Prayer Mat'], 'quantity': 12}]}, token=A)
        ev['6_receipt_replay'] = {'status': replay[0], 'replayed': replay[1].get('replayed'), 'movements_unchanged': moves() == n0,
                                  'prayer_mat_unchanged': stock('Prayer Mat')['on_hand'] == oh0}

        # ── Correction (recorded wrongly) and supplier return (sent back) ──
        await pg.locator(D + 'button:has-text("Correct receipt")').nth(1).click(); await pg.wait_for_timeout(400)
        pm_rl = next(l['receipt_line_id'] for l in r2['lines'] if l['po_line_id'] == lines['Prayer Mat'])
        await pg.fill(f'#aq-{pm_rl}', '2'); await pg.fill('#aq-reason', 'Recorded 12; only 10 mats were in the delivery')
        await pg.click(D + 'button:has-text("Record correction")'); await pg.wait_for_timeout(1800)
        await dialog_shot('10_receipt_correction')
        o = order(po1)
        ev['7_correction'] = {'status': o['status'], 'prayer_mat_line': next({k: l[k] for k in ('quantity_received', 'quantity_corrected', 'quantity_remaining')} for l in o['lines'] if l['product_name'] == 'Prayer Mat'),
                              'prayer_mat_stock': stock('Prayer Mat'), 'effect': o['adjustments'][-1]}
        r1 = o['receipts'][0]
        lawn_rl = r1['lines'][0]['receipt_line_id']
        await pg.locator(D + 'button:has-text("Return to supplier")').nth(0).click(); await pg.wait_for_timeout(400)
        await pg.fill(f'#aq-{lawn_rl}', '3'); await pg.fill('#aq-reason', 'Three suits with print defects sent back')
        await pg.click(D + 'button:has-text("Record return")'); await pg.wait_for_timeout(1800)
        await dialog_shot('11_supplier_return')
        o = order(po1)
        ev['8_return'] = {'status': o['status'], 'lawn_line': next({k: l[k] for k in ('quantity_received', 'quantity_returned', 'quantity_remaining')} for l in o['lines'] if l['product_name'] == 'Lawn Suit 3-Piece'),
                          'lawn_stock': stock('Lawn Suit 3-Piece'), 'effect': o['adjustments'][-1]}
        # Expected-arrival revision kept in history.
        await pg.fill('#po-arrival', day(3)); await pg.fill('#po-arrival-reason', 'Remaining mats promised sooner')
        await pg.click(D + 'button:has-text("Save")'); await pg.wait_for_timeout(1500)
        await dialog_shot('12_order_history')
        ev['9_history'] = [(e['event'], e['from_status'], e['to_status']) for e in order(po1)['events']]
        await pg.click(D + 'button:has-text("Close")'); await pg.wait_for_timeout(400)

        # Stale version is refused, not overwritten.
        stale = call('PATCH', f'/purchase-orders/{po1}', {'version': 1, 'expected_arrival': day(9)}, token=A)
        ev['10_stale_version'] = [stale[0], stale[1]['error']]

        # ── Second order: overdue, partial receipt, cancel the remainder ────
        st, d2 = call('POST', '/purchase-orders', {'idempotency_key': str(uuid.uuid4()), 'supplier_id': ev['1_suppliers'][0]['id'] if ev['1_suppliers'][0]['name'].startswith('Faisalabad') else ev['1_suppliers'][1]['id'],
            'expected_arrival': day(-2), 'lines': [{'product_id': next(l['product_id'] for l in order(po1)['lines'] if l['product_name'] == 'Lawn Suit 3-Piece'), 'quantity': 20}]}, token=A)
        po2 = d2['purchase_order']['id']
        v = d2['purchase_order']['version']
        v = call('POST', f'/purchase-orders/{po2}/approve', {'version': v}, token=A)[1]['purchase_order']['version']
        v = call('POST', f'/purchase-orders/{po2}/mark-ordered', {'version': v}, token=A)[1]['purchase_order']['version']
        await tab('Purchase orders'); await shot('13_orders_list_overdue', full=True)
        ev['11_overdue'] = {'list_overdue': next(x['overdue'] for x in call('GET', '/purchase-orders?status=open', token=A)[1]['purchase_orders'] if x['id'] == po2),
                            'lawn': stock('Lawn Suit 3-Piece')}
        await pg.click(f'tr[aria-label="Open purchase order {po2}"]'); await pg.wait_for_timeout(1200)
        await pg.click(D + 'button:has-text("Receive goods")'); await pg.wait_for_timeout(400)
        l2 = order(po2)['lines'][0]['id']
        await pg.fill(f'#rq-{l2}', '10'); await pg.click(D + 'button:has-text("Record receipt")'); await pg.wait_for_timeout(1800)
        lawn_before_cancel = stock('Lawn Suit 3-Piece')
        await pg.click(D + 'button:has-text("Cancel the remainder")'); await pg.wait_for_timeout(400)
        await pg.fill('#cancel-reason', 'Mill cannot supply the rest this season')
        await pg.click(D + 'button.btn-danger:has-text("Cancel order")'); await pg.wait_for_timeout(1800)
        await dialog_shot('14_cancelled_after_partial')
        o2 = order(po2)
        after_rec = call('POST', f'/purchase-orders/{po2}/receipts', {'idempotency_key': str(uuid.uuid4()), 'received_at': iso_now(),
            'lines': [{'line_id': l2, 'quantity': 1}]}, token=A)
        reopen = call('POST', f'/purchase-orders/{po2}/approve', {'version': o2['version']}, token=A)
        ev['12_cancel_after_partial'] = {'status': o2['status'], 'line': {k: o2['lines'][0][k] for k in ('quantity_received', 'quantity_cancelled', 'quantity_remaining')},
            'lawn_before_cancel': lawn_before_cancel, 'lawn_after_cancel': stock('Lawn Suit 3-Piece'),
            'receive_after_cancel': [after_rec[0], after_rec[1]['error']], 'approve_after_cancel': [reopen[0], reopen[1]['error']]}
        await pg.click(D + 'button:has-text("Close")'); await pg.wait_for_timeout(400)

        # ── Later count stays authoritative over a correction of an earlier receipt ──
        st, cnt = call('POST', '/inventory/snapshots', {'idempotency_key': str(uuid.uuid4()), 'observed_at': iso_now(),
            'items': [{'product_id': next(l['product_id'] for l in o['lines'] if l['product_name'] == 'Lawn Suit 3-Piece'), 'quantity': 70}]}, token=A)
        lawn_after_count = stock('Lawn Suit 3-Piece')['on_hand']
        o = order(po1)
        corr = call('POST', f"/purchase-orders/{po1}/receipts/{o['receipts'][0]['id']}/corrections", {'idempotency_key': str(uuid.uuid4()),
            'reason': 'One suit double-scanned at the door', 'lines': [{'receipt_line_id': lawn_rl, 'quantity': 1}]}, token=A)
        ev['13_count_authoritative'] = {'count': 70, 'on_hand_after_count': lawn_after_count, 'correction_status': corr[0],
            'on_hand_after_correction': stock('Lawn Suit 3-Piece')['on_hand']}

        # ── Another seller ──
        reg = call('POST', '/auth/register', {'name': 'Other', 'email': f'o-{uuid.uuid4().hex[:6]}@nexus.local', 'password': 'secret123'})[1]
        B = reg['token']
        ev['14_isolation'] = {'get_po': call('GET', f'/purchase-orders/{po1}', token=B)[0], 'list': len(call('GET', '/purchase-orders', token=B)[1]['purchase_orders']),
            'suppliers': len(call('GET', '/suppliers', token=B)[1]['suppliers']),
            'receive': call('POST', f'/purchase-orders/{po1}/receipts', {'idempotency_key': 'x', 'received_at': iso_now(), 'lines': [{'line_id': lines['Prayer Mat'], 'quantity': 1}]}, token=B)[0]}

        await tab('Stock'); await shot('15_stock_after_purchasing', full=True)
        await pg.click('tr[aria-label="Open Lawn Suit 3-Piece"]'); await pg.wait_for_timeout(1200)
        await pg.click(D + 'button:has-text("History")'); await pg.wait_for_timeout(600)
        await dialog_shot('16_lawn_ledger_history')
        ev['final'] = {n: stock(n) for n in ['Lawn Suit 3-Piece', 'Prayer Mat', 'Ceramic Mug Set']}
        await b.close()

def iso_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

try:
    asyncio.run(main())
finally:
    srv.terminate()
    json.dump(ev, open(f'{OUT}/evidence.json', 'w'), indent=2, default=str)
    open(f'{OUT}/console.log', 'w').write('\n'.join(log))
    print(json.dumps({k: v for k, v in ev.items() if k != '1_suppliers'}, indent=1, default=str)[:7000]); print('console errors:', len(log)); print('\n'.join(log[:20]))
