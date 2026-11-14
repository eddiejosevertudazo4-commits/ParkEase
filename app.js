/*
  ParkEase - Smart Parking Management System
  Group 1 | Main JavaScript file (app.js)

  Structure:
   1 Data model   2 Helpers   3 Notifications   4 Parking algorithm
   5 Page views   6 Entry/Search   7 Router + real time   8 Theme
   9 Modals/Slip  10 Payments chart  11 Welcome  12 User accounts
   13 Splash/Welcome flow  14 Beams background  15 Start-up
*/

/* ==================================================================
   1. DATA MODEL AND CONSTANTS
   Database tables (stored in the browser's localStorage under one key):
   - ParkingSlots    -> SL (10 fixed slots: M1-M4 motorcycle, C1-C6 car)
   - Vehicles        -> db.vehicles (one record per plate)
   - ParkingSessions -> db.sessions (one record per parking visit;
                        exit === null means the vehicle is still parked)
   Business rules: one active vehicle per slot, lowest-numbered compatible
   slot is assigned, plate must be unique among active vehicles.
   ================================================================== */

const SL = [1, 2, 3, 4].map(i => ({id: 'M' + i, type: 'M'})).concat([1, 2, 3, 4, 5, 6].map(i => ({id: 'C' + i, type: 'C'})));
const RATE = {M: [20, 10], C: [40, 20]},
  NAME = {M: 'Motorcycle', C: 'Car'},
  PLATE = /^[A-Z0-9][A-Z0-9 -]{1,8}[A-Z0-9]$/;
const ic = t => '<svg class="ic"><use href="#i' + t + '"/></svg>';
let db = {vehicles: {}, sessions: [], notes: [], seq: 1, unread: 0},
  selType = 'M';
const KEY = 'smartparking.v1';

// Read the saved records (the 'database') from localStorage.
function load() {
  try {
    const r = localStorage.getItem(KEY);
    if(r) db = JSON.parse(r)
  } catch(e) {}
}

// Write the records back to localStorage after every change.
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch(e) {}
}

/* ==================================================================
   2. HELPER UTILITIES
   Short DOM selector, peso formatter, HTML escaping, date/time, and
   query helpers (active sessions, occupied slot, free slot).
   ================================================================== */

const $ = s => document.querySelector(s),
  peso = n => '₱' + n.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fdt = ms => new Date(ms).toLocaleString('en-PH', {dateStyle: 'medium', timeStyle: 'short'});
const active = () => db.sessions.filter(s => s.exit == null),
  bySlot = id => active().find(s => s.slot === id),
  freeSlot = t => SL.find(s => s.type === t && !bySlot(s.id));

function dur(a, b) {
  let m = Math.max(0, Math.floor((b - a) / 60000));
  return Math.floor(m / 60) + 'h ' + m % 60 + 'm'
}

// Fee rule: first hour + extra hours, partial hours rounded up.
// Motorcycle: P20 then P10/hour. Car: P40 then P20/hour.
function fee(type, a, b) {
  const h = Math.max(1, Math.ceil((b - a) / 3600000));
  return RATE[type][0] + (h - 1) * RATE[type][1]
}
const lv = (k, s) => '<span data-k="' + k + '" data-s="' + s.id + '">' + (k === 'd' ? dur(s.entry, Date.now()) : peso(fee(s.type,
  s.entry, Date.now()))) + '</span>';

/* ==================================================================
   3. NOTIFICATIONS AND TOASTS
   ================================================================== */

function note(kind, msg) {
  db.notes.unshift({k: kind, m: msg, t: Date.now()});
  db.notes = db.notes.slice(0, 40);
  db.unread++;
  save();
  toast(msg, kind);
  updN()
}

function toast(m, k) {
  const e = $('#t');
  e.innerHTML = '<div class="toast glass ' + k + '">' + esc(m) + '</div>';
  clearTimeout(toast.h);
  toast.h = setTimeout(() => e.innerHTML = '', 3500)
}

function updN() {
  const c = $('#nc');
  c.hidden = !db.unread;
  c.textContent = db.unread;
  $('#np').innerHTML = '<h3>Notifications</h3>' + (db.notes.map((n, i) => '<div class="n ' + n.k + '"><div>' + esc(n.m) +
    '<small>' + fdt(n.t) + '</small></div><button class="x" onclick="delN(' + i + ')" aria-label="Delete notification">×</button></div>').join('') ||
    '<p class="mu">No notifications yet.</p>')
}

function togN() {
  const p = $('#np'),
    o = p.style.display === 'block';
  p.style.display = o ? 'none' : 'block';
  if(!o) {
    db.unread = 0;
    save();
    updN()
  }
}

/* ==================================================================
   4. CORE BUSINESS LOGIC - THE PARKING ALGORITHM
   register() = assign a slot, exitV() = release a slot.
   Every request is validated BEFORE saving, so an invalid request
   never changes or corrupts the records.
   ================================================================== */

/* Core logic: every request is validated first, so a rejected request never changes records */
/**
 * Register a vehicle entry (the algorithm taught in the defense):
 *  1. Clean and validate the plate, vehicle type and entry time.
 *  2. Reject if the plate is already parked (unique active plate).
 *  3. Keep only compatible slots (motorcycle -> M1-M4, car -> C1-C6).
 *  4. Choose the lowest-numbered slot that has no active session.
 *  5. If no slot is free, reject - nothing is saved.
 *  6. Otherwise save the vehicle and a new session, then return the slot.
 */
