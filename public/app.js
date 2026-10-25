// Dashboard: plain JS, polls the JSON API. Buyer data arrives already masked.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const LETTER = { membership: 'Access', email: 'Email', n8n: 'n8n' };

let tab = 'overview';
let openEvent = null;
let logAfter = 0;
const seenSlack = new Set();
const seenOrders = new Set();
let firstSheet = true;

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return res.json();
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function setTile(id, value) {
  const el = $(`#${id} .value`);
  if (el.textContent !== String(value)) {
    el.textContent = value;
    const tile = $(`#${id}`);
    tile.classList.remove('bump');
    void tile.offsetWidth;
    tile.classList.add('bump');
  }
}

function deliveryState(d) {
  if (d.status === 'delivered') return 'ok';
  if (d.status === 'dead') return 'dead';
  if (d.attempts > 0) return 'retry';
  return 'wait';
}

// ---------- overview ----------
async function refreshStats() {
  const s = await get('/api/stats');
  setTile('t-events', s.eventsToday);
  setTile('t-delivered', s.delivered);
  setTile('t-retrying', s.retrying);
  setTile('t-dead', s.deadLetter);
  setTile('t-misses', s.silentMisses);
  const dc = $('#dead-count');
  dc.textContent = s.deadLetter;
  dc.classList.toggle('hot', s.deadLetter > 0);
}

async function refreshEvents() {
  const events = (await get('/api/events?limit=60')).reverse();
  if (events.length === 0) return;
  $('#events').innerHTML = events
    .map((e) => {
      const states = e.deliveries.map(deliveryState);
      const worst = states.includes('dead') ? 'dead' : states.includes('retry') ? 'retry' : states.every((s) => s === 'ok') ? 'ok' : 'wait';
      const ds = ['membership', 'email', 'n8n']
        .map((name) => {
          const d = e.deliveries.find((x) => x.destination === name);
          if (!d) return '';
          const st = deliveryState(d);
          const label = st === 'retry' ? `${LETTER[name]} x${d.attempts}` : st === 'dead' ? 'Dead' : LETTER[name];
          return `<span class="d ${st}" title="${esc(d.lastError ?? '')}">${label}</span>`;
        })
        .join('');
      const extra = e.type === 'purchase.created' ? '' : `<span class="tag">${esc(e.type === 'tag.applied' ? `tag ${e.tag}` : 'cancelled')}</span>`;
      return `<div class="ev s-${worst}" data-id="${e.id}"><div class="who">${esc(e.buyer)} <small>#${esc(e.order)}</small></div>${extra}<div class="ds">${ds}</div></div>`;
    })
    .join('');
}

async function refreshLog() {
  const { running, lines } = await get(`/api/chaos/log?after=${logAfter}`);
  const term = $('#terminal');
  if (lines.length && logAfter === 0) term.innerHTML = '';
  for (const l of lines) {
    const div = document.createElement('div');
    div.className = `line ${l.level}`;
    div.textContent = l.text;
    term.appendChild(div);
    logAfter = l.n;
  }
  if (lines.length) term.scrollTop = term.scrollHeight;
  const btn = $('#chaos-start');
  btn.disabled = running;
  btn.textContent = running ? 'Running...' : 'Start chaos test';
}

$('#chaos-start').addEventListener('click', async () => {
  logAfter = 0;
  $('#terminal').innerHTML = '<div class="line dim">Starting...</div>';
  const params = new URLSearchParams(location.search);
  const body = { failRate: 0.2, dropRate: 0.05 };
  if (params.get('outage')) {
    const [dest, secs] = params.get('outage').split(':');
    body.outageDestination = dest;
    body.outageSeconds = Number(secs);
  }
  await post('/api/chaos/start', body);
});

$('#events').addEventListener('click', (ev) => {
  const card = ev.target.closest('.ev');
  if (card) showEvent(card.dataset.id);
});

