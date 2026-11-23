/* Blaze's Partners — shared partnership dashboard for Blaise and Dad.
   Runs in two modes:
   - demo: data saved on this device only (localStorage)
   - live: Supabase, shared between both partners, updates in real time
   Every record is one row in the `entries` table: { id, kind, data, created_at, updated_by }. */

// Neutral defaults. The partners' real numbers are entered on the More tab and
// saved with the data (never in this public code).
const DEFAULTS = {
  salaryPct: 0,         // Blaise's % of each job
  salaryCap: 0,         // monthly salary cap ($)
  wcTarget: 0,          // working capital to keep on hand before money goes to the fund
  goal: 1000000,        // total-asset goal
  goalYear: 2036,
  blaisePct: 50,        // Blaise's ownership %
  meetingHour: 21,      // Monday meeting hour (24h)
};
const BUCKETS = { wc: "Working capital", fund: "Investment fund", equipment: "Equipment", undecided: "Not decided yet" };
const PEOPLE = ["Blaise", "Dad"];

/* ---------- small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, cents = false) => (n < 0 ? "-" : "") + "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const round2 = (n) => Math.round(n * 100) / 100;
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: iso.slice(0, 4) === todayISO().slice(0, 4) ? undefined : "numeric" }) : "";
const monthKey = (iso) => (iso || "").slice(0, 7);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- backends ---------- */
const DemoBackend = {
  key: "bpw_demo_entries",
  async list() { return JSON.parse(localStorage.getItem(this.key) || "null") ?? seedDemo(); },
  async save(e) { const all = await this.list(); const i = all.findIndex((x) => x.id === e.id); i >= 0 ? (all[i] = e) : all.push(e); localStorage.setItem(this.key, JSON.stringify(all)); },
  async remove(id) { const all = (await this.list()).filter((x) => x.id !== id); localStorage.setItem(this.key, JSON.stringify(all)); },
  subscribe() {},
};

function seedDemo() {
  localStorage.setItem(DemoBackend.key, "[]");
  return [];
}

function makeLiveBackend(sb) {
  return {
    async list() {
      const { data, error } = await sb.from("entries").select("*").order("created_at");
      if (error) throw error; return data;
    },
    async save(e) { const { error } = await sb.from("entries").upsert(e); if (error) throw error; },
    async remove(id) { const { error } = await sb.from("entries").delete().eq("id", id); if (error) throw error; },
    subscribe(cb) {
      sb.channel("entries-feed").on("postgres_changes", { event: "*", schema: "public", table: "entries" }, cb).subscribe();
    },
  };
}

/* ---------- app state ---------- */
const S = { mode: "demo", backend: DemoBackend, sb: null, me: localStorage.getItem("bpw_me") || "Blaise", entries: [], tab: localStorage.getItem("bpw_tab") || "home", moneyFilter: "all", todoFilter: "open" };

function cfg() {
  const c = window.BPW_CONFIG || {};
  return { url: c.SUPABASE_URL || localStorage.getItem("bpw_url") || "", key: c.SUPABASE_ANON_KEY || localStorage.getItem("bpw_key") || "" };
}
const settings = () => ({ ...DEFAULTS, ...(S.entries.find((e) => e.kind === "settings")?.data || {}) });
const ofKind = (k) => S.entries.filter((e) => e.kind === k);

async function reload() { S.entries = await S.backend.list(); render(); }

async function save(kind, data, id) {
  const old = id && S.entries.find((e) => e.id === id);
  const e = { id: id || uid(), kind, data, created_at: old?.created_at || new Date().toISOString(), updated_by: S.me };
  await S.backend.save(e); await reload();
}
async function removeEntry(id) { await S.backend.remove(id); await reload(); }

/* ---------- money engine ---------- */
const sortByDate = (a, b) => (a.data.date || "").localeCompare(b.data.date || "") || a.created_at.localeCompare(b.created_at);

// Replays every money entry in date order and returns balances.
function ledger(upTo) {
  const b = { wc: 0, fund: 0, equipment: 0, undecided: 0 };
  const contributed = { Blaise: 0, Dad: 0 };
  const snapshots = []; // fund market values
  let fundGain = 0;
  const events = S.entries.filter((e) => ["job", "expense", "capital", "move", "fund_value", "fund_out"].includes(e.kind) && (!upTo || e.data.date <= upTo)).sort(sortByDate);
  for (const { kind, data: d } of events) {
    const a = Number(d.amount) || 0;
    if (kind === "job") { b.wc += d.split.wc; b.fund += d.split.fund; }
    if (kind === "expense") b[d.from || "wc"] -= a;
    if (kind === "capital") { b[d.to] += a; contributed[d.who] = (contributed[d.who] || 0) + a; }
    if (kind === "move") { b[d.from] -= a; b[d.to] += a; }
    if (kind === "fund_out") b.fund -= a;
    if (kind === "fund_value") { const v = Number(d.value) || 0; fundGain += v - b.fund; b.fund = v; snapshots.push({ date: d.date, value: v }); }
  }
  for (const k in b) b[k] = round2(b[k]);
  const total = round2(b.wc + b.fund + b.equipment + b.undecided);
  return { b, total, contributed, snapshots, fundGain: round2(fundGain) };
}