function register(plateRaw, type, entryMs) {
  const plate = String(plateRaw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if(!PLATE.test(plate)) return {ok: 0, m: 'Invalid plate number. Use 3–10 letters or digits.'};
  if(type !== 'M' && type !== 'C') return {ok: 0, m: 'Invalid vehicle type.'};
  if(!Number.isFinite(entryMs) || entryMs > Date.now() + 60000) return {ok: 0, m: 'Invalid entry time (cannot be in the future).'};
  if(active().some(s => s.plate === plate)) return {
    ok: 0,
    m: 'Plate ' + plate + ' is already parked. Plates must be unique among active vehicles.'
  };
  const slot = freeSlot(type);
  if(!slot) return {
    ok: 0,
    m: 'No free ' + NAME[type].toLowerCase() + ' slot. ' + NAME[type] + ' rejected' + (type === 'M' ? ' (car slots cannot be used by motorcycles).' : '.')
  };
  db.vehicles[plate] = {plate, type};
  db.sessions.push({id: db.seq++, plate, type, slot: slot.id, entry: entryMs, exit: null, fee: null});
  save();
  return {ok: 1, m: plate + ' (' + NAME[type] + ') assigned to slot ' + slot.id + '.'};
}

/**
 * Process an exit: find the ACTIVE session, stamp the exit time, compute
 * the fee, and save. The slot becomes free again because it no longer
 * has an active session, so the next vehicle can reuse it.
 */
function exitV(id) {
  const s = db.sessions.find(x => x.id === id && x.exit == null);
  if(!s) return {ok: 0, m: 'No active session found.'};
  s.exit = Date.now();
  s.fee = fee(s.type, s.entry, s.exit);
  save();
  return {
    ok: 1,
    m: s.plate + ' exited slot ' + s.slot + '. Fee: ' + peso(s.fee) + '. Slot is now free.'
  }
}

function confirmExit(id) {
  closeM();
  const r = exitV(id);
  note(r.ok ? 'o' : 'e', r.m);
  route()
}

/* ==================================================================
   5. PAGE VIEWS
   Each function in V returns the HTML of one page (Dashboard, Registry
   Entry, Search, History, Payments, About Us).
   ================================================================== */

const zone = (t, title, max) => {
  const f = SL.filter(s => s.type === t && !bySlot(s.id)).length;
  return '<div class="glass card" style="margin-top:14px"><div class="zh"><h3>' + title + '</h3><span>' + f + ' of ' +
    max + ' Available</span></div><div class="slots">' + SL.filter(s => s.type === t).map(s => {
    const o = bySlot(s.id);
    return '<div class="slot ' + (o ? 'occ' : '') + '"><b>' + s.id + '</b>' + (o ? ic(t) + '<div>' + esc(o.plate) +
      '</div><div class="mu">' + lv('d', o) + '</div><button class="s d" onclick="doExit(' + o.id + ')">Exit</button>' : '<div class="mu">Vacant</div><div class="free"><i></i>Available</div>') +
      '</div>'
  }).join('') + '</div></div>'
};
const V = {
  dashboard() {
    const a = active(),
      td = new Date().setHours(0, 0, 0, 0);
    const road = '<div class="glass road"><span class="v" style="top:6px;animation-duration:24s">' + ic('C') + '</span><span class="v" style="top:6px;animation-duration:17s;animation-delay:-8s">' +
      ic('M') + '</span><span class="v" style="top:6px;animation-duration:21s;animation-delay:-15s">' + ic('M') +
      '</span><span class="v dr" style="top:40px;animation-duration:26s;animation-delay:-4s">' + ic('C') + '</span><span class="v dr" style="top:40px;animation-duration:19s;animation-delay:-13s">' +
      ic('M') + '</span><span class="v dr" style="top:40px;animation-duration:23s;animation-delay:-4s">' + ic('M') +
      '</span></div>';
    return '<h2>Dashboard</h2>' + road + '<div class="grid g4"><div class="glass card stat"><small>Occupied Slots</small><div>' +
      a.length + ' / 10</div></div><div class="glass card stat"><small>Motorcycle Slots (Vacant/Total)</small><div>' +
      SL.filter(s => s.type === 'M' && !bySlot(s.id)).length + '/4</div></div><div class="glass card stat"><small>Car Slots (Vacant/Total)</small><div>' +
      SL.filter(s => s.type === 'C' && !bySlot(s.id)).length + '/6</div></div><div class="glass card stat"><small>Vehicles Served Today</small><div>' +
      db.sessions.filter(s => s.exit && s.exit >= td).length + '</div></div></div>' + '<div class="glass card" style="margin-top:14px"><h3>Search Vehicle</h3><input id="q" placeholder="Search active vehicles by plate number…" oninput="sq()" autocomplete="off"><div id="qr" class="tw" style="margin-top:14px"></div></div>' +
      zone('M', 'Motorcycle Parking (M1–M4)', 4) + zone('C', 'Car Parking (C1–C6)', 6)
  },
  entry() {
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return '<h2>Registry Entry</h2><div class="grid g2"><div class="glass card"><h3>Register Vehicle Entry</h3><label>1. Vehicle Type</label><div class="tcs"><button class="tc on" data-t="M" onclick="pick(\'M\')">' +
      ic('M') + 'Motorcycle<small>Slots M1–M4</small></button><button class="tc" data-t="C" onclick="pick(\'C\')">' +
      ic('C') + 'Car<small>Slots C1–C6</small></button></div><label>2. Plate Number</label><input id="pl" placeholder="e.g. ABC 1234" maxlength="10" oninput="pv()" autocomplete="off"><div class="hint" id="hint"></div><label>3. Entry Time</label><div class="row"><input id="et" type="datetime-local" value="' +
      d + '"><button class="s" onclick="nowT()">Now</button></div><div style="text-align:center;margin-top:20px"><button class="b" onclick="sub()">Register and Assign Slot</button></div></div>' +
      '<div class="glass card"><h3>Live Preview</h3><div class="plate"><small>PHILIPPINES</small><b id="pp">YOUR PLATE</b></div><div class="ns" id="ns"></div><div class="lane" id="lane"></div><h3>Demo Case</h3><p class="mu" style="margin-top:0">Fills M1–M4, then tries a fifth motorcycle to show the rejection.</p><button class="b" onclick="demo()">Run Demo</button></div></div>'
  },
  search() {
    return '<h2>Search Vehicle</h2><div class="glass card"><label style="margin-top:0">Plate Number</label><input id="q" placeholder="Search active vehicles…" oninput="sq()" autocomplete="off"><div id="qr" class="tw" style="margin-top:14px"></div></div>'
  },
  history() {
    const h = [...db.sessions].reverse();
    return '<h2>Parking History</h2><div class="glass card tw"><table><tr><th>#</th><th>Plate</th><th>Type</th><th>Slot</th><th>Entry</th><th>Exit</th><th>Duration</th><th>Status</th><th>Action</th></tr>' +
      (h.map(s => '<tr><td>' + s.id + '</td><td>' + esc(s.plate) + '</td><td>' + ic(s.type) + NAME[s.type] + '</td><td>' +
      s.slot + '</td><td>' + fdt(s.entry) + '</td><td>' + (s.exit ? fdt(s.exit) : '—') + '</td><td>' + (s.exit ? dur(s.entry,
      s.exit) : lv('d', s)) + '</td><td><span class="tag ' + (s.exit ? '' : 'a') + '">' + (s.exit ? 'Completed' : 'Active') +
      '</span></td><td>' + (s.exit ? '<button class="s d" onclick="delH(' + s.id + ')">Delete</button>' : '<span class="mu">—</span>') +
      '</td></tr>').join('') || '<tr><td colspan="9" class="mu">No sessions yet.</td></tr>') + '</table></div>'
  },
  payments() {
    const dn = db.sessions.filter(s => s.exit),
      td = new Date().setHours(0, 0, 0, 0),
      sum = l => l.reduce((t, s) => t + s.fee, 0);
    return '<h2>Payments</h2><div class="grid g4"><div class="glass card stat"><small>Collected Today</small><div>' +
      peso(sum(dn.filter(s => s.exit >= td))) + '</div></div><div class="glass card stat"><small>Total Collected</small><div>' +
      peso(sum(dn)) + '</div></div><div class="glass card stat"><small>Accruing Now (Live)</small><div><span data-k="acc">' +
      peso(0) + '</span></div></div><div class="glass card stat"><small>Payments Made</small><div>' + dn.length +
      '</div></div></div>' + earn(dn) + '<div class="glass card" style="margin-top:14px"><h3>Rates (Philippine Peso)</h3><p style="margin:4px 0">Motorcycle: <b>₱20.00</b> first hour, <b>₱10.00</b> each additional hour</p><p style="margin:4px 0">Car: <b>₱40.00</b> first hour, <b>₱20.00</b> each additional hour</p><p class="mu" style="margin-bottom:0">Partial hours are rounded up. The fee is charged at exit.</p></div>' +
      '<div class="glass card tw" style="margin-top:14px"><h3>Payment Ledger</h3><table><tr><th>Plate</th><th>Type</th><th>Slot</th><th>Duration</th><th>Paid At</th><th>Amount</th></tr>' +
      (dn.reverse().map(s => '<tr><td>' + esc(s.plate) + '</td><td>' + ic(s.type) + NAME[s.type] + '</td><td>' +
      s.slot + '</td><td>' + dur(s.entry, s.exit) + '</td><td>' + fdt(s.exit) + '</td><td><b>' + peso(s.fee) + '</b></td></tr>').join('') ||
      '<tr><td colspan="6" class="mu">No payments yet.</td></tr>') + '</table></div>'
  },
  about() {
    const dv = ['Eddie Jose F. Vertudazo Jr.', 'Rickamy G. Lara', 'John Michael O. Poliran'].map(n => '<div class="dev"><i>' +
      n[0] + '</i>' + n + '</div>').join('');
    return '<h2>About Us</h2><div class="about"><div class="glass card hero"><h3>Welcome to ParkEase!</h3><p>ParkEase is a web-based Smart Parking Management System designed to make school parking operations easier, smarter, and more organized. Our application aims to simplify the process of managing parking spaces by automatically assigning available slots to vehicles based on their type.</p><p style="margin-bottom:0">With ParkEase, users can conveniently register vehicles, monitor parking availability, search for currently parked vehicles, process vehicle exits, and view parking history. The system also helps prevent double booking and duplicate active plate numbers, ensuring accurate and reliable parking management.</p></div>' +
      '<div class="grid g2" style="margin-top:14px"><div class="glass card"><h3>Our Mission</h3><p style="margin:0">To provide a convenient, efficient, and reliable parking management solution that simplifies vehicle registration, parking slot allocation, and parking monitoring through technology.</p></div><div class="glass card"><h3>Our Vision</h3><p style="margin:0">To create a smarter and more organized parking environment by utilizing technology to improve efficiency, accuracy, and convenience in managing parking spaces.</p></div></div>' +
      '<div class="glass card" style="margin-top:14px"><h3>What ParkEase Offers</h3><ul><li><b>Vehicle Registration</b> – Records vehicle details, including plate number, vehicle type, and entry time.</li><li><b>Automatic Slot Assignment</b> – Automatically assigns the lowest-numbered available parking slot compatible with the vehicle type.</li><li><b>Parking Slot Monitoring</b> – Displays occupied and available parking spaces.</li><li><b>Vehicle Search</b> – Allows users to search for active parked vehicles using their plate numbers.</li><li><b>Vehicle Exit Processing</b> – Records vehicle departures and releases the previously occupied parking slot.</li><li><b>Parking History</b> – Maintains records of previous parking sessions for monitoring and reference.</li></ul></div>' +
      '<div class="grid g2" style="margin-top:14px"><div class="glass card"><h3>Our Parking System</h3><p style="margin-top:0">ParkEase manages a total of 10 designated parking spaces:</p><ul><li>Motorcycle Parking: Four dedicated slots (M1–M4).</li><li>Car Parking: Six dedicated slots (C1–C6).</li></ul><p style="margin-bottom:0">Each parking slot can accommodate only one active vehicle at a time. The system also ensures that every active parked vehicle has a unique plate number and that vehicles are assigned only to their corresponding parking spaces.</p></div>' +
      '<div class="glass card"><h3>Meet the Developers</h3><p style="margin-top:0">ParkEase was developed by a team of Computer Engineering students who share a common goal of applying technology and programming knowledge to create practical solutions to everyday challenges.</p><b style="font-size:.85rem">Development Team</b>' +
      dv + '</div></div>' + '<div class="glass card" style="margin-top:14px"><h3>Our Commitment</h3><p style="margin:0">At ParkEase, we believe that technology can make everyday activities more convenient and manageable. Through automation, proper database management, and a user-friendly interface, we aim to provide a reliable solution for a more systematic parking experience.</p><p style="margin:14px 0 0;font-weight:600;color:var(--ac)">ParkEase — Making Every Parking Experience Easier!</p></div>' +
      '<div class="glass card" style="margin-top:14px"><h3>How Slot Assignment Works</h3><ol><li>Validate the plate, vehicle type and entry time.</li><li>Reject the request if the plate is already active.</li><li>Keep only compatible slots: motorcycles use M1–M4, cars use C1–C6.</li><li>Choose the lowest-numbered slot with no active session; reject if none is free.</li><li>Save the session. On exit, record the time, compute the fee in ₱ and free the slot.</li></ol><p style="margin:14px 0 0"><button class="s d" onclick="resetAsk()">Reset All Data</button></p></div></div>'
  }
};

/* ==================================================================
   6. REGISTRY ENTRY AND SEARCH ACTIONS
   ================================================================== */

function pick(t) {
  selType = t;
  document.querySelectorAll('.tc').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  pv()
}

function nowT() {
  $('#et').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function pv() {
  const p = $('#pl').value.trim().toUpperCase().replace(/\s+/g, ' '),
    h = $('#hint');
  $('#pp').textContent = p || 'YOUR PLATE';
  h.style.color = !p ? '' : !PLATE.test(p) ? '#b45309' : active().some(s => s.plate === p) ? 'var(--bad)' : 'var(--ok)';
  h.textContent = !p ? '' : !PLATE.test(p) ? 'Keep typing: 3–10 letters or digits.' : active().some(s => s.plate === p) ? 'This plate is already parked.' : 'Plate looks good.';
  const f = freeSlot(selType);
  $('#ns').innerHTML = f ? 'Next Slot: <b style="font-size:1.3rem;color:var(--ac)">' + f.id + '</b>' : 'No free ' +
    NAME[selType].toLowerCase() + ' slot. Entry will be rejected.'
}

function drive(t) {
  const l = $('#lane');
  if(!l) return;
  const s = document.createElement('span');
  s.className = 'v dr';
  s.innerHTML = ic(t);
  l.appendChild(s);
  setTimeout(() => s.remove(), 2500)
}

function sub() {
  const r = register($('#pl').value, selType, new Date($('#et').value).getTime());
  note(r.ok ? 'o' : 'e', r.m);
  if(r.ok) {
    drive(selType);
    $('#pl').value = ''
  }
  pv()
}

function demo() {
  let bad = null;
  ['MC 0001', 'MC 0002', 'MC 0003', 'MC 0004', 'MC 0005'].forEach(p => {
    if(active().some(s => s.plate === p)) return;
    const r = register(p, 'M', Date.now());
    if(!r.ok) bad = r
  });
  drive('M');
  note(bad ? 'e' : 'i', bad ? bad.m : 'Demo plates already parked.');
  pv()
}

function sq() {
  const q = $('#q').value.trim().toUpperCase(),
    r = q ? active().filter(s => s.plate.includes(q)) : [];
  $('#qr').innerHTML = q ? (r.length ? '<table><tr><th>Plate</th><th>Type</th><th>Slot</th><th>Entry</th><th>Duration</th><th>Fee So Far</th><th></th></tr>' +
    r.map(s => '<tr><td>' + esc(s.plate) + '</td><td>' + ic(s.type) + NAME[s.type] + '</td><td>' + s.slot + '</td><td>' +
    fdt(s.entry) + '</td><td>' + lv('d', s) + '</td><td>' + lv('f', s) + '</td><td><button class="s d" onclick="doExit(' +
    s.id + ')">Process Exit</button></td></tr>').join('') + '</table>' : '<p class="mu">No active vehicle matches “' +
    esc(q) + '”.</p>') : '<p class="mu">Type a plate number to find a parked vehicle.</p>'
}

/* ==================================================================
   7. ROUTER AND REAL-TIME UPDATES
   route() shows the page for the URL hash. tick() runs every second to
   update the clock, durations and live fees without redrawing the page.
   ================================================================== */

function route() {
  const p = location.hash.slice(1) || 'dashboard',
    pg = V[p] ? p : 'dashboard';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.p === pg));
  $('#v').innerHTML = V[pg]();
  if($('#q')) sq();
  if(pg === 'entry') pv();
  decorate(pg);
  tick();
  scrollTo(0, 0)
}
const GL = {
  dashboard: [['P', '#7cc4ff', '#1d5fc4'], ['Mg', '#5eead4', '#0f766e'], ['Cg', '#a5b4fc', '#4338ca'], ['K', '#86efac',
    '#15803d']],
    payments: [['W', '#fcd34d', '#b45309'], ['G', '#7cc4ff', '#1d5fc4'], ['L', '#c4b5fd', '#6d28d9'], ['K', '#86efac',
    '#15803d']]
};