// ---------- event drawer ----------
async function showEvent(id) {
  openEvent = id;
  const e = await get(`/api/events/${id}`);
  $('#drawer-title').textContent = `${e.buyer}, order #${e.order}`;
  $('#drawer-body').innerHTML = `
    <dl class="kv">
      <dt>Event</dt><dd>${esc(e.type)}</dd>
      <dt>Product</dt><dd>${esc(e.product ?? e.tag ?? '')}</dd>
      <dt>Arrived by</dt><dd>${e.origin === 'reconciliation' ? 'Reconciliation (webhook never arrived)' : 'Webhook'}</dd>
      <dt>Saved at</dt><dd>${time(e.receivedAt)}</dd>
    </dl>
    <h3>Timeline</h3>
    <ul class="timeline">${e.timeline.map((t) => `<li class="${t.kind}"><time>${time(t.at)}</time>${esc(t.message)}</li>`).join('')}</ul>
    <p><button class="btn" id="replay-event">Replay this event</button></p>`;
  $('#replay-event').onclick = async () => {
    await post(`/api/events/${id}/replay`);
    toast('Replayed. Tools that already have it will ignore the repeat.');
    showEvent(id);
  };
  $('#drawer').classList.add('open');
}
$('#drawer-close').addEventListener('click', () => {
  openEvent = null;
  $('#drawer').classList.remove('open');
});

// ---------- dead letter ----------
async function refreshDead() {
  const rows = await get('/api/dead-letter');
  const body = $('#dead-table tbody');
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Nothing waiting. Every delivery went through.</td></tr>';
    return;
  }
  const leaving = new Set([...body.querySelectorAll('tr.leaving')].map((r) => r.dataset.id));
  body.innerHTML = rows
    .map(
      (r) => `<tr data-id="${r.id}" class="${leaving.has(r.id) ? 'leaving' : ''}"><td><b>#${esc(r.order)}</b></td><td>${esc(r.buyer)}</td><td>${esc(r.destination)}</td><td>${r.attempts}</td><td><span class="pill retry">${esc(r.lastError)}</span></td><td>${time(r.failedAt)}</td>
      <td><button class="btn green small replay" data-id="${r.id}" data-label="${esc(r.buyer)} (order ${esc(r.order)})" data-dest="${esc(r.destination)}">Replay</button></td></tr>`,
    )
    .join('');
}
$('#dead-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.replay');
  if (!btn) return;
  btn.disabled = true;
  btn.closest('tr').classList.add('leaving');
  await post(`/api/deliveries/${btn.dataset.id}/replay`);
  toast(`Replaying ${btn.dataset.label} to the ${btn.dataset.dest}`);
});
$('#replay-all').addEventListener('click', async () => {
  const r = await post('/api/dead-letter/replay-all');
  toast(`Replaying ${r.replayed} deliveries`);
});