function salaryInMonth(month, exceptId) {
  return round2(ofKind("job").filter((e) => monthKey(e.data.date) === month && e.id !== exceptId).reduce((s, e) => s + (e.data.split?.salary || 0), 0));
}

// MOU money order: equipment -> employee pay -> Blaise's salary -> working capital -> fund
function splitJob({ amount, equipment, employee, date }, exceptId) {
  const s = settings();
  let left = round2(Number(amount) || 0);
  const eq = Math.min(Number(equipment) || 0, left); left = round2(left - eq);
  const emp = Math.min(Number(employee) || 0, left); left = round2(left - emp);
  const paidThisMonth = salaryInMonth(monthKey(date), exceptId);
  const capRoom = Math.max(0, s.salaryCap - paidThisMonth);
  const sal = round2(Math.min((Number(amount) || 0) * s.salaryPct / 100, capRoom, left)); left = round2(left - sal);
  const wcNow = ledger().b.wc;
  const wc = round2(Math.min(Math.max(0, s.wcTarget - wcNow), left)); left = round2(left - wc);
  return { equipment: eq, employee: emp, salary: sal, wc, fund: left, capRoom, capped: sal < round2((Number(amount) || 0) * s.salaryPct / 100) };
}

function fundWeekCheck() {
  const snaps = ledger().snapshots;
  if (snaps.length < 2) return null;
  const last = snaps[snaps.length - 1];
  const weekAgo = addDays(last.date, -7);
  const before = [...snaps].reverse().find((x) => x.date <= weekAgo) || snaps[Math.max(0, snaps.length - 2)];
  if (!before || before.value <= 0 || before === last) return null;
  const pct = (last.value - before.value) / before.value * 100;
  return { pct, from: before, to: last, alarm: pct <= -10 };
}

function nextMeeting() {
  const s = settings(); const d = new Date();
  const m = new Date(d); m.setHours(s.meetingHour, 0, 0, 0);
  const add = (1 - d.getDay() + 7) % 7; m.setDate(d.getDate() + add);
  if (m.getTime() + 3600e3 < d.getTime()) m.setDate(m.getDate() + 7); // after the hour has passed, go to next week
  const live = d >= m && d.getTime() < m.getTime() + 3600e3;
  const ms = m - d; const days = Math.floor(ms / 864e5), hrs = Math.floor(ms % 864e5 / 36e5);
  return { when: m, live, label: live ? "Happening now" : days > 0 ? `in ${days}d ${hrs}h` : `in ${hrs}h ${Math.floor(ms % 36e5 / 6e4)}m` };
}

/* ---------- views ---------- */
const TABS = [["home", "🏠", "Home"], ["money", "💵", "Money"], ["todo", "✅", "To-do"], ["monday", "📅", "Monday"], ["decide", "⚖️", "Decisions"], ["more", "⚙️", "More"]];

function render() {
  const app = $("#app");
  const view = { home: viewHome, money: viewMoney, todo: viewTodo, monday: viewMonday, decide: viewDecide, more: viewMore }[S.tab] || viewHome;
  app.innerHTML = `
    <header class="top">
      <div class="logo">B</div>
      <div><h1>Blaze's Partners</h1><div class="s" style="font-size:12px;color:var(--mute)">Blaise ${settings().blaisePct}% · Dad ${100 - settings().blaisePct}%</div></div>
      <div class="who">${S.mode === "demo" ? `<span class="pill demo">Demo · this device only</span>` : `<span class="pill live">Live · shared</span>`}<br>Signed in as <b>${esc(S.me)}</b></div>
    </header>
    <nav class="tabs">${TABS.map(([k, i, l]) => `<button data-tab="${k}" class="${S.tab === k ? "on" : ""}"><span>${i}</span>${l}</button>`).join("")}</nav>
    <main class="wrap">${view()}</main>`;
}