function decorate(pg) {
  (GL[pg] || []).forEach((g, i) => {
    const s = document.querySelectorAll('.stat')[i];
    if(s) s.insertAdjacentHTML('afterbegin', '<span class="i3" style="--a:' + g[1] + ';--b:' + g[2] + '"><svg' +
      (g[0].length > 1 ? ' class="v"' : '') + '><use href="#i' + g[0] + '"/></svg></span>')
  })
}

function tick() {
  $('#clk').textContent = new Date().toLocaleString('en-PH', {dateStyle: 'medium', timeStyle: 'medium'});
  const now = Date.now();
  document.querySelectorAll('[data-k]').forEach(e => {
    if(e.dataset.k === 'acc') {
      e.textContent = peso(active().reduce((t, s) => t + fee(s.type, s.entry, now), 0));
      return
    }
    const s = db.sessions.find(x => x.id == e.dataset.s);
    if(s && !s.exit) e.textContent = e.dataset.k === 'd' ? dur(s.entry, now) : peso(fee(s.type, s.entry, now))
  })
}

function place(e) {
  e.style.left = Math.floor(Math.random() * Math.floor(innerWidth / 40)) * 40 + 'px';
  e.style.top = Math.floor(Math.random() * Math.floor(innerHeight / 40)) * 40 + 'px'
}
for(let i = 0; i < 8; i++) {
  const e = document.createElement('i');
  e.className = 'lit';
  e.style.animationDelay = (-i * 0.9) + 's';
  place(e);
  e.addEventListener('animationiteration', () => place(e));
  $('#bg').appendChild(e)
}
addEventListener('pointermove', e => {
  const b = $('#bg');
  b.style.setProperty('--px', e.clientX + 'px');
  b.style.setProperty('--py', e.clientY + 'px')
});
document.addEventListener('click', e => {
  const b = e.target.closest('button,nav a');
  if(!b) return;
  const r = b.getBoundingClientRect(),
    s = document.createElement('span'),
    d = Math.max(r.width, r.height) * 2;
  s.className = 'rpl';
  s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) +
    'px';
  b.appendChild(s);
  setTimeout(() => s.remove(), 600)
});
document.addEventListener('mousemove', e => {
  const s = e.target.closest('.slot');
  if(s) {
    const r = s.getBoundingClientRect();
    s.style.setProperty('--mx', e.clientX - r.left + 'px');
    s.style.setProperty('--my', e.clientY - r.top + 'px')
  }
});