// ---------- reconciliation ----------
const KIND = { missed_webhook: 'Webhook never arrived from the store', destination_dropped: 'said "ok" but did not save it' };
async function refreshRecon() {
  const r = await get('/api/reconciliation');
  $('#recon-hint').textContent = `Every ${r.intervalMinutes} minutes the guard asks the store for recent purchases and checks that every buyer really has an account and a welcome email.`;
  const last = r.runs[0];
  const status = $('#recon-status');
  if (last && last.finished_at) {
    status.textContent = `Last check at ${time(last.finished_at)}: ${last.checked} purchases checked, ${last.misses} silent ${last.misses === 1 ? 'miss' : 'misses'} found and queued again.`;
    status.classList.toggle('found', last.misses > 0);
  } else if (!last) status.textContent = 'No check has run yet.';
  const body = $('#miss-table tbody');
  body.innerHTML = r.misses.length
    ? r.misses
        .map((m) => {
          const what = m.kind === 'missed_webhook' ? KIND.missed_webhook : `${esc(m.destination)} ${KIND.destination_dropped}`;
          const now = m.now === 'delivered' ? '<span class="pill ok">Delivered</span>' : m.now === 'dead' ? '<span class="pill retry">Dead letter</span>' : '<span class="pill warn">Replaying</span>';
          return `<tr><td><b>#${esc(m.order_id)}</b></td><td>${esc(m.first_name)}</td><td>${what}</td><td>${time(m.at)}</td><td>${now}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">No silent misses found.</td></tr>';
}
$('#recon-run').addEventListener('click', async () => {
  const btn = $('#recon-run');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  $('#recon-status').textContent = 'Asking the store for recent purchases and comparing with the membership site and email sender...';
  const r = await post('/api/reconciliation/run');
  btn.disabled = false;
  btn.textContent = 'Run check now';
  if (r.error) toast(`Check failed: ${r.error}`);
  else toast(`${r.misses.length} silent ${r.misses.length === 1 ? 'miss' : 'misses'} found and replayed`);
  refreshRecon();
});

// ---------- slack ----------
function slackBody(text) {
  return text
    .split('\n\n')
    .map((p) => {
      let h = esc(p).replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
      return `<p>${h.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}
async function refreshSlack() {
  const msgs = (await get('/api/slack')).reverse();
  const feed = $('#slack-feed');
  if (msgs.length === 0) {
    feed.innerHTML = '<p class="empty">No alerts yet.</p>';
    return;
  }
  const html = msgs
    .map((m) => {
      const fresh = !seenSlack.has(m.id) && seenSlack.size > 0;
      return `<div class="msg ${fresh ? 'new' : ''}"><div class="avatar">RG</div><div><div class="meta"><b>Reliability Guard</b><span class="app">APP</span><span>${time(m.at)}</span></div><div class="title">${esc(m.title)}</div><div class="body">${slackBody(m.text)}</div></div></div>`;
    })
    .join('');
  if (feed.dataset.n !== String(msgs.length)) {
    feed.innerHTML = html;
    feed.dataset.n = String(msgs.length);
    feed.scrollTop = feed.scrollHeight;
  }
  msgs.forEach((m) => seenSlack.add(m.id));
}

// ---------- email check ----------
async function refreshEmail() {
  const r = await get('/api/email-check');
  $('#email-domain').textContent = r.domain;
  $('#email-summary').textContent = r.summary;
  const label = { pass: 'Pass', warn: 'Check', fail: 'Missing' };
  const pill = { pass: 'ok', warn: 'warn', fail: 'retry' };
  $('#email-checks').innerHTML = r.checks
    .map(
      (c) => `<div class="check ${c.status}"><div class="head"><h3>${c.name}</h3><span class="pill ${pill[c.status]}">${c.name === 'Bounces' && c.status !== 'pass' ? 'Bounces' : label[c.status]}</span></div>
      <p class="verdict">${esc(c.verdict)}</p>${c.record ? `<code>${esc(c.record)}</code>` : ''}${c.fix ? `<div class="fix"><b>Fix:</b> ${esc(c.fix)}</div>` : ''}</div>`,
    )
    .join('');
}
$('#email-run').addEventListener('click', () => refreshEmail().then(() => toast('Checked again')));

// ---------- buyer list ----------
async function refreshBuyers() {
  const r = await get('/api/buyers');
  $('#sheet-sync').textContent = `Synced to ${r.adapter === 'CSV file' ? 'Google Sheets adapter (CSV file in demo mode)' : r.adapter}${r.lastSyncedAt ? `, last sync ${time(r.lastSyncedAt)}` : ''}`;
  const cols = ['Order', 'First name', 'Last', 'Email', 'Product', 'Amount', 'Purchased', 'Status', 'Access', 'Tags'];
  $('#sheet thead').innerHTML = `<tr class="cols"><th></th>${cols.map((_, i) => `<th>${String.fromCharCode(65 + i)}</th>`).join('')}</tr><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  $('#sheet tbody').innerHTML = r.rows
    .map((row, i) => {
      const fresh = !firstSheet && !seenOrders.has(row.order_id);
      seenOrders.add(row.order_id);
      return `<tr class="${fresh ? 'fresh' : ''}"><td class="rn">${i + 1}</td><td>${esc(row.order_id)}</td><td>${esc(row.first_name)}</td><td>${esc(row.last_initial)}.</td><td>${esc(row.email)}</td><td>${esc(row.product)}</td><td>${esc(row.amount)}</td><td>${time(Date.parse(row.purchased_at))}</td><td>${esc(row.status)}</td><td>${row.access === 'granted' ? 'granted' : 'pending'}</td><td>${esc(row.tags)}</td></tr>`;
    })
    .join('');
  firstSheet = false;
}

// ---------- tabs and polling ----------
const REFRESH = { overview: () => Promise.all([refreshEvents(), refreshLog()]), dead: refreshDead, recon: refreshRecon, slack: refreshSlack, email: () => Promise.resolve(), buyers: refreshBuyers };

function show(name) {
  tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'email') refreshEmail();
  REFRESH[name]();
  history.replaceState(null, '', `${location.search}#${name}`);
}
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (b) show(b.dataset.tab);
});

async function loop() {
  try {
    await Promise.all([refreshStats(), REFRESH[tab]()]);
    if (openEvent) await showEvent(openEvent);
  } catch (err) {
    console.warn(err);
  }
  setTimeout(loop, 700);
}

get('/health').then((h) => ($('#mode').textContent = h.demoMode ? 'Demo mode: sample data, mock tools' : 'Live'));
show(location.hash.slice(1) in REFRESH ? location.hash.slice(1) : 'overview');
loop();