function viewHome() {
  const s = settings(); const L = ledger(); const m = monthKey(todayISO());
  const jobsM = ofKind("job").filter((e) => monthKey(e.data.date) === m);
  const revM = jobsM.reduce((t, e) => t + Number(e.data.amount), 0);
  const salM = salaryInMonth(m); const fundM = jobsM.reduce((t, e) => t + e.data.split.fund, 0);
  const pct = Math.min(100, L.total / s.goal * 100);
  const bp = s.blaisePct / 100;
  const wk = fundWeekCheck(); const mt = nextMeeting();
  const todos = ofKind("todo").filter((e) => !e.data.done).sort((a, b) => (a.data.due || "9").localeCompare(b.data.due || "9")).slice(0, 6);
  return `
    ${!S.entries.some((e) => e.kind === "settings") ? `<div class="note" style="margin-bottom:14px">First time here? Set your money rules (salary %, monthly cap, working capital, ownership) on the <button class="btn ghost sm" data-tab="more">More</button> tab.</div>` : ""}
    ${wk?.alarm ? `<div class="alert">⚠️ The fund is down ${Math.abs(wk.pct).toFixed(1)}% this week (${money(wk.from.value)} → ${money(wk.to.value)}). Per the MOU, it goes on Monday's agenda.</div>` : ""}
    <div class="grid g2">
      <section class="card hero">
        <h3>Total assets (fund + business)</h3>
        <div class="big num">${money(L.total)}</div>
        <div class="bar"><i style="width:${Math.max(pct, .6)}%"></i></div>
        <div class="row between" style="font-size:13px;color:var(--dim)"><span>${pct.toFixed(2)}% of ${money(s.goal)}</span><span>Goal by ${s.goalYear}</span></div>
        <div class="own"><i style="width:${s.blaisePct}%"></i><i style="width:${100 - s.blaisePct}%"></i></div>
        <div class="row between" style="font-size:14px"><span><span class="pill b">Blaise ${s.blaisePct}%</span> <b class="num">${money(L.total * bp)}</b></span><span><b class="num">${money(L.total * (1 - bp))}</b> <span class="pill d">Dad ${100 - s.blaisePct}%</span></span></div>
      </section>
      <section class="card">
        <div class="row between"><h2>This month</h2><button class="btn sm" data-act="job">+ Job paid</button></div>
        <div class="grid g4" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat"><h3>Revenue</h3><div class="num">${money(revM)}</div><small>${jobsM.length} job${jobsM.length === 1 ? "" : "s"}</small></div>
          <div class="stat"><h3>To the fund</h3><div class="num" style="color:var(--good)">${money(fundM)}</div></div>
          <div class="stat"><h3>Blaise's pay</h3><div class="num">${money(salM)}</div><small>cap ${money(s.salaryCap)}</small></div>
        </div>
        <div class="bar"><i style="width:${s.salaryCap ? Math.min(100, salM / s.salaryCap * 100) : 0}%"></i></div>
        <small style="color:var(--mute)">${money(Math.max(0, s.salaryCap - salM))} of salary room left this month</small>
      </section>
    </div>
    <div class="grid g4 mt">
      ${Object.entries(BUCKETS).map(([k, l]) => `<div class="card stat"><h3>${l}</h3><div class="num">${money(L.b[k])}</div>${k === "wc" ? `<small>target ${money(s.wcTarget)}</small>` : k === "fund" ? `<small>${wk ? `${wk.pct >= 0 ? "+" : ""}${wk.pct.toFixed(1)}% this week` : "Dad updates the value"}</small>` : k === "undecided" ? `<small>waiting on a decision</small>` : `<small>book value</small>`}</div>`).join("")}
    </div>
    <div class="grid g2 mt">
      <section class="card">
        <div class="row between"><h2>Open to-dos</h2><button class="btn ghost sm" data-tab="todo">See all</button></div>
        <div class="list">${todos.length ? todos.map(todoRow).join("") : `<div class="empty">Nothing open. Nice.</div>`}</div>
      </section>
      <section class="card">
        <h2>Next Monday meeting</h2>
        <div class="num" style="font-size:22px">${mt.when.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} · 9:00 pm</div>
        <div style="color:${mt.live ? "var(--good)" : "var(--dim)"};margin:4px 0 12px">${mt.label}</div>
        <button class="btn ghost sm" data-tab="monday">Open the agenda</button>
      </section>
    </div>`;
}

const KIND_LABEL = { job: "Job paid", expense: "Expense", capital: "Money in", move: "Moved", fund_value: "Fund value update", fund_out: "Fund paid out" };
function moneyRow(e) {
  const d = e.data; let amt = "", sub = "";
  if (e.kind === "job") { amt = `<span class="amt in">+${money(d.amount, true)}</span>`; sub = `Fund ${money(d.split.fund, true)} · Blaise ${money(d.split.salary, true)} · WC ${money(d.split.wc, true)}${d.split.equipment ? ` · Equip ${money(d.split.equipment, true)}` : ""}${d.split.employee ? ` · Employee ${money(d.split.employee, true)}` : ""}`; }
  if (e.kind === "expense") { amt = `<span class="amt out">-${money(d.amount, true)}</span>`; sub = `from ${BUCKETS[d.from || "wc"]}`; }
  if (e.kind === "capital") { amt = `<span class="amt in">+${money(d.amount, true)}</span>`; sub = `${esc(d.who)} → ${BUCKETS[d.to]}`; }
  if (e.kind === "move") { amt = `<span class="amt">${money(d.amount, true)}</span>`; sub = `${BUCKETS[d.from]} → ${BUCKETS[d.to]}`; }
  if (e.kind === "fund_value") { amt = `<span class="amt">${money(d.value, true)}</span>`; sub = "Fund's value on this day"; }
  if (e.kind === "fund_out") { amt = `<span class="amt out">-${money(d.amount, true)}</span>`; sub = "Out of the fund (taxes on its gains)"; }
  const title = e.kind === "job" ? (d.client || "Job") : e.kind === "expense" ? d.what : KIND_LABEL[e.kind];
  return `<div class="item"><div class="grow"><div class="t">${esc(title)} <span class="pill">${KIND_LABEL[e.kind]}</span></div><div class="s">${fmtDate(d.date)} · ${sub}${d.note ? ` · ${esc(d.note)}` : ""} · by ${esc(e.updated_by)}</div></div>${amt}<button class="x" title="Delete" data-del="${e.id}">✕</button></div>`;
}

function viewMoney() {
  const L = ledger(); const f = S.moneyFilter;
  const kinds = { all: null, jobs: ["job"], expenses: ["expense"], fund: ["fund_value", "fund_out"], other: ["capital", "move"] }[f];
  const rows = S.entries.filter((e) => KIND_LABEL[e.kind] && (!kinds || kinds.includes(e.kind))).sort(sortByDate).reverse();
  const totalIn = ofKind("job").reduce((t, e) => t + Number(e.data.amount), 0);
  const totalSal = ofKind("job").reduce((t, e) => t + e.data.split.salary, 0);
  const totalExp = ofKind("expense").reduce((t, e) => t + Number(e.data.amount), 0);
  return `
    <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <button class="btn" data-act="job">+ Job paid</button>
      <button class="btn ghost" data-act="expense">+ Expense</button>
      <button class="btn ghost" data-act="fund_value">Update fund value</button>
      <button class="btn ghost" data-act="capital">+ Money in</button>
      <button class="btn ghost" data-act="move">Move money</button>
      <button class="btn ghost" data-act="fund_out">Fund paid taxes</button>
    </div>
    <div class="grid g4">
      <div class="card stat"><h3>All-time job revenue</h3><div class="num">${money(totalIn)}</div></div>
      <div class="card stat"><h3>Blaise's pay (all time)</h3><div class="num">${money(totalSal)}</div></div>
      <div class="card stat"><h3>Expenses</h3><div class="num">${money(totalExp)}</div></div>
      <div class="card stat"><h3>Fund gain/loss</h3><div class="num" style="color:${L.fundGain >= 0 ? "var(--good)" : "var(--bad)"}">${L.fundGain >= 0 ? "+" : ""}${money(L.fundGain)}</div><small>from value updates</small></div>
    </div>
    <section class="card mt">
      <div class="row between" style="flex-wrap:wrap;gap:10px;margin-bottom:6px">
        <div class="seg" style="flex:1;max-width:520px">${[["all", "All"], ["jobs", "Jobs"], ["expenses", "Expenses"], ["fund", "Fund"], ["other", "Money in / moves"]].map(([k, l]) => `<button data-mf="${k}" class="${f === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <button class="btn ghost sm" data-act="csv">Download CSV</button>
      </div>
      <div class="list">${rows.length ? rows.map(moneyRow).join("") : `<div class="empty">Nothing here yet.</div>`}</div>
    </section>`;
}

function todoRow(e) {
  const d = e.data; const late = d.due && !d.done && d.due < todayISO();
  return `<div class="item ${d.done ? "done" : ""}"><button class="check ${d.done ? "on" : ""}" data-toggle="${e.id}">${d.done ? "✓" : ""}</button><div class="grow"><div class="t">${esc(d.title)}</div><div class="s">${d.due ? `<span style="color:${late ? "var(--bad)" : "inherit"}">${late ? "Late · " : "Due "}${fmtDate(d.due)}</span> · ` : ""}added by ${esc(e.updated_by)}</div></div><span class="pill ${d.who === "Blaise" ? "b" : d.who === "Dad" ? "d" : ""}">${esc(d.who)}</span><button class="x" data-del="${e.id}" title="Delete">✕</button></div>`;
}

function viewTodo() {
  const f = S.todoFilter;
  const all = ofKind("todo").sort((a, b) => (a.data.due || "9").localeCompare(b.data.due || "9"));
  const rows = all.filter((e) => f === "done" ? e.data.done : !e.data.done && (f === "open" || e.data.who === f || (f !== "Both" && e.data.who === "Both")));
  return `
    <section class="card">
      <h2>Add a to-do</h2>
      <form data-form="todo" class="grid" style="grid-template-columns:1fr 130px 150px auto;gap:8px;align-items:end">
        <input name="title" placeholder="What needs doing?" required>
        <select name="who"><option>Both</option><option ${S.me === "Blaise" ? "selected" : ""}>Blaise</option><option ${S.me === "Dad" ? "selected" : ""}>Dad</option></select>
        <input name="due" type="date">
        <button class="btn">Add</button>
      </form>
    </section>
    <section class="card mt">
      <div class="seg" style="margin-bottom:8px">${[["open", "All open"], ["Blaise", "Blaise"], ["Dad", "Dad"], ["done", "Done"]].map(([k, l]) => `<button data-tf="${k}" class="${f === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="list">${rows.length ? rows.map(todoRow).join("") : `<div class="empty">Nothing here.</div>`}</div>
    </section>
    <style>@media(max-width:640px){form[data-form=todo]{grid-template-columns:1fr 1fr!important}form[data-form=todo] input[name=title]{grid-column:1/-1}}</style>`;
}

function viewMonday() {
  const s = settings(); const L = ledger(); const mt = nextMeeting();
  const meetings = ofKind("meeting").sort(sortByDate).reverse();
  const since = meetings[0]?.data.date || addDays(todayISO(), -7);
  const jobs = ofKind("job").filter((e) => e.data.date > since);
  const rev = jobs.reduce((t, e) => t + Number(e.data.amount), 0);
  const wk = fundWeekCheck();
  const openDec = ofKind("decision").filter((e) => e.data.status !== "decided");
  const late = ofKind("todo").filter((e) => !e.data.done && e.data.due && e.data.due < todayISO());
  const draft = localStorage.getItem("bpw_meeting_draft") || "";
  return `
    <div class="grid g2">
      <section class="card hero">
        <h3>Weekly meeting · 1 hour</h3>
        <div class="big num" style="font-size:30px">${mt.when.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
        <div>9:00 – 10:00 pm · <b style="color:${mt.live ? "var(--good)" : "var(--fire)"}">${mt.label}</b></div>
      </section>
      <section class="card">
        <h2>Agenda (fills itself in)</h2>
        <div class="split">
          <span class="k">1. Jobs & sales since ${fmtDate(since)}</span><b>${jobs.length} · ${money(rev)}</b>
          <span class="k">2. Fund balance</span><b>${money(L.b.fund)}${wk ? ` <span style="color:${wk.pct < 0 ? "var(--bad)" : "var(--good)"}">(${wk.pct >= 0 ? "+" : ""}${wk.pct.toFixed(1)}%)</span>` : ""}</b>
          <span class="k">3. Working capital</span><b>${money(L.b.wc)} / ${money(s.wcTarget)}</b>
          <span class="k">4. Decisions coming up</span><b>${openDec.length}</b>
          <span class="k">5. Late to-dos</span><b style="color:${late.length ? "var(--bad)" : "inherit"}">${late.length}</b>
        </div>
        ${wk?.alarm ? `<div class="alert mt" style="margin-bottom:0">Fund down 10%+ this week — discuss it (MOU rule).</div>` : ""}
      </section>
    </div>
    ${openDec.length || late.length ? `<section class="card mt"><h2>To talk about</h2><div class="list">${openDec.map((e) => `<div class="item"><div class="grow"><div class="t">⚖️ ${esc(e.data.title)}</div><div class="s">${areaInfo(e.data.area).lead}</div></div></div>`).join("")}${late.map(todoRow).join("")}</div></section>` : ""}
    <section class="card mt">
      <h2>Meeting notes</h2>
      <form data-form="meeting">
        <input type="date" name="date" value="${todayISO()}" style="max-width:200px">
        <label>What we talked about / decided / who does what</label>
        <textarea name="notes" data-draft placeholder="e.g. Booked 3 houses for Saturday. Fund up 4%. Next: new surface cleaner.">${esc(draft)}</textarea>
        <div class="row mt"><button class="btn">Save meeting</button><span class="s" style="color:var(--mute);font-size:12px">Notes are kept as you type until you save.</span></div>
      </form>
    </section>
    <section class="card mt">
      <h2>Past meetings</h2>
      <div class="list">${meetings.length ? meetings.map((e) => `<div class="item" style="align-items:flex-start"><div class="grow"><div class="t">${fmtDate(e.data.date)}</div><div class="s" style="white-space:pre-wrap;color:var(--dim);font-size:14px">${esc(e.data.notes)}</div></div><button class="x" data-del="${e.id}">✕</button></div>`).join("") : `<div class="empty">No meetings saved yet.</div>`}</div>
    </section>`;
}

const AREAS = {
  ops: { label: "Sales & operations", lead: "Blaise leads — his call if we disagree" },
  finance: { label: "Finance & investing", lead: "Dad leads — his call if we disagree" },
  hire_ops: { label: "Hiring: field role", lead: "Both agree; Blaise has final say" },
  hire_fin: { label: "Hiring: office role", lead: "Both agree; Dad has final say" },
  strategy: { label: "Investment strategy change", lead: "Blaise gets a vote" },
  veto: { label: "Debt / new partner / closing", lead: "Blaise can veto" },
  other: { label: "Other major decision", lead: "Decide together" },
};
const areaInfo = (k) => AREAS[k] || AREAS.other;

function viewDecide() {
  const all = ofKind("decision").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const open = all.filter((e) => e.data.status !== "decided"), done = all.filter((e) => e.data.status === "decided");
  const row = (e) => `<div class="item" style="align-items:flex-start"><div class="grow"><div class="t">${esc(e.data.title)}</div><div class="s">${areaInfo(e.data.area).label} · ${areaInfo(e.data.area).lead}${e.data.status === "decided" ? `<br><b style="color:var(--ink)">Decided ${fmtDate(e.data.decidedOn)}:</b> ${esc(e.data.outcome)}` : ""}</div></div>${e.data.status !== "decided" ? `<button class="btn ghost sm" data-decide="${e.id}">Mark decided</button>` : ""}<button class="x" data-del="${e.id}">✕</button></div>`;
  return `
    <section class="card">
      <h2>Bring up a decision</h2>
      <form data-form="decision" class="grid" style="grid-template-columns:1fr 240px auto;gap:8px;align-items:end">
        <input name="title" placeholder="e.g. Buy a surface cleaner?" required>
        <select name="area">${Object.entries(AREAS).map(([k, a]) => `<option value="${k}">${a.label}</option>`).join("")}</select>
        <button class="btn">Add</button>
      </form>
    </section>
    <section class="card mt"><h2>Open (${open.length})</h2><div class="list">${open.length ? open.map(row).join("") : `<div class="empty">No open decisions.</div>`}</div></section>
    <section class="card mt"><h2>Decided</h2><div class="list">${done.length ? done.map(row).join("") : `<div class="empty">Nothing decided yet.</div>`}</div></section>
    <section class="card mt"><h2>Who decides what (from the MOU)</h2><div class="split">${Object.values(AREAS).map((a) => `<span class="k">${a.label}</span><span>${a.lead}</span>`).join("")}</div></section>
    <style>@media(max-width:640px){form[data-form=decision]{grid-template-columns:1fr!important}}</style>`;
}

function viewMore() {
  const s = settings(); const c = cfg();
  return `
    <div class="grid g2">
      <section class="card">
        <h2>Sharing</h2>
        ${S.mode === "demo" ? `
          <div class="note">You're in <b>demo mode</b>: everything is saved on this device only. When Dad finishes the Supabase setup (SETUP.md), this turns into one shared dashboard for both of you.</div>
          <label>Who's using this device?</label>
          <div class="seg">${PEOPLE.map((p) => `<button data-me="${p}" class="${S.me === p ? "on" : ""}">${p}</button>`).join("")}</div>
          <label>Supabase project URL</label><input id="sbUrl" value="${esc(c.url)}" placeholder="https://xxxx.supabase.co">
          <label>Supabase anon key</label><input id="sbKey" value="${esc(c.key)}" placeholder="eyJ...">
          <div class="row mt"><button class="btn" data-act="connect">Connect</button><button class="btn ghost" data-act="reset-demo">Reset demo data</button></div>`
        : `
          <div class="note">Live and shared. Changes show up on both phones right away.</div>
          <div class="row mt" style="flex-wrap:wrap"><button class="btn ghost" data-act="import-demo">Copy this device's demo data up</button><button class="btn ghost" data-act="signout">Sign out</button></div>`}
      </section>
      <section class="card">
        <h2>Money rules</h2>
        <form data-form="settings">
          <div class="two">
            <div><label>Blaise's cut of each job (%)</label><input name="salaryPct" type="number" step="1" value="${s.salaryPct}"></div>
            <div><label>Salary cap per month ($)</label><input name="salaryCap" type="number" step="1" value="${s.salaryCap}"></div>
            <div><label>Working capital to keep ($)</label><input name="wcTarget" type="number" step="1" value="${s.wcTarget}"></div>
            <div><label>Blaise's ownership (%)</label><input name="blaisePct" type="number" step="1" value="${s.blaisePct}"></div>
            <div><label>Total-asset goal ($)</label><input name="goal" type="number" step="1000" value="${s.goal}"></div>
            <div><label>Goal year</label><input name="goalYear" type="number" value="${s.goalYear}"></div>
          </div>
          <div class="row mt"><button class="btn">Save rules</button></div>
        </form>
        <p style="color:var(--mute);font-size:13px">Changing these only affects new jobs. Old jobs keep the split they had when you logged them.</p>
      </section>
    </div>
    <section class="card mt">
      <h2>How a job payment gets split (MOU order)</h2>
      <div class="split">
        <span class="k">1. Equipment costs for the job</span><span>first</span>
        <span class="k">2. Employee pay</span><span>if any</span>
        <span class="k">3. Blaise's salary</span><span>${s.salaryPct}% of the job, max ${money(s.salaryCap)}/month</span>
        <span class="k">4. Working capital</span><span>tops up to ${money(s.wcTarget)}</span>
        <span class="k">5. Investment fund</span><span>everything left</span>
      </div>
      <p style="color:var(--mute);font-size:13px">Money in the fund stays there. The one exception: the fund can pay the taxes on its own gains ("Fund paid taxes").</p>
    </section>
    <section class="card mt">
      <h2>Backup</h2>
      <div class="row" style="flex-wrap:wrap"><button class="btn ghost" data-act="backup">Download everything (JSON)</button><button class="btn ghost" data-act="csv">Money CSV</button></div>
    </section>`;
}

/* ---------- modals (money forms) ---------- */
function bucketOpts(sel, skip) { return Object.entries(BUCKETS).filter(([k]) => k !== skip).map(([k, l]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${l}</option>`).join(""); }

const FORMS = {
  job: () => `<h2>Job paid 💦</h2>
    <label>Client / job</label><input name="client" placeholder="Smith — house wash + driveway" required>
    <div class="two"><div><label>Amount paid ($)</label><input name="amount" type="number" step="0.01" min="0" required data-live></div><div><label>Date</label><input name="date" type="date" value="${todayISO()}" data-live></div>
    <div><label>Equipment costs ($)</label><input name="equipment" type="number" step="0.01" min="0" value="0" data-live></div><div><label>Employee pay ($)</label><input name="employee" type="number" step="0.01" min="0" value="0" data-live></div></div>
    <label>Note</label><input name="note" placeholder="optional">
    <div class="card mt" style="background:var(--bg2)"><h3>Where this money goes</h3><div id="preview" class="split"></div></div>`,
  expense: () => `<h2>Expense</h2>
    <label>What for</label><input name="what" placeholder="Gas, chemicals, nozzle..." required>
    <div class="two"><div><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0" required></div><div><label>Date</label><input name="date" type="date" value="${todayISO()}"></div></div>
    <label>Paid from</label><select name="from">${bucketOpts("wc", "fund")}</select>
    <p style="color:var(--mute);font-size:13px">The fund doesn't pay for operations (MOU). Buying equipment? Use "Move money" from working capital → Equipment instead.</p>`,
  fund_value: () => `<h2>Update fund value</h2>
    <p style="color:var(--dim);font-size:14px">What are all the fund's accounts worth right now? (Dad checks this daily — log it at least weekly.)</p>
    <div class="two"><div><label>Total value ($)</label><input name="value" type="number" step="0.01" min="0" required value="${ledger().b.fund}"></div><div><label>Date</label><input name="date" type="date" value="${todayISO()}"></div></div>
    <label>Note</label><input name="note" placeholder="optional — e.g. BTC rally">`,
  capital: () => `<h2>Money in</h2>
    <p style="color:var(--dim);font-size:14px">Money a partner puts in (or a loan from Dad for working capital).</p>
    <div class="two"><div><label>From</label><select name="who">${PEOPLE.map((p) => `<option ${p === S.me ? "selected" : ""}>${p}</option>`).join("")}</select></div><div><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0" required></div>
    <div><label>Goes to</label><select name="to">${bucketOpts("wc")}</select></div><div><label>Date</label><input name="date" type="date" value="${todayISO()}"></div></div>
    <label>Note</label><input name="note" placeholder="optional">`,
  move: () => `<h2>Move money</h2>
    <div class="two"><div><label>From</label><select name="from">${bucketOpts("undecided")}</select></div><div><label>To</label><select name="to">${bucketOpts("equipment")}</select></div>
    <div><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0" required></div><div><label>Date</label><input name="date" type="date" value="${todayISO()}"></div></div>
    <label>Note</label><input name="note" placeholder="e.g. Bought surface cleaner">
    <p style="color:var(--mute);font-size:13px">Remember: money that goes into the fund doesn't come back out for operations.</p>`,
  fund_out: () => `<h2>Fund paid taxes</h2>
    <p style="color:var(--dim);font-size:14px">The one time money leaves the fund: to pay the taxes on its own gains.</p>
    <div class="two"><div><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0" required></div><div><label>Date</label><input name="date" type="date" value="${todayISO()}"></div></div>
    <label>Note</label><input name="note" placeholder="e.g. 2026 capital gains">`,
};

function openForm(kind) {
  const m = $("#modal");
  m.innerHTML = `<form class="box" data-form="money" data-kind="${kind}">${FORMS[kind]()}<div class="acts"><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn">Save</button></div></form>`;
  m.hidden = false;
  if (kind === "job") { const f = m.querySelector("form"); const up = () => jobPreview(f); f.addEventListener("input", up); up(); }
  setTimeout(() => m.querySelector("input")?.focus(), 30);
}
function closeModal() { $("#modal").hidden = true; $("#modal").innerHTML = ""; }

function jobPreview(f) {
  const v = Object.fromEntries(new FormData(f)); const sp = splitJob(v); const s = settings();
  $("#preview").innerHTML = `
    <span class="k">Equipment</span><b>${money(sp.equipment, true)}</b>
    <span class="k">Employee pay</span><b>${money(sp.employee, true)}</b>
    <span class="k">Blaise's salary (${s.salaryPct}%)${sp.capped ? " — hit monthly cap" : ""}</span><b>${money(sp.salary, true)}</b>
    <span class="k">Working capital top-up</span><b>${money(sp.wc, true)}</b>
    <span class="k" style="color:var(--good)">→ Investment fund</span><b style="color:var(--good)">${money(sp.fund, true)}</b>`;
}

/* ---------- exports ---------- */
function download(name, text, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
function exportCSV() {
  const rows = [["date", "type", "description", "amount", "to_fund", "blaise_salary", "working_capital", "equipment", "employee", "from", "to", "by"]];
  for (const e of S.entries.filter((e) => KIND_LABEL[e.kind]).sort(sortByDate)) {
    const d = e.data, sp = d.split || {};
    rows.push([d.date, KIND_LABEL[e.kind], d.client || d.what || d.who || d.note || "", d.amount ?? d.value ?? "", sp.fund ?? "", sp.salary ?? "", sp.wc ?? "", sp.equipment ?? "", sp.employee ?? "", d.from || "", d.to || "", e.updated_by]);
  }
  download(`blazes-money-${todayISO()}.csv`, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n"), "text/csv");
}

/* ---------- events ---------- */
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("button"); if (!t) { if (ev.target.id === "modal") closeModal(); return; }
  const ds = t.dataset;
  try {
    if (ds.tab) { S.tab = ds.tab; localStorage.setItem("bpw_tab", S.tab); render(); window.scrollTo(0, 0); }
    else if (ds.mf) { S.moneyFilter = ds.mf; render(); }
    else if (ds.tf) { S.todoFilter = ds.tf; render(); }
    else if (ds.me) { S.me = ds.me; localStorage.setItem("bpw_me", S.me); render(); }
    else if (ds.toggle) { const e = S.entries.find((x) => x.id === ds.toggle); await save("todo", { ...e.data, done: !e.data.done, doneOn: e.data.done ? "" : todayISO() }, e.id); }
    else if (ds.del) { if (confirm("Delete this for both of you?")) { await removeEntry(ds.del); toast("Deleted"); } }
    else if (ds.decide) {
      const e = S.entries.find((x) => x.id === ds.decide); const outcome = prompt("What did you decide?"); if (outcome == null) return;
      await save("decision", { ...e.data, status: "decided", outcome, decidedOn: todayISO() }, e.id); toast("Decision saved");
    }
    else if (ds.act === "close") closeModal();
    else if (FORMS[ds.act]) openForm(ds.act);
    else if (ds.act === "csv") exportCSV();
    else if (ds.act === "backup") download(`blazes-partners-backup-${todayISO()}.json`, JSON.stringify(S.entries, null, 2), "application/json");
    else if (ds.act === "reset-demo") { if (confirm("Wipe the demo data on this device and start over?")) { localStorage.removeItem(DemoBackend.key); await reload(); toast("Demo reset"); } }
    else if (ds.act === "connect") {
      localStorage.setItem("bpw_url", $("#sbUrl").value.trim()); localStorage.setItem("bpw_key", $("#sbKey").value.trim()); localStorage.removeItem("bpw_force_demo"); location.reload();
    }
    else if (ds.act === "signout") { await S.sb.auth.signOut(); location.reload(); }
    else if (ds.act === "use-demo") { localStorage.setItem("bpw_force_demo", "1"); location.reload(); }
    else if (ds.act === "import-demo") {
      const local = JSON.parse(localStorage.getItem(DemoBackend.key) || "[]").filter((e) => e.kind !== "settings");
      if (!local.length) return toast("No demo data on this device");
      if (!confirm(`Copy ${local.length} items from this device's demo into the shared dashboard?`)) return;
      for (const e of local) await S.backend.save({ ...e, updated_by: e.updated_by || S.me });
      await reload(); toast(`Copied ${local.length} items`);
    }
  } catch (err) { console.error(err); toast("Error: " + (err.message || err)); }
});

document.addEventListener("input", (ev) => { if (ev.target.matches("[data-draft]")) localStorage.setItem("bpw_meeting_draft", ev.target.value); });

document.addEventListener("submit", async (ev) => {
  const f = ev.target; ev.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  try {
    if (f.dataset.form === "login") return login(v);
    if (f.dataset.form === "todo") { await save("todo", { title: v.title.trim(), who: v.who, due: v.due, done: false }); toast("Added"); }
    if (f.dataset.form === "decision") { await save("decision", { title: v.title.trim(), area: v.area, status: "open" }); toast("Added to the list"); }
    if (f.dataset.form === "meeting") {
      if (!v.notes.trim()) return toast("Write some notes first");
      await save("meeting", { date: v.date, notes: v.notes.trim() }); localStorage.removeItem("bpw_meeting_draft"); toast("Meeting saved");
    }
    if (f.dataset.form === "settings") {
      const cur = S.entries.find((e) => e.kind === "settings"); const data = {};
      for (const k in v) data[k] = Number(v[k]);
      await save("settings", { ...(cur?.data || {}), ...data }, cur?.id || "settings"); toast("Rules saved");
    }
    if (f.dataset.form === "money") {
      const kind = f.dataset.kind; const d = { ...v };
      for (const k of ["amount", "value", "equipment", "employee"]) if (k in d) d[k] = round2(Number(d[k]) || 0);
      if (kind === "move" && d.from === d.to) return toast("Pick two different places");
      if (kind === "job") d.split = splitJob(d);
      await save(kind, d); closeModal(); toast(kind === "job" ? `Logged — ${money(d.split.fund, true)} to the fund` : "Saved");
    }
  } catch (err) { console.error(err); toast("Error: " + (err.message || err)); }
});

/* ---------- start-up ---------- */
function loginScreen(msg = "") {
  $("#app").innerHTML = `<div class="center"><form class="card login" data-form="login">
    <div class="row" style="margin-bottom:10px"><div class="logo">B</div><h1>Blaze's Partners</h1></div>
    ${msg ? `<div class="alert">${esc(msg)}</div>` : ""}
    <label>Email</label><input name="email" type="email" autocomplete="username" required>
    <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="row mt between"><button class="btn">Sign in</button><button type="button" class="btn ghost sm" data-act="use-demo">Use demo instead</button></div>
  </form></div>`;
}

async function login({ email, password }) {
  const { error } = await S.sb.auth.signInWithPassword({ email, password });
  if (error) return loginScreen(error.message);
  startLive();
}

async function startLive() {
  const { data: { session } } = await S.sb.auth.getSession();
  if (!session) return loginScreen();
  const { data: mem, error } = await S.sb.from("members").select("name").eq("email", session.user.email.toLowerCase()).maybeSingle();
  if (error || !mem) { await S.sb.auth.signOut(); return loginScreen(error ? `Database not set up yet: ${error.message}` : "That login isn't one of the two partners. Dad adds partners in the members table (SETUP.md)."); }
  S.me = mem.name; S.mode = "live"; S.backend = makeLiveBackend(S.sb);
  S.backend.subscribe(() => { clearTimeout(startLive._t); startLive._t = setTimeout(reload, 250); });
  await reload();
}

(async function boot() {
  const c = cfg();
  if (c.url && c.key && window.supabase && !localStorage.getItem("bpw_force_demo")) {
    S.sb = window.supabase.createClient(c.url, c.key);
    try { await startLive(); } catch (e) { loginScreen("Couldn't reach Supabase: " + e.message); }
  } else {
    await reload();
  }
  setInterval(() => { if (S.tab === "home" || S.tab === "monday") { if (!document.activeElement || document.activeElement === document.body) render(); } }, 60000);
})();