/* ==================================================================
   8. THEME (LIGHT / DARK MODE)
   ================================================================== */

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';

function setT(t) {
  document.documentElement.dataset.theme = t;
  $('#th').innerHTML = t === 'dark' ? SUN : MOON;
  try {
    localStorage.setItem('pe_t', t)
  } catch(e) {}
}

function theme() {
  setT(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
}

function initTheme() {
  let t;
  try {
    t = localStorage.getItem('pe_t')
  } catch(e) {}
  if(!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setT(t)
}

/* ==================================================================
   9. MODALS AND EXIT PAYMENT SLIP
   ================================================================== */

function delN(i) {
  db.notes.splice(i, 1);
  save();
  updN()
}

function closeM() {
  $('#md').innerHTML = ''
}

function doExit(id) {
  const s = db.sessions.find(x => x.id === id && x.exit == null);
  if(!s) return;
  const now = Date.now(),
    h = Math.max(1, Math.ceil((now - s.entry) / 36e5)),
    r = RATE[s.type],
    row = (a, b) => '<div class="sl"><span>' + a + '</span><b>' + b + '</b></div>';
  $('#md').innerHTML = '<div class="mo" onclick="if(event.target===this)closeM()"><div class="slip glass"><div class="sh"><svg class="logo"><use href="#logo"/></svg><div><b>Exit Payment Slip</b><small>ParkEase Smart Parking</small></div></div><div class="sd"></div>' +
    row('Plate Number', esc(s.plate)) + row('Vehicle', NAME[s.type]) + row('Parking Slot', s.slot) + row('Entry',
    fdt(s.entry)) + row('Exit', fdt(now)) + row('Duration', dur(s.entry, now)) + '<div class="sd"></div>' + row('First Hour',
    peso(r[0])) + row('Additional Hours (' + (h - 1) + ' × ' + peso(r[1]) + ')', peso((h - 1) * r[1])) + '<div class="sd"></div><div class="st"><span>Total Due</span><b>' +
    peso(fee(s.type, s.entry, now)) + '</b></div><div class="sb"><button class="b gh" onclick="closeM()">Cancel</button><button class="b" onclick="confirmExit(' +
    id + ')">Confirm Exit</button></div></div></div>'
}

/* ==================================================================
   10. PAYMENTS: EARNINGS CHART AND PERCENTAGES
   ================================================================== */

function earn(dn) {
  const D = 864e5,
    t0 = new Date().setHours(0, 0, 0, 0),
    days = [...Array(7)].map((_, i) => t0 - (6 - i) * D),
    vals = days.map(d => dn.filter(s => s.exit >= d && s.exit < d + D).reduce((t, s) => t + s.fee, 0)),
    mx = Math.max(...vals, 1),
    tot = dn.reduce((t, s) => t + s.fee, 0),
    m = dn.filter(s => s.type === 'M').reduce((t, s) => t + s.fee, 0),
    c = tot - m,
    pc = v => tot ? Math.round(v / tot * 100) : 0,
    y = vals[5],
    td = vals[6],
    ch = y ? Math.round((td - y) / y * 100) : (td ? 100 : 0);
  const bars = vals.map((v, i) => {
    const h = v / mx * 105,
      x = 14 + i * 58;
    return '<rect class="bar" x="' + x + '" y="' + (125 - h) + '" width="38" height="' + h + '" rx="5"/><text class="gt" x="' +
      (x + 19) + '" y="' + (119 - h) + '" text-anchor="middle">' + (v ? '₱' + v : '') + '</text><text class="gt" x="' +
      (x + 19) + '" y="143" text-anchor="middle">' + new Date(days[i]).toLocaleDateString('en-PH', {weekday: 'short'}) +
      '</text>'
  }).join('');
  return '<div class="grid g2" style="margin-top:14px"><div class="glass card"><div class="zh"><h3>Earnings, Last 7 Days</h3><span>' +
    (ch >= 0 ? '+' : '') + ch + '% vs Yesterday</span></div><svg viewBox="0 0 420 150" width="100%" role="img" aria-label="Daily earnings bar chart"><line x1="8" y1="125" x2="412" y2="125" stroke="currentColor" stroke-opacity=".25"/>' +
    bars + '</svg></div><div class="glass card"><h3>Share of Earnings by Vehicle</h3><div class="sl"><span>Motorcycle</span><b>' +
    pc(m) + '% · ' + peso(m) + '</b></div><div class="pb"><i style="width:' + pc(m) + '%"></i></div><div class="sl"><span>Car</span><b>' +
    pc(c) + '% · ' + peso(c) + '</b></div><div class="pb"><i style="width:' + pc(c) + '%"></i></div><p class="mu" style="margin:0;font-size:.82rem">Based on ' +
    peso(tot) + ' total collected.</p></div></div>'
}

/* ==================================================================
   11. WELCOME SCREEN
   ================================================================== */

function wTick() {
  const n = new Date(),
    h = n.getHours();
  $('#wg').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', welcome back.';
  $('#wd').textContent = n.toLocaleString('en-PH', {dateStyle: 'full', timeStyle: 'medium'});
  const f = t => SL.filter(s => s.type === t && !bySlot(s.id)).length;
  $('#wa').innerHTML = '<span>Motorcycle Slots Available: ' + f('M') + ' / 4</span><span>Car Slots Available: ' +
    f('C') + ' / 6</span>'
}

function enter() {
  const w = $('#wl');
  if(w.classList.contains('out')) return;
  w.classList.add('out');
  document.body.classList.remove('w');
  clearInterval(w._t);
  clearInterval(buildW.t);
  try {
    sessionStorage.setItem('pe_w', '1')
  } catch(e) {}
  setTimeout(() => {
    w.hidden = true
  }, 650);
  location.hash = '#dashboard'
}
const WR = ['Automatic slot assignment', 'No double booking', 'Real-time monitoring', 'Clear payment records'];
let wi = 0;

function buildW() {
  $('#wh').innerHTML = [...'ParkEase'].map((c, i) => '<span class="lt' + (i > 3 ? ' e' : '') + '" style="--j:' +
    i + '">' + c + '</span>').join('');
  $('#wrd').innerHTML = ['C', 'M', 'M', 'C', 'M'].map((t, i) => '<span class="v' + (i % 2 ? ' dr' : '') + '" style="top:0;animation-duration:' +
    (14 + i * 3) + 's;animation-delay:-' + (i * 5) + 's">' + ic(t) + '</span>').join('');
  clearInterval(buildW.t);
  const e = $('#wr'),
    f = () => {
    e.textContent = WR[wi++ % WR.length];
    e.style.animation = 'none';
    void e.offsetWidth;
    e.style.animation = ''
  };
  f();
  buildW.t = setInterval(f, 2600)
}

/* ==================================================================
   12. USER ACCOUNTS (sign up, log in, forgot password, log out, reset)
   Passwords are hashed with SHA-256 before being stored.
   ================================================================== */

const UK = 'parkease.users',
  ssg = k => {
  try {
    return sessionStorage.getItem(k)
  } catch(e) {
    return null
  }
};

function getU() {
  try {
    return JSON.parse(localStorage.getItem(UK) || '{}')
  } catch(e) {
    return {}
  }
}

function setU(o) {
  try {
    localStorage.setItem(UK, JSON.stringify(o))
  } catch(e) {}
}

async function hs(p, u) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('parkease:' + u + ':' + p));
    return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('')
  } catch(e) {
    return btoa(unescape(encodeURIComponent('parkease:' + u + ':' + p)))
  }
}
let AM = 'in';

// Password field with a show / hide (eye) button.
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>';

function pw(id, placeholder, autocomplete, keyAttr) {
  return `<div class="pw"><input id="${id}" type="password" placeholder="${placeholder}" autocomplete="${autocomplete}" maxlength="40" ${keyAttr}><button type="button" class="eye" onmousedown="event.preventDefault()" onclick="togglePw('${id}',this)" aria-label="Show password" title="Show password">${EYE}</button></div>`;
}

// Switch a password box between hidden (dots) and visible (text).
function togglePw(id, btn) {
  const input = $('#' + id), show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = show ? EYE_OFF : EYE;
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.title = show ? 'Hide password' : 'Show password';
}

function authView(m) {
  AM = m;
  const k = `onkeydown="if(event.key==='Enter')authGo()"`,
    t = (x, l) => `<button class="at${AM===x?' on':''}" onclick="authView('${x}')">${l}</button>`;
  $('#au').innerHTML = (m === 'fp' ? `<button class="bk" onclick="authView('in')">← Back</button><h3 style="margin:0 0 4px;text-align:center">Reset Password</h3><p class="mu" style="font-size:.8rem;margin:0 0 10px;text-align:center">Enter your username and a new password.</p>` : `<button class="bk" onclick="authClose()">← Back</button><h3 style="margin:0 0 10px;text-align:center">${m==='in'?'Log In':'Create Account'}</h3>`) +
    `<input id="au1" placeholder="Username" autocomplete="username" maxlength="20" ${k}>${pw('au2',m==='fp'?'New Password':'Password',m==='in'?'current-password':'new-password',k)}` +
    (m !== 'in' ? `${pw('au3','Confirm Password','new-password',k)}` : '') +
    `<div class="hint" id="auh"></div><button class="b" style="width:100%" onclick="authGo()">${m==='in'?'Log In':m==='up'?'Create Account':'Reset Password'}</button>` +
    (m === 'in' ? `<a class="fpl" onclick="authView('fp')">Forgot password?</a><a class="fpl" onclick="authView('up')">No account yet? Sign Up</a>` : m === 'up' ? `<a class="fpl" onclick="authView('in')">Already have an account? Log In</a>` : '')
}

async function authGo() {
  const u = $('#au1').value.trim(),
    p = $('#au2').value,
    k = u.toLowerCase(),
    us = getU(),
    h = $('#auh'),
    err = m => {
    h.style.color = 'var(--bad)';
    h.textContent = m
  };
  if(!/^[A-Za-z0-9_.]{3,20}$/.test(u)) return err('Username must be 3–20 letters, numbers, "." or "_".');
  if(AM === 'in') {
    if(!us[k] || us[k].h !== await hs(p, k)) return err('Incorrect username or password.');
    return loginAs(k)
  }
  if(p.length < 6) return err('Password must be at least 6 characters.');
  if(p !== $('#au3').value) return err('Passwords do not match.');
  if(AM === 'up') {
    if(us[k]) return err('That username is already taken.');
    us[k] = {u, h: await hs(p, k), at: Date.now()};
    setU(us);
    return loginAs(k)
  }
  if(!us[k]) return err('No account found with that username.');
  us[k].h = await hs(p, k);
  setU(us);
  authView('in');
  $('#auh').style.color = 'var(--ok)';
  $('#auh').textContent = 'Password updated. Please log in.'
}

function loginAs(k) {
  const us = getU();
  us[k].last = Date.now();
  setU(us);
  try {
    sessionStorage.setItem('pe_u', k)
  } catch(e) {}
  enter();
  note('o', 'Signed in as ' + us[k].u + '.')
}

function acct() {
  const a = getU()[ssg('pe_u')];
  if(!a) return;
  const r = (x, y) => `<div class="sl"><span>${x}</span><b>${y}</b></div>`;
  $('#np').style.display = 'none';
  $('#md').innerHTML = `<div class="mo" onclick="if(event.target===this)closeM()"><div class="slip glass" style="text-align:center"><div class="av">${esc(a.u[0].toUpperCase())}</div><h3 style="margin-bottom:12px">${esc(a.u)}</h3><div class="sd"></div>${r('Username',esc(a.u))}${r('Password','••••••••')}${r('Account Created',fdt(a.at))}${r('Last Log In',fdt(a.last||a.at))}<div class="sd"></div><div class="sb"><button class="b gh" onclick="closeM()">Close</button><button class="b" style="background:var(--bad)" onclick="logout()">Log Out</button></div></div></div>`
}

function doLogout(m) {
  closeM();
  try {
    sessionStorage.removeItem('pe_w');
    sessionStorage.removeItem('pe_u')
  } catch(e) {}
  showW();
  note('i', m || 'You have been logged out.')
}

function resetAsk() {
  $('#md').innerHTML = `<div class="mo" onclick="if(event.target===this)closeM()"><div class="slip glass" style="text-align:center"><h3>Delete All Data?</h3><p class="mu" style="margin:0">Are you sure you want to delete all data? Every parking record, payment and notification will be permanently removed, and you will be logged out automatically. This cannot be undone.</p><div class="sb"><button class="b gh" onclick="closeM()">Cancel</button><button class="b" style="background:var(--bad)" onclick="resetGo()">Yes, Delete All</button></div></div></div>`
}

function resetGo() {
  db = {vehicles: {}, sessions: [], notes: [], seq: 1, unread: 0};
  save();
  updN();
  route();
  doLogout('All data has been deleted. You have been logged out.')
}

function authOpen(m) {
  $('#aum').hidden = false;
  authView(m);
  setTimeout(() => {
    const i = $('#au1');
    if(i) i.focus()
  }, 50)
}

function authClose() {
  const a = $('#aum');
  if(a) a.hidden = true
}

/* ==================================================================
   13. SPLASH SCREEN AND WELCOME FLOW
   ================================================================== */

function showW() {
  document.body.classList.add('w');
  splash(showW2)
}

function splash(cb) {
  let s = $('#sp');
  if(!s) {
    s = document.createElement('div');
    s.id = 'sp';
    document.body.appendChild(s)
  }
  s.hidden = false;
  s.classList.remove('out');
  s.innerHTML = '<div class="sw"><span class="sl0"><svg class="logo"><use href="#logo"/></svg></span><h1>' + [...'ParkEase'].map((c,
    i) => '<span class="lt' + (i > 3 ? ' e' : '') + '" style="--j:' + (i + 3) + '">' + c + '</span>').join('') +
    '</h1><div class="tg">SMART PARKING MANAGEMENT SYSTEM</div></div><div class="sroad"><span class="v dr" style="top:0;animation:dr 3.2s linear .3s 1 both">' +
    ic('C') + '</span><span class="v" style="top:24px;animation:dl 3.2s linear .9s 1 both">' + ic('M') + '</span></div>';
  setTimeout(() => {
    s.classList.add('out');
    cb();
    setTimeout(() => {
      s.hidden = true;
      s.innerHTML = ''
    }, 650)
  }, 2900)
}

function delH(id) {
  const s = db.sessions.find(x => x.id === id && x.exit);
  if(!s) return;
  $('#md').innerHTML = '<div class="mo" onclick="if(event.target===this)closeM()"><div class="slip glass" style="text-align:center"><h3>Delete History Record?</h3><p class="mu" style="margin:0">Remove the record of ' +
    esc(s.plate) + ' (' + fdt(s.entry) + ')? Its payment will also be removed from Payments. This cannot be undone.</p><div class="sb"><button class="b gh" onclick="closeM()">Cancel</button><button class="b" style="background:var(--bad)" onclick="confirmDelH(' +
    id + ')">Delete</button></div></div></div>'
}

function confirmDelH(id) {
  closeM();
  const n = db.sessions.length;
  db.sessions = db.sessions.filter(x => !(x.id === id && x.exit));
  save();
  if(db.sessions.length < n) note('i', 'History record removed.');
  route()
}

function showW2() {
  const w = $('#wl');
  w.classList.remove('out');
  w.hidden = false;
  authClose();
  document.body.classList.add('w');
  wTick();
  clearInterval(w._t);
  w._t = setInterval(wTick, 1000);
  buildW()
}

function logout() {
  $('#np').style.display = 'none';
  $('#md').innerHTML = '<div class="mo" onclick="if(event.target===this)closeM()"><div class="slip glass" style="text-align:center"><div class="sh" style="justify-content:center"><svg class="logo"><use href="#logo"/></svg></div><h3>Log Out of ParkEase?</h3><p class="mu" style="margin:0">Are you sure you want to leave? Your parking records stay saved.</p><div class="sb"><button class="b gh" onclick="closeM()">Stay</button><button class="b" style="background:var(--bad)" onclick="outNow()">Log Out</button></div></div></div>'
}

function outNow() {
  doLogout()
}

function initWelcome() {
  let seen;
  try {
    seen = sessionStorage.getItem('pe_w') && sessionStorage.getItem('pe_u')
  } catch(e) {}
  const w = $('#wl');
  if(!seen) showW();
  w.addEventListener('pointermove', e => {
    const p = $('#wp'),
      r = w.getBoundingClientRect();
    p.style.transform = 'perspective(900px) rotateX(' + ((e.clientY / r.height - .5) * -7) + 'deg) rotateY(' + ((e.clientX / r.width - .5) * 9) +
      'deg)'
  });
  w.addEventListener('pointerleave', () => {
    $('#wp').style.transform = ''
  });
  w.addEventListener('pointerdown', e => {
    if(e.target.closest('button,input,a,#au')) return;
    const v = document.createElement('span');
    v.className = 'v' + (Math.random() < .5 ? ' dr' : '');
    v.style.cssText = 'top:' + (e.clientY - 14) + 'px;animation-duration:3.5s;animation-iteration-count:1;z-index:2';
    v.innerHTML = ic(Math.random() < .5 ? 'C' : 'M');
    w.appendChild(v);
    setTimeout(() => v.remove(), 3600)
  });
  w.addEventListener('pointermove', e => {
    const p = $('#wp'),
      r = p.getBoundingClientRect();
    p.style.setProperty('--mx', e.clientX - r.left + 'px');
    p.style.setProperty('--my', e.clientY - r.top + 'px')
  });
  w.addEventListener('pointerdown', e => {
    if(e.target.closest('button')) return;
    const r = document.createElement('i');
    r.className = 'rp';
    r.style.cssText = 'left:' + e.clientX + 'px;top:' + e.clientY + 'px;animation-duration:4s;animation-iteration-count:1';
    $('#bg').prepend(r);
    setTimeout(() => r.remove(), 4200)
  });
  addEventListener('keydown', e => {
    void 0
  })
}

/* ==================================================================
   14. BACKGROUND: ANIMATED BEAMS (canvas)
   ================================================================== */

const BC = {
  d: [[103, 232, 249], [109, 92, 255], [217, 70, 239]],
  l: [[8, 145, 178], [79, 70, 229], [192, 38, 211]]
};

function bcol(P, u) {
  const x = u * 2,
    i = Math.min(1, Math.floor(x)),
    f = x - i,
    a = P[i],
    b = P[i + 1];
  return [a[0] + (b[0] - a[0]) * f | 0, a[1] + (b[1] - a[1]) * f | 0, a[2] + (b[2] - a[2]) * f | 0]
}

function initBeams() {
  const cv = document.createElement('canvas');
  cv.id = 'bm';
  $('#bg').prepend(cv);
  const cx = cv.getContext('2d');
  let W,
    H,
    S = [],
    mx = -999,
    my = -999;
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function build() {
    const d = Math.min(devicePixelRatio || 1, 1.5);
    W = innerWidth;
    H = innerHeight;
    cv.width = W * d;
    cv.height = H * d;
    cx.setTransform(d, 0, 0, d, 0, 0);
    S = [];
    [[30, 0, .9, 1], [20, 2.2, .65, .45]].forEach(([n, ph, w, al]) => {
      for(let i = 0; i < n; i++) {
        const t = i / (n - 1) - .5,
          P = [[-.1 * W, H * (.72 + t * .1)], [.3 * W, H * (.8 + t * .25) + Math.sin(i * 1.3 + ph) * H * .06], [.62 * W,
          H * (.35 + t * .6) + Math.cos(i * .9 + ph) * H * .05], [1.1 * W, H * (.18 + t * w)]],
          pts = [];
        for(let k = 0; k < 100; k++) {
          const u = k / 99,
            v = 1 - u,
            a = v * v * v,
            b = 3 * v * v * u,
            c = 3 * v * u * u,
            e = u * u * u;
          pts.push([a * P[0][0] + b * P[1][0] + c * P[2][0] + e * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] +
            e * P[3][1]])
        }
        S.push({pts, al, T: 5 + (i * 37 + ph * 10) % 8 | 0, off: (i * 1.9 + ph) % 11})
      }
    })
  }
  function frame(ms) {
    const t = ms / 1000,
      dk = document.documentElement.dataset.theme === 'dark',
      P = dk ? BC.d : BC.l;
    cx.clearRect(0, 0, W, H);
    cx.globalCompositeOperation = dk ? 'lighter' : 'source-over';
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    S.forEach(s => {
      const pts = s.pts;
      let near = 0;
      if(mx > 0) for(let k = 0; k < 100; k += 8) {
        const dx = pts[k][0] - mx,
          dy = pts[k][1] - my,
          dd = dx * dx + dy * dy;
        if(dd < 22500) near = Math.max(near, 1 - Math.sqrt(dd) / 150)
      }
      cx.strokeStyle = 'rgba(' + bcol(P, .5) + ',' + ((.16 + near * .5) * s.al * (dk ? 1 : 1.2)) + ')';
      cx.lineWidth = 1 + near;
      cx.beginPath();
      pts.forEach((p, k) => k ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1]));
      cx.stroke();
      const u = ((t + s.off * 3) % (s.T * 2)) / s.T,
        L = .4;
      if(u > 1 + L) return;
      for(let k = 0; k < 14; k++) {
        const a = u - L * (k + 1) / 14,
          b = u - L * k / 14;
        if(b < 0 || a > 1) continue;
        const ia = Math.max(0, Math.round(a * 99)),
          ib = Math.min(99, Math.round(b * 99));
        if(ib <= ia) continue;
        cx.strokeStyle = 'rgba(' + bcol(P, k / 14) + ',' + Math.pow(1 - k / 14, 1.6) * .85 * s.al + ')';
        cx.lineWidth = 1.6;
        cx.beginPath();
        cx.moveTo(pts[ia][0], pts[ia][1]);
        for(let j = ia + 1; j <= ib; j++) cx.lineTo(pts[j][0], pts[j][1]);
        cx.stroke()
      }
      if(u <= 1) {
        const h = pts[Math.round(u * 99)],
          c = bcol(P, 0);
        cx.fillStyle = 'rgba(' + c + ',' + .18 * s.al + ')';
        cx.beginPath();
        cx.arc(h[0], h[1], 8, 0, 7);
        cx.fill();
        cx.fillStyle = 'rgba(' + c + ',' + .95 * s.al + ')';
        cx.beginPath();
        cx.arc(h[0], h[1], 2.4, 0, 7);
        cx.fill()
      }
    });
    if(!rm) requestAnimationFrame(frame)
  }
  addEventListener('pointermove', e => {
    if(e.pointerType === 'mouse') {
      mx = e.clientX;
      my = e.clientY
    }
  });
  addEventListener('resize', () => {
    build();
    if(rm) frame(4000)
  });
  build();
  rm ? frame(4000) : requestAnimationFrame(frame)
}
initBeams();
addEventListener('keydown', e => {
  if(e.key === 'Escape') {
    closeM();
    authClose()
  }
});

/* ==================================================================
   15. APP START-UP
   Restore theme and saved data, show the first page, start the 1-second
   real-time timer, and open the welcome screen.
   ================================================================== */

initTheme();
load();
updN();
route();
setInterval(tick, 1000);
initWelcome();
addEventListener('hashchange', route);
addEventListener('storage', e => {
  if(e.key === KEY) {
    load();
    updN();
    route()
  }
});
