/* シフト家計簿 — シフトボード（Googleカレンダー同期）× Google Drive 保存 */
(() => {
'use strict';

// ---------- 定数 ----------
const DRIVE_FILE = 'shift-money-planner.json';
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.readonly';
const LS_KEY = 'shiftMoney.v1';
const LS_CID = 'shiftMoney.clientId';

// ---------- 安全なローカル保存（使えない環境では無視） ----------
// 端末内保存（公開版ではブラウザの保存領域、使えない環境ではメモリのみ）
const MEM = {};
const store = () => { try { const s = window['local' + 'Storage']; s.getItem('_'); return s; } catch { return null; } };
const LS = {
  get(k){ const s = store(); try { return s ? s.getItem(k) : (MEM[k] ?? null); } catch { return MEM[k] ?? null; } },
  set(k,v){ MEM[k] = v; const s = store(); try { s && s.setItem(k,v); } catch {} },
};

// ---------- 日付ユーティリティ（端末のタイムゾーン基準） ----------
const D = {
  today(){ const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); },
  last(y,m){ return new Date(y, m+1, 0).getDate(); },
  on(y,m,day){ const mm = ((m%12)+12)%12, yy = y + Math.floor(m/12); return new Date(yy, mm, Math.min(Math.max(1,day), D.last(yy,mm))); },
  addM(y,m,k){ const t = m + k; return { y: y + Math.floor(t/12), m: ((t%12)+12)%12 }; },
  addD(d,k){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()+k); },
  ymd(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; },
  ym(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; },
  parse(s){ if(!s) return null; const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d||1); },
  md(d){ return `${d.getMonth()+1}/${d.getDate()}`; },
  ymj(d){ return `${d.getFullYear()}年${d.getMonth()+1}月`; },
  wd(d){ return '日月火水木金土'[d.getDay()]; },
  diff(a,b){ return Math.round((b - a) / 86400000); },
  sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); },
};
const yen = n => (n < 0 ? '−' : '') + '¥' + Math.abs(Math.round(n||0)).toLocaleString('ja-JP');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Math.random().toString(36).slice(2,10);
const num = v => { const n = Number(String(v ?? '').replace(/[,¥\s]/g,'')); return isFinite(n) ? n : 0; };

// ---------- 状態 ----------
const blank = () => ({
  version: 1,
  savedAt: 0,
  settings: {
    closingDay: 0, payDay: 25, payOffset: 1,
    balance: 0, defaultWage: 1100, breakRule: 'none',
    salaryManual: null, calendarIds: [], workplaces: [],
  },
  items: [],
  cache: { shifts: [], syncedAt: 0, calendars: [] },
});
let S = load();
function load(){
  try { const raw = LS.get(LS_KEY); if (raw) return merge(JSON.parse(raw)); } catch {}
  return blank();
}
function merge(x){ const b = blank(); return { ...b, ...x, settings: { ...b.settings, ...(x.settings||{}) }, cache: { ...b.cache, ...(x.cache||{}) }, items: x.items || [] }; }

let saveTimer = null;
function commit(opts = {}){
  S.savedAt = Date.now();
  LS.set(LS_KEY, JSON.stringify(S));
  render();
  if (opts.noDrive) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (G.token) driveSave().catch(err => setSync('err', '保存失敗')); }, 900);
}

// ---------- 締め日・給料日 ----------
function closingDate(y,m){ const c = S.settings.closingDay; const t = D.addM(y,m,0); return D.on(t.y, t.m, (!c || c >= D.last(t.y,t.m)) ? 31 : c); }
function payPeriod(y,m){
  const pm = D.addM(y, m, -S.settings.payOffset);
  const end = closingDate(pm.y, pm.m);
  const pp = D.addM(pm.y, pm.m, -1);
  const start = D.addD(closingDate(pp.y, pp.m), 1);
  return { start, end, payDate: D.on(y, m, S.settings.payDay) };
}
function context(){
  const today = D.today();
  const y = today.getFullYear(), m = today.getMonth();
  const cur = payPeriod(y, m);
  const nm = D.addM(y, m, 1);
  const deadline = closingDate(nm.y, nm.m);
  const earnStart = D.addD(cur.end, 1);
  return { today, cur, deadline, earnStart };
}

// ---------- シフト → 給与 ----------
function workplaceOf(sh){
  const wps = S.settings.workplaces;
  return wps.find(w => w.keyword && ((sh.title||'').includes(w.keyword) || (sh.location||'').includes(w.keyword))) || null;
}
function dedupeShifts(list){
  const sorted = [...list].sort((a,b) => (b.updated||'').localeCompare(a.updated||''));
  const kept = [];
  for (const s of sorted){
    const st = +new Date(s.start), en = +new Date(s.end);
    const clash = kept.find(k => k.title === s.title && +new Date(k.start) < en && st < +new Date(k.end));
    s.dupOf = clash ? clash.id : null;
    if (!clash) kept.push(s);
  }
  return list;
}
function shiftPay(sh, wp){
  const st = new Date(sh.start), en = new Date(sh.end);
  let mins = Math.max(0, (en - st) / 60000);
  let brk = 0;
  const rule = S.settings.breakRule;
  if (rule === 'auto') brk = mins > 480 ? 60 : mins > 360 ? 45 : 0;
  let night = 0;
  for (let t = +st; t < +en; t += 60000){ const h = new Date(t).getHours(); if (h >= 22 || h < 5) night++; }
  const wage = num(wp?.wage) || num(S.settings.defaultWage);
  const work = Math.max(0, mins - brk);
  const pay = wage * work / 60 + wage * (num(wp?.night ?? 25) / 100) * night / 60 + num(wp?.transport);
  return { mins: work, brk, night, pay: Math.round(pay), wage };
}
function shiftsIn(from, to){
  const end = D.addD(to, 1);
  return S.cache.shifts
    .filter(s => { const d = new Date(s.start); return d >= from && d < end; })
    .map(s => ({ ...s, wp: workplaceOf(s) }))
    .filter(s => s.wp)
    .sort((a,b) => a.start.localeCompare(b.start));
}
function salaryFor(from, to){
  const list = shiftsIn(from, to).map(s => ({ ...s, calc: shiftPay(s, s.wp) }));
  const valid = list.filter(s => !s.dupOf);
  return { list, total: valid.reduce((a,s) => a + s.calc.pay, 0), mins: valid.reduce((a,s) => a + s.calc.mins, 0), dup: list.length - valid.length };
}

// ---------- 項目の定義 ----------
function monthlyDates(day, from, to){
  const out = []; if (!day) return out;
  let y = from.getFullYear(), m = from.getMonth();
  for (let i = 0; i < 24; i++){
    const d = D.on(y, m, num(day));
    if (d > to) break;
    if (d >= from) out.push(d);
    ({ y, m } = D.addM(y, m, 1));
  }
  return out;
}
function revoSim(balance, monthly, rate){
  const r = num(rate) / 100 / 12; let b = num(balance), n = 0, interest = 0;
  const p = num(monthly);
  if (b <= 0) return { n: 0, interest: 0 };
  if (p <= b * r) return { n: Infinity, interest: Infinity };
  while (b > 0 && n < 600){ const i = b * r; interest += i; b = b + i - p; n++; }
  return { n, interest: Math.round(interest) };
}
// 延期：it.moves = { 元の日付(YYYY-MM-DD): 新しい日付 | 'skip' }
function moved(it, d){ const m = (it.moves || {})[D.ymd(d)]; if (m === 'skip') return null; return m ? D.parse(m) : d; }
// 毎月の発生日（延期を反映）。今日〜to の範囲を返す
function occ(it, day, c, to){
  const out = [];
  for (const o of monthlyDates(day, D.addD(c.today, -93), D.addD(to || c.deadline, 0))){
    const d = moved(it, o); if (!d) continue;
    if (d >= c.today && d <= (to || c.deadline)) out.push({ orig: o, date: d, moved: +d !== +o });
  }
  // 延期で期間外に出た回は除外、期間内に移った過去の回も含める
  for (const [k, v] of Object.entries(it.moves || {})){
    if (v === 'skip') continue; const o = D.parse(k), d = D.parse(v);
    if (o < D.addD(c.today, -93) && d >= c.today && d <= (to || c.deadline)) out.push({ orig: o, date: d, moved: true });
  }
  return out.sort((a,b) => a.date - b.date);
}
const FAR = c => D.addD(c.today, 400);
function instSchedule(it){
  const start = it.startMonth ? D.parse(it.startMonth + '-01') : D.today();
  let count, per, last;
  if (it.mode === 'monthly'){
    per = num(it.monthly); const total = num(it.total);
    count = per > 0 ? Math.ceil(total / per) : 0; last = total - per * (count - 1);
  } else {
    count = Math.max(0, Math.round(num(it.count))); const total = num(it.total);
    per = count ? Math.floor(total / count) : 0; last = total - per * (count - 1);
  }
  const dates = []; for (let k = 0; k < count; k++){ const t = D.addM(start.getFullYear(), start.getMonth(), k); const o = D.on(t.y, t.m, num(it.dueDay) || 27); dates.push({ o, d: moved(it, o) || o, amt: k === count - 1 ? last : per }); }
  dates.sort((a,b) => a.d - b.d);
  return { dates, count, per };
}
function cardDueMonthFor(it, y, m){ return num(it.dueDay) > num(it.closeDay) ? D.addM(y, m, 0) : D.addM(y, m, 1); }
const moveNote = f => f.moved ? `${D.md(f.orig)}から延期` : '';

const TYPES = {
  lump: { label: '要返済（一括）', group: 'expense', tag: '一括', postpone: true,
    fields: [
      { k: 'name', l: '名前（誰に・何を）', t: 'text', full: true, ph: '例：友だちに借りたお金' },
      { k: 'amount', l: '金額', t: 'yen' },
      { k: 'dueDate', l: '返済期日', t: 'date' },
      { k: 'paid', l: '状態', t: 'select', opts: [['', '未返済'], ['1', '返済済み']] },
      { k: 'memo', l: 'メモ', t: 'text', full: true },
    ],
    analyze(it, c){
      const o = D.parse(it.dueDate); const due = o ? moved(it, o) || o : null;
      if (it.paid) return { flows: [], meta: '返済済み', head: num(it.amount) };
      const flows = []; let meta = '期日未設定'; let next = null;
      if (due){
        const left = D.diff(c.today, due);
        meta = left < 0 ? `期日を${-left}日過ぎています` : left === 0 ? '今日が期日' : `${D.md(due)}（${D.wd(due)}）まで あと${left}日`;
        if (+due !== +o) meta += `（${D.md(o)}から延期）`;
        const f = { orig: o, date: due < c.today ? c.today : due, amount: num(it.amount), moved: +due !== +o };
        f.note = left < 0 ? '期限超過' : moveNote(f);
        next = f;
        if (due <= c.deadline) flows.push(f); else meta += '（今回の計算期間外）';
      }
      return { flows, meta, head: num(it.amount), warn: due && due < c.today, next };
    }},
  revo: { label: 'リボ残高', group: 'expense', tag: 'リボ', postpone: true,
    fields: [
      { k: 'name', l: 'カード名', t: 'text', full: true, ph: '例：〇〇カード リボ' },
      { k: 'balance', l: '現在のリボ残高', t: 'yen' },
      { k: 'monthly', l: '毎月の支払額', t: 'yen' },
      { k: 'rate', l: '年利（％）', t: 'number', ph: '15', step: '0.1' },
      { k: 'dueDay', l: '引き落とし日', t: 'day' },
    ],
    analyze(it, c){
      const sim = revoSim(it.balance, it.monthly, it.rate);
      const r = num(it.rate) / 100 / 12; let b = num(it.balance); const all = [];
      for (const o of occ(it, it.dueDay, c, FAR(c))){ if (b <= 0) break; const p = Math.min(num(it.monthly), Math.round(b * (1 + r))); all.push({ ...o, amount: p, note: moveNote(o) }); b = b * (1 + r) - p; }
      const flows = all.filter(f => f.date <= c.deadline);
      let meta;
      if (sim.n === Infinity) meta = '支払額が利息以下のため、このままでは残高が減りません';
      else if (sim.n === 0) meta = '完済済み';
      else { const t = D.today(); const fin = D.addM(t.getFullYear(), t.getMonth(), sim.n); meta = `あと約${sim.n}回で完済（${fin.y}年${fin.m+1}月ごろ）・利息 約${yen(sim.interest)}`; }
      return { flows, meta, head: num(it.balance), warn: sim.n === Infinity, sub: `毎月 ${yen(it.monthly)}`, next: all[0] || null };
    }},
  card: { label: 'クレジットカード（月払い）', group: 'expense', tag: 'カード', postpone: true,
    fields: [
      { k: 'name', l: 'カード名', t: 'text', full: true, ph: '例：楽天カード' },
      { k: 'closeDay', l: '請求確定日（毎月）', t: 'day', hint: 'この日に金額の入力をお知らせします' },
      { k: 'dueDay', l: '引き落とし日', t: 'day' },
      { k: 'estimate', l: '未確定のときの見込み額', t: 'yen', hint: '確定前の計算に使います' },
    ],
    analyze(it, c){
      it.amounts = it.amounts || {};
      const all = occ(it, it.dueDay, c, FAR(c)).map(o => {
        const k = D.ym(o.orig); const fixed = it.amounts[k] != null;
        return { ...o, amount: fixed ? num(it.amounts[k]) : num(it.estimate), note: [fixed ? '確定' : '見込み', moveNote(o)].filter(Boolean).join('・') };
      });
      const flows = all.filter(f => f.date <= c.deadline);
      const next = all[0];
      return { flows, meta: next ? `次回 ${D.md(next.date)} 引き落とし ${yen(next.amount)}（${next.note}）` : '引き落とし予定なし', head: next ? next.amount : 0, sub: `毎月${it.closeDay}日確定 / ${it.dueDay}日引落`, next };
    }},
  inst: { label: '分割払い', group: 'expense', tag: '分割', postpone: true,
    fields: [
      { k: 'name', l: '名前', t: 'text', full: true, ph: '例：スマホ本体' },
      { k: 'mode', l: '入力方法', t: 'seg', opts: [['count', '何回払い'], ['monthly', '月額で入力']], full: true },
      { k: 'total', l: '支払総額', t: 'yen' },
      { k: 'count', l: '支払回数', t: 'number', show: v => v.mode !== 'monthly' },
      { k: 'monthly', l: '毎月の支払額', t: 'yen', show: v => v.mode === 'monthly' },
      { k: 'startMonth', l: '初回の支払月', t: 'month' },
      { k: 'dueDay', l: '毎月の支払日', t: 'day' },
    ],
    analyze(it, c){
      const sc = instSchedule(it);
      const paid = sc.dates.filter(x => x.d < c.today);
      const rest = sc.dates.filter(x => x.d >= c.today);
      const restAmt = rest.reduce((a,x) => a + x.amt, 0);
      const mk = x => { const f = { orig: x.o, date: x.d, amount: x.amt, moved: +x.o !== +x.d }; f.note = moveNote(f); return f; };
      const flows = rest.filter(x => x.d <= c.deadline).map(mk);
      const fin = sc.dates.at(-1)?.d;
      const meta = !sc.count || !sc.per ? '総額と回数（または月額）を入力してください' : rest.length ? `あと${rest.length}回・残り${yen(restAmt)}・${fin ? D.ymj(fin) : ''}で完済` : '完済しました';
      return { flows, meta, head: sc.per, sub: `${sc.count}回払い（${paid.length}回済み）`, progress: sc.count ? paid.length / sc.count : 1, next: rest[0] ? mk(rest[0]) : null };
    }},
  save: { label: '積み立て', group: 'expense', tag: '積立', postpone: true, canSkip: true,
    fields: [
      { k: 'name', l: '目的', t: 'text', full: true, ph: '例：新しいオーディオインターフェース' },
      { k: 'goal', l: '目標金額', t: 'yen' },
      { k: 'current', l: '今たまっている額', t: 'yen' },
      { k: 'mode', l: '積み立て方', t: 'seg', opts: [['monthly', '毎月の額を決める'], ['date', '期限から逆算']], full: true },
      { k: 'monthly', l: '毎月の積立額', t: 'yen', show: v => v.mode !== 'date' },
      { k: 'targetDate', l: '達成したい日', t: 'date', show: v => v.mode === 'date' },
      { k: 'day', l: '毎月の積立日', t: 'day' },
    ],
    monthlyOf(it){
      const need = Math.max(0, num(it.goal) - num(it.current));
      if (it.mode === 'date'){
        const tg = D.parse(it.targetDate); if (!tg) return 0;
        const c = { today: D.today() };
        const n = occ(it, it.day || 25, c, tg).filter(o => !(it.doneMonths||[]).includes(D.ym(o.orig))).length || 1;
        return Math.ceil(need / n);
      }
      return num(it.monthly);
    },
    analyze(it, c){
      const need = Math.max(0, num(it.goal) - num(it.current));
      const per = TYPES.save.monthlyOf(it);
      const done = it.doneMonths || [];
      let left = need; const all = [];
      for (const o of occ(it, it.day || 25, c, FAR(c))){ if (left <= 0) break; if (done.includes(D.ym(o.orig))) continue; const a = Math.min(per, left); all.push({ ...o, amount: a, note: moveNote(o) }); left -= a; }
      const flows = all.filter(f => f.date <= c.deadline);
      const skipped = Object.values(it.moves || {}).filter(v => v === 'skip').length;
      let meta;
      if (need <= 0) meta = '目標達成';
      else if (per <= 0) meta = '積立額が未設定です';
      else { const fin = all.at(-1)?.date; meta = `あと${yen(need)}・毎月${yen(per)}で ${fin ? D.ymj(fin) : '—'}に達成`; }
      if (skipped) meta += `（${skipped}回スキップ）`;
      return { flows, meta, head: per, sub: `${yen(it.current)} / ${yen(it.goal)}`, progress: num(it.goal) ? Math.min(1, num(it.current) / num(it.goal)) : 0, canDeposit: need > 0 && per > 0 && !done.includes(D.ym(c.today)) && (it.moves || {})[D.ymd(D.on(c.today.getFullYear(), c.today.getMonth(), num(it.day || 25)))] !== 'skip', next: all[0] || null };
    }},
  job: { label: '単発バイト', group: 'income', tag: '単発',
    fields: [
      { k: 'name', l: '内容', t: 'text', full: true, ph: '例：演奏会エキストラ' },
      { k: 'amount', l: '受け取る金額', t: 'yen' },
      { k: 'date', l: '入金日', t: 'date' },
    ],
    analyze(it, c){
      const d = D.parse(it.date);
      const inWin = d && d >= c.today && d <= c.deadline;
      return { flows: inWin ? [{ date: d, amount: num(it.amount) }] : [], meta: !d ? '入金日未設定' : d < c.today ? '受取済み（残高に含めてください）' : inWin ? `${D.md(d)}（${D.wd(d)}）入金予定` : `${D.md(d)} 入金予定（期間外）`, head: num(it.amount) };
    }},
  allow: { label: 'お小遣い', group: 'income', tag: 'お小遣い',
    fields: [
      { k: 'name', l: 'もらう相手・内容', t: 'text', full: true, ph: '例：仕送り' },
      { k: 'amount', l: '金額', t: 'yen' },
      { k: 'mode', l: 'タイミング', t: 'seg', opts: [['monthly', '毎月'], ['once', '1回だけ']], full: true },
      { k: 'day', l: '毎月の日付', t: 'day', show: v => v.mode !== 'once' },
      { k: 'date', l: 'もらう日', t: 'date', show: v => v.mode === 'once' },
    ],
    analyze(it, c){
      if (it.mode === 'once'){ return TYPES.job.analyze(it, c); }
      const flows = monthlyDates(it.day, c.today, c.deadline).map(d => ({ date: d, amount: num(it.amount) }));
      return { flows, meta: `毎月${it.day || '?'}日`, head: num(it.amount) };
    }},
  wish: { label: '欲しいもの', group: 'expense', tag: '欲しい', postpone: true,
    fields: [
      { k: 'name', l: '欲しいもの', t: 'text', full: true, ph: '例：コンデンサーマイク' },
      { k: 'price', l: '値段', t: 'yen' },
      { k: 'priority', l: '優先度', t: 'seg', def: '1', opts: [['2', '高'], ['1', '中'], ['0', '低']] },
      { k: 'useDeadline', l: '購入期限', t: 'seg', opts: [['', 'なし'], ['1', 'いつまでに買う']] },
      { k: 'deadline', l: 'いつまでに購入', t: 'date', show: v => !!v.useDeadline, hint: '来月締め日までの期限なら、支出として計算に入ります' },
      { k: 'url', l: 'お店のURL（任意）', t: 'text', full: true, ph: 'https://' },
      { k: 'memo', l: 'メモ', t: 'text', full: true },
    ],
    analyze(it, c, R){
      const price = num(it.price);
      if (it.bought) return { flows: [], meta: `${it.boughtOn ? D.md(D.parse(it.boughtOn)) + ' に' : ''}購入済み`, head: price };
      const o = it.useDeadline ? D.parse(it.deadline) : null;
      const d = o ? (moved(it, o) || o) : null;
      const flows = []; let meta, next = null;
      if (d){
        const left = D.diff(c.today, d);
        const f = { orig: o, date: d < c.today ? c.today : d, amount: price, moved: +d !== +o };
        f.note = left < 0 ? '期限超過' : ['購入予定', moveNote(f)].filter(Boolean).join('・');
        next = f;
        if (d <= c.deadline){ flows.push(f); meta = left < 0 ? `期限を${-left}日過ぎています` : `${D.md(d)}（${D.wd(d)}）までに購入・計算に含めています`; }
        else { const months = Math.max(1, (d.getFullYear() - c.today.getFullYear()) * 12 + d.getMonth() - c.today.getMonth()); meta = `${D.md(d)}までに購入・毎月${yen(Math.ceil(price / months))}取り置けば間に合います`; }
        if (f.moved) meta += `（${D.md(o)}から延期）`;
      } else meta = '期限なし';
      return { flows, meta, head: price, warn: d && d < c.today, next };
    }},
};

// ---------- 集計 ----------
function compute(){
  const c = context();
  const s0 = salaryFor(c.cur.start, c.cur.end);
  const salary0 = S.settings.salaryManual != null && S.settings.salaryManual !== '' ? num(S.settings.salaryManual) : s0.total;
  const salaryPending = c.cur.payDate >= c.today;
  const earn = salaryFor(c.earnStart, c.deadline);

  const flows = [];
  if (salaryPending && salary0 > 0) flows.push({ date: c.cur.payDate, amount: salary0, dir: 'in', type: 'pay', name: '給与（シフトボード）', note: S.settings.salaryManual != null && S.settings.salaryManual !== '' ? '手入力' : `${s0.list.filter(x=>!x.dupOf).length}シフト分` });
  const analyses = {};
  for (const it of S.items){
    const T = TYPES[it.type]; if (!T) continue;
    const a = T.analyze(it, c); analyses[it.id] = a;
    for (const f of a.flows) flows.push({ ...f, dir: T.group === 'income' ? 'in' : 'out', type: it.type, name: it.name || T.label, id: it.id });
  }
  flows.sort((a,b) => a.date - b.date || (a.dir === 'in' ? -1 : 1));
  const inSum = flows.filter(f => f.dir === 'in').reduce((a,f) => a + f.amount, 0);
  const outSum = flows.filter(f => f.dir === 'out').reduce((a,f) => a + f.amount, 0);
  const have = num(S.settings.balance) + inSum;
  const need = Math.max(0, outSum - have);
  const shortfall = Math.max(0, need - earn.total);
  const freeNow = Math.max(0, have - outSum);
  const freeWithShift = Math.max(0, have + earn.total - outSum);
  const wage = num(S.settings.workplaces[0]?.wage) || num(S.settings.defaultWage) || 1;
  return { c, s0, salary0, salaryPending, earn, flows, analyses, inSum, outSum, have, need, shortfall, freeNow, freeWithShift, hours: shortfall / wage, wage };
}

// ---------- Google 連携 ----------
const G = { token: null, exp: 0, client: null, fileId: null, loadedDrive: false, pending: null };
function clientId(){ return (LS.get(LS_CID) || (window.SHIFT_CONFIG && window.SHIFT_CONFIG.clientId) || '').trim(); }
function gisReady(){ return !!(window.google && google.accounts && google.accounts.oauth2); }
function getToken(interactive){
  return new Promise((resolve, reject) => {
    if (G.token && Date.now() < G.exp - 60000) return resolve(G.token);
    const cid = clientId();
    if (!cid) return reject(new Error('no-client'));
    if (!gisReady()) return reject(new Error('gis-not-loaded'));
    G.client = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: SCOPES,
      callback: r => { if (r.error) return reject(new Error(r.error)); G.token = r.access_token; G.exp = Date.now() + (r.expires_in || 3600) * 1000; LS.set('shiftMoney.granted', '1'); resolve(G.token); },
      error_callback: e => reject(new Error(e.type || 'popup')),
    });
    G.client.requestAccessToken({ prompt: LS.get('shiftMoney.granted') ? '' : 'consent' });
  });
}
async function api(url, opts = {}){
  const t = await getToken(false);
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers||{}) } });
  if (res.status === 401){ G.token = null; throw new Error('auth'); }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0,200));
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}
async function driveFind(){
  const q = encodeURIComponent(`name='${DRIVE_FILE}' and trashed=false`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  return r.files && r.files[0] ? r.files[0].id : null;
}
async function driveLoad(){
  G.fileId = G.fileId || await driveFind();
  if (!G.fileId) return null;
  const txt = await api(`https://www.googleapis.com/drive/v3/files/${G.fileId}?alt=media`);
  return typeof txt === 'string' ? JSON.parse(txt) : txt;
}
async function driveSave(){
  setSync('busy', '保存中…');
  const body = JSON.stringify(S);
  if (!G.fileId) G.fileId = await driveFind();
  if (G.fileId){
    await api(`https://www.googleapis.com/upload/drive/v3/files/${G.fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  } else {
    const boundary = 'b' + uid();
    const meta = { name: DRIVE_FILE, mimeType: 'application/json', description: 'シフト家計簿のデータ' };
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
    G.fileId = r.id;
  }
  setSync('ok', 'Drive保存済み');
}
async function calendarsList(){
  const r = await api('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader');
  return (r.items || []).map(x => ({ id: x.id, name: x.summaryOverride || x.summary, primary: !!x.primary }));
}
async function fetchShifts(){
  const c = context();
  const from = D.addD(c.cur.start, -1), to = D.addD(c.deadline, 2);
  const ids = S.settings.calendarIds.length ? S.settings.calendarIds : ['primary'];
  const all = [];
  for (const id of ids){
    let pageToken = '';
    do {
      const p = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?${p}`);
      for (const e of r.items || []){
        if (!e.start || !e.start.dateTime || e.status === 'cancelled') continue;
        all.push({ id: e.id + '@' + id, title: e.summary || '', location: e.location || '', start: e.start.dateTime, end: e.end.dateTime, updated: e.updated || '', cal: id });
      }
      pageToken = r.nextPageToken || '';
    } while (pageToken);
  }
  return all;
}
function detectWorkplaces(shifts){
  // シフトボードの同期予定は「タイトル＝勤務先名」「場所＝勤務先名」になる
  const names = {};
  for (const s of shifts) if (s.title && s.location && s.title === s.location) names[s.title] = (names[s.title]||0) + 1;
  let added = 0;
  for (const [n, cnt] of Object.entries(names)){
    if (cnt < 2) continue;
    if (S.settings.workplaces.some(w => n.includes(w.keyword) || w.keyword.includes(n))) continue;
    S.settings.workplaces.push({ id: uid(), name: n, keyword: n, wage: num(S.settings.defaultWage), night: 25, transport: 0 });
    added++;
  }
  return added;
}

async function syncAll(interactive){
  if (G.pending) return G.pending;
  G.pending = (async () => {
    try {
      setSync('busy', '同期中…');
      await getToken(interactive);
      if (!G.loadedDrive){
        const remote = await driveLoad().catch(() => null);
        if (remote && (remote.savedAt || 0) > (S.savedAt || 0)) S = merge(remote);
        G.loadedDrive = true;
      }
      try { S.cache.calendars = await calendarsList(); } catch {}
      const raw = await fetchShifts();
      S.cache.shifts = dedupeShifts(raw);
      S.cache.syncedAt = Date.now();
      const added = detectWorkplaces(raw);
      commit({ noDrive: true });
      await driveSave();
      toast(added ? `同期しました（勤務先を${added}件自動登録。時給を設定してください）` : 'シフトと給与を最新にしました');
    } catch (e){
      const m = String(e.message || e);
      if (m === 'no-client') { setSync('', '未接続'); if (interactive){ toast('設定でGoogleのクライアントIDを入力してください'); go('settings'); } }
      else if (m === 'gis-not-loaded') { setSync('err', '読み込み失敗'); if (interactive) toast('Googleのログイン部品を読み込めませんでした。通信を確認してください'); }
      else if (/popup|access_denied|popup_closed|popup_failed/.test(m)) { setSync('', 'タップで同期'); if (interactive) toast('Googleのログインが完了しませんでした'); }
      else { setSync('err', '同期エラー'); toast('同期エラー: ' + m.slice(0, 80)); console.error(e); }
    } finally { G.pending = null; }
  })();
  return G.pending;
}
function needsDailySync(){ return !S.cache.syncedAt || !D.sameDay(new Date(S.cache.syncedAt), new Date()); }

// ---------- UI ヘルパー ----------
const $ = s => document.querySelector(s);
function setSync(state, text){ const el = $('#syncChip'); el.className = 'sync-chip ' + state; $('#syncText').textContent = text; }
let toastT; function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
let current = 'home';
function go(v){ current = v; document.querySelectorAll('.view').forEach(x => x.hidden = x.dataset.view !== v); document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === v)); window.scrollTo({ top: 0 }); render(); }

function render(){
  const R = compute();
  if (current === 'home') renderHome(R);
  if (current === 'income') renderIncome(R);
  if (current === 'expense') renderExpense(R);
  if (current === 'wish') renderWish(R);
  if (current === 'settings') renderSettings(R);
}

function alertsHtml(R){
  const out = []; const t = R.c.today;
  if (!clientId()) out.push(`<div class="alert info"><div><b>Google連携がまだです。</b>設定でクライアントIDを入れると、シフトボードのシフトから給与を毎日自動で読み込み、データをGoogle Driveに保存します。</div><div class="act"><button class="btn sm" data-go="settings">設定へ</button></div></div>`);
  else if (needsDailySync()) out.push(`<div class="alert info"><div><b>今日のシフトをまだ読み込んでいません。</b></div><div class="act"><button class="btn sm primary" data-sync>今すぐ更新</button></div></div>`);
  for (const it of S.items.filter(i => i.type === 'card')){
    it.amounts = it.amounts || {};
    const cands = [];
    const y = t.getFullYear(), m = t.getMonth();
    for (const k of [0, -1]){
      const cm = D.addM(y, m, k); const close = D.on(cm.y, cm.m, num(it.closeDay));
      const dm = cardDueMonthFor(it, cm.y, cm.m); const due = D.on(dm.y, dm.m, num(it.dueDay));
      if (close <= t && due >= t) cands.push({ close, due, key: `${dm.y}-${String(dm.m+1).padStart(2,'0')}` });
    }
    for (const cd of cands){
      if (it.amounts[cd.key] != null) continue;
      out.push(`<div class="alert"><div><b>${esc(it.name)}</b>の請求が確定しました（${D.md(cd.close)}確定・${D.md(cd.due)}引落）。確定額を入力してください。</div><div class="act"><input type="number" inputmode="numeric" placeholder="確定額" data-cardamt="${it.id}" data-key="${cd.key}"><button class="btn sm primary" data-cardsave="${it.id}" data-key="${cd.key}">保存</button></div></div>`);
    }
  }
  for (const it of S.items){
    const a = R.analyses[it.id]; if (!a) continue;
    if (it.type === 'lump' && a.warn) out.push(`<div class="alert bad"><div><b>${esc(it.name)}</b>：${esc(a.meta)}</div></div>`);
    if (it.type === 'revo' && a.warn) out.push(`<div class="alert bad"><div><b>${esc(it.name)}</b>：${esc(a.meta)}</div></div>`);
  }
  return out.join('');
}

function renderHome(R){
  const c = R.c;
  const covered = R.need > 0 ? Math.min(1, R.earn.total / R.need) : 1;
  const heroBig = R.need > 0
    ? `<div class="big num">${yen(R.need)}</div><div class="sub">支出 ${yen(R.outSum)} − 手元と入金予定 ${yen(R.have)}</div>`
    : `<div class="big num ok">¥0</div><div class="sub">今あるお金と入金予定で、来月締め日までの支払いをまかなえます</div>`;
  const shiftLine = R.need > 0
    ? (R.shortfall > 0
        ? `<div><div class="k">予定シフトを入れても不足</div><div class="v num">${yen(R.shortfall)}</div><div class="k">時給${yen(R.wage)}で あと約${Math.ceil(R.hours*2)/2}時間</div></div>`
        : `<div><div class="k">予定シフトで達成</div><div class="v num ok">達成見込み</div><div class="k">余り ${yen(R.earn.total - R.need)}</div></div>`)
    : `<div><div class="k">支払い後に残るお金</div><div class="v num ok">${yen(R.have - R.outSum)}</div><div class="k">シフト予定を除く</div></div>`;
  $('#view-home').innerHTML = `
    ${alertsHtml(R)}
    <div class="card hero">
      <div class="label">来月締め日（${D.md(c.deadline)}）までに稼がないといけない金額</div>
      ${heroBig}
      <div class="hero-split">
        <div><div class="k">予定シフトの稼ぎ見込み</div><div class="v num">${yen(R.earn.total)}</div><div class="k">${D.md(c.earnStart)}〜${D.md(c.deadline)}・${(R.earn.mins/60).toFixed(1)}時間</div></div>
        ${shiftLine}
      </div>
      ${R.need > 0 ? `<div class="meter" aria-label="必要額に対する予定シフトの割合"><i style="width:${covered*100}%;background:#9fe0bf"></i><i style="width:${(1-covered)*100}%;background:#e08a72"></i></div>` : ''}
    </div>
    <div class="kpis">
      <div class="kpi free"><div class="k">自由に使えるお金</div><div class="v num">${yen(R.freeWithShift)}</div><div class="faint">シフト予定を除くと ${yen(R.freeNow)}</div></div>
      <div class="kpi"><div class="k">今月末の給与（${D.md(c.cur.payDate)}）</div><div class="v num">${yen(R.salary0)}</div><div class="faint">${R.salaryPending ? '入金予定' : '受取済み'}・${S.settings.salaryManual != null && S.settings.salaryManual !== '' ? '手入力' : 'シフトから計算'}</div></div>
      <div class="kpi"><div class="k">入るお金（残高込み）</div><div class="v num">${yen(R.have)}</div><div class="faint">残高 ${yen(S.settings.balance)}</div></div>
      <div class="kpi need"><div class="k">出るお金</div><div class="v num">${yen(R.outSum)}</div><div class="faint">${D.md(c.today)}〜${D.md(c.deadline)}</div></div>
    </div>
    <h2 class="sec"><span>${D.md(c.today)}〜${D.md(c.deadline)} のお金の流れ</span></h2>
    <div class="card">
      ${R.flows.length ? `<div class="ledger">
        <div class="li"><span class="d">今</span><div class="n">手元の残高</div><span class="a num">${yen(S.settings.balance)}</span></div>
        ${R.flows.map(f => `<div class="li"><span class="d">${D.md(f.date)}</span><div class="n"><span class="tag ${f.type}">${esc(f.type === 'pay' ? '給与' : TYPES[f.type].tag)}</span>${esc(f.name)}${f.note ? `<div class="t">${esc(f.note)}</div>` : ''}</div>${f.dir === 'out' && f.id && TYPES[f.type].postpone ? `<button class="mini" data-postpone="${f.id}" data-orig="${D.ymd(f.orig || f.date)}" aria-label="延期">延期</button>` : ''}<span class="a num ${f.dir === 'in' ? 'plus' : 'minus'}">${f.dir === 'in' ? '+' : '−'}${yen(f.amount).replace('¥','¥')}</span></div>`).join('')}
        <div class="total"><span>差し引き</span><span class="num" style="color:${R.have - R.outSum < 0 ? 'var(--warn)' : 'var(--accent)'}">${yen(R.have - R.outSum)}</span></div>
      </div>` : `<div class="empty">まだ収入・支出がありません。「収入」「支出」タブから追加してください。<br><button class="btn sm" style="margin-top:10px" data-sample>サンプルデータで試す</button></div>`}
    </div>
    <details class="card"><summary>計算のしかた</summary>
      <ol class="steps">
        <li>期間は <b>今日（${D.md(c.today)}）〜来月の締め日（${D.md(c.deadline)}）</b> です。</li>
        <li><b>入るお金</b> ＝ 手元の残高 ＋ 今月の給料日（${D.md(c.cur.payDate)}）の給与 ＋ 期間内の単発バイト・お小遣い。</li>
        <li><b>出るお金</b> ＝ 期間内に期日が来る一括返済・リボ・カード・分割・積み立て。</li>
        <li><b>稼がないといけない金額</b> ＝ 出るお金 − 入るお金（マイナスなら0円）。</li>
        <li><b>予定シフトの稼ぎ</b> は ${D.md(c.earnStart)}〜${D.md(c.deadline)} のシフト（まだ給料として入っていない分）から計算します。実際の入金は次の給料日以降になる点に注意してください。</li>
        <li><b>自由に使えるお金</b> ＝ 入るお金 ＋ 予定シフトの稼ぎ − 出るお金。</li>
      </ol>
    </details>`;
}

function itemCard(it, a){
  const T = TYPES[it.type];
  const moves = Object.entries(it.moves || {}).filter(([k]) => D.parse(k) >= D.addD(D.today(), -40) || (it.moves[k] !== 'skip' && D.parse(it.moves[k]) >= D.today()));
  const acts = [];
  if (a.canDeposit) acts.push(`<span class="btn sm" role="button" data-deposit="${it.id}">今月分 ${yen(TYPES.save.monthlyOf(it))} を積み立てた</span>`);
  if (it.type === 'wish' && !it.bought) acts.push(`<span class="btn sm" role="button" data-buy="${it.id}">購入した</span>`);
  if (it.type === 'wish' && it.bought) acts.push(`<span class="btn sm ghost" role="button" data-unbuy="${it.id}">未購入に戻す</span>`);
  if (T.postpone && a.next && !(it.type === 'wish' && it.bought)) acts.push(`<span class="btn sm ghost" role="button" data-postpone="${it.id}" data-orig="${D.ymd(a.next.orig)}">${it.type === 'wish' ? '購入期限を延期' : it.type === 'lump' ? '返済期日を延期' : `${D.md(a.next.date)}の分を延期`}</span>`);
  if (it.url) acts.push(`<span class="btn sm ghost" role="button" data-url="${esc(it.url)}">お店を開く</span>`);
  const prio = it.type === 'wish' ? `<span class="prio p${it.priority ?? 1}">${['低','中','高'][Number(it.priority ?? 1)]}</span>` : '';
  return `<button class="item ${it.bought ? 'done' : ''}" data-edit="${it.id}">
    <div class="top"><span class="name">${prio}${esc(it.name || T.label)}</span><span class="amt">${yen(a.head)}</span></div>
    ${a.sub ? `<div class="meta">${esc(a.sub)}</div>` : ''}
    <div class="meta" ${a.warn ? 'style="color:var(--warn)"' : ''}>${esc(a.meta)}</div>
    ${a.badge || ''}
    ${a.progress != null ? `<div class="bar ${it.type === 'inst' ? 'warm' : ''}"><i style="width:${Math.round(a.progress*100)}%"></i></div>` : ''}
    ${it.type === 'card' ? cardHistory(it) : ''}
    ${moves.length ? `<div class="moves">${moves.map(([k,v]) => `<div class="mv">${v === 'skip' ? `${D.md(D.parse(k))}の分をスキップ中` : `${D.md(D.parse(k))} → ${D.md(D.parse(v))} に延期中`}<span class="link-btn" role="button" data-unmove="${it.id}" data-orig="${k}">元に戻す</span></div>`).join('')}</div>` : ''}
    ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
  </button>`;
}
function cardHistory(it){
  const ks = Object.keys(it.amounts || {}).sort().reverse().slice(0, 3);
  return ks.length ? `<div class="meta">確定額：${ks.map(k => `${Number(k.slice(5))}月 ${yen(it.amounts[k])}`).join(' / ')}</div>` : '';
}
function section(type, R, hint){
  const T = TYPES[type]; const list = S.items.filter(i => i.type === type);
  return `<h2 class="sec"><span>${T.label}</span><button class="btn sm add" data-add="${type}">＋ 追加</button></h2>
    ${hint ? `<div class="faint" style="margin:-4px 2px 0">${hint}</div>` : ''}
    <div class="items">${list.length ? list.map(it => itemCard(it, R.analyses[it.id])).join('') : `<div class="empty">まだありません</div>`}</div>`;
}

function renderIncome(R){
  const c = R.c; const s0 = R.s0;
  const manual = S.settings.salaryManual != null && S.settings.salaryManual !== '';
  const synced = S.cache.syncedAt ? new Date(S.cache.syncedAt) : null;
  $('#view-income').innerHTML = `
    <div class="card">
      <div class="row"><div><div class="faint">手元の残高（今あるお金）</div></div></div>
      <div class="row" style="margin-top:6px"><input type="number" inputmode="numeric" id="balanceInput" value="${num(S.settings.balance) || ''}" placeholder="例：25000"><button class="btn primary" id="balanceSave">更新</button></div>
      <div class="faint" style="margin-top:6px">銀行口座と財布の合計など。給料が入ったらここを更新してください。</div>
    </div>
    <h2 class="sec"><span>今月末の給与（シフトボード）</span><button class="btn sm" data-sync>↻ 更新</button></h2>
    <div class="card">
      <div class="row"><div><div class="faint">${D.md(c.cur.payDate)}（${D.wd(c.cur.payDate)}）支給・${D.md(c.cur.start)}〜${D.md(c.cur.end)} 勤務分</div><div class="num" style="font-size:28px;font-weight:700">${yen(R.salary0)}</div></div></div>
      <div class="faint">${manual ? `手入力の金額を使っています（シフトからの計算：${yen(s0.total)}）` : `シフト${s0.list.filter(x=>!x.dupOf).length}件・${(s0.mins/60).toFixed(1)}時間から計算`}${s0.dup ? `・重複${s0.dup}件を除外` : ''}・最終更新 ${synced ? `${D.md(synced)} ${String(synced.getHours()).padStart(2,'0')}:${String(synced.getMinutes()).padStart(2,'0')}` : 'まだ'}</div>
      <div class="row" style="margin-top:12px"><input type="number" inputmode="numeric" id="salaryManual" placeholder="シフトボードの金額で上書き（任意）" value="${manual ? num(S.settings.salaryManual) : ''}"><button class="btn" id="salaryManualSave">${manual ? '更新' : '上書き'}</button>${manual ? '<button class="btn ghost" id="salaryManualClear">自動に戻す</button>' : ''}</div>
      ${shiftTable(s0)}
    </div>
    <h2 class="sec"><span>来月締め日までの稼ぎ見込み</span></h2>
    <div class="card">
      <div class="faint">${D.md(c.earnStart)}〜${D.md(c.deadline)} のシフト（予定を含む）</div>
      <div class="num" style="font-size:24px;font-weight:700">${yen(R.earn.total)}</div>
      <div class="faint">${R.earn.list.filter(x=>!x.dupOf).length}件・${(R.earn.mins/60).toFixed(1)}時間${R.earn.dup ? `・重複${R.earn.dup}件を除外` : ''}</div>
      ${shiftTable(R.earn)}
    </div>
    ${section('job', R)}
    ${section('allow', R)}`;
}
function shiftTable(s){
  if (!s.list.length) return `<div class="empty" style="margin-top:12px">${S.cache.syncedAt ? 'この期間のシフトが見つかりません。設定でカレンダーと勤務先を確認してください。' : 'まだシフトを読み込んでいません。'}</div>`;
  return `<details style="margin-top:10px"><summary>シフトの内訳（${s.list.length}件）</summary><table class="shift-table">${s.list.map(x => {
    const st = new Date(x.start), en = new Date(x.end); const hm = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    return `<tr class="${x.dupOf ? 'dup' : ''}" title="${x.dupOf ? '重複のため除外（最後に更新された予定を採用）' : ''}"><td>${D.md(st)}(${D.wd(st)})</td><td>${hm(st)}–${hm(en)}</td><td>${esc(x.wp?.name || x.title)}</td><td class="r">${x.dupOf ? '重複' : yen(x.calc.pay)}</td></tr>`; }).join('')}</table></details>`;
}

function renderExpense(R){
  $('#view-expense').innerHTML = `
    ${section('lump', R, '友だち・家族への返済など、期日にまとめて払うもの')}
    ${section('revo', R, '残高と毎月の支払額・年利から完済時期を計算します')}
    ${section('card', R, '毎月の確定日になるとホームで金額の入力をお知らせします')}
    ${section('inst', R, '回数か月額を入れると、あと何回・いつ完済かを表示します')}
    ${section('save', R, '目標額と期限から毎月の必要額を出せます')}`;
}

function renderSettings(R){
  const st = S.settings; const cid = clientId();
  const cals = S.cache.calendars || [];
  const origin = location.origin && location.origin !== 'null' ? location.origin : '（公開先のURL）';
  $('#view-settings').innerHTML = `
    <h2 class="sec"><span>Google 連携</span></h2>
    <div class="card">
      <div class="field"><label for="cidInput">OAuth クライアント ID</label><input type="text" id="cidInput" value="${esc(cid)}" placeholder="xxxxxxxx.apps.googleusercontent.com"></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="connectBtn">${G.token ? '再同期' : 'Googleでログインして同期'}</button><span class="faint">${G.token ? '接続中' : '未接続'}</span></div>
      <details style="margin-top:10px"><summary>クライアントIDの作り方（最初の1回だけ・約5分）</summary>
        <ol class="steps">
          <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console</a> で新しいプロジェクトを作成</li>
          <li>「APIとサービス」→「ライブラリ」で <b>Google Drive API</b> と <b>Google Calendar API</b> を有効化</li>
          <li>「OAuth同意画面」を作成（外部・テストユーザーに自分のGmailを追加）</li>
          <li>「認証情報」→「OAuthクライアントID」→ 種類「ウェブアプリケーション」</li>
          <li>「承認済みのJavaScript生成元」に <code>${esc(origin)}</code> を追加</li>
          <li>表示されたクライアントIDを上の欄に貼り付け</li>
        </ol>
        <p class="faint">データは自分のGoogle Driveの「${DRIVE_FILE}」に保存されます。このアプリが作ったファイル以外は読みません。</p>
      </details>
    </div>
    <h2 class="sec"><span>シフトボードの読み込み</span></h2>
    <div class="card">
      <div class="faint">シフトボードアプリの「設定 → カレンダー同期」をオンにし、同期先をGoogleアカウントのカレンダーにしてください。同期された予定（タイトル＝勤務先名）を毎日読み込みます。</div>
      <div class="field" style="margin-top:10px"><label>読み込むカレンダー</label>
        <div class="cal-list">${cals.length ? cals.map(cl => `<label><input type="checkbox" data-cal="${esc(cl.id)}" ${st.calendarIds.includes(cl.id) || (!st.calendarIds.length && cl.primary) ? 'checked' : ''}> ${esc(cl.name)}${cl.primary ? '（メイン）' : ''}</label>`).join('') : '<span class="faint">Google連携後に一覧が表示されます（未選択時はメインのカレンダー）</span>'}</div>
      </div>
    </div>
    <h2 class="sec"><span>勤務先と時給</span><button class="btn sm add" id="wpAdd">＋ 追加</button></h2>
    <div class="card">
      ${st.workplaces.length ? st.workplaces.map(w => `<div class="wp" data-wp="${w.id}">
        <div class="field"><label>カレンダー上の名前（含む文字）</label><input type="text" data-wpk="keyword" value="${esc(w.keyword)}"></div>
        <div class="field"><label>時給</label><input type="number" inputmode="numeric" data-wpk="wage" value="${num(w.wage)}"></div>
        <div class="field"><label>交通費/日</label><input type="number" inputmode="numeric" data-wpk="transport" value="${num(w.transport)}"></div>
        <button class="btn ghost danger sm" data-wpdel="${w.id}" aria-label="削除">削除</button>
        <div class="field"><label>深夜割増（22〜5時, %）</label><input type="number" inputmode="numeric" data-wpk="night" value="${num(w.night ?? 25)}"></div>
      </div>`).join('') : '<div class="empty">最初の同期で、シフトボードの勤務先を自動で登録します</div>'}
    </div>
    <h2 class="sec"><span>給与のルール</span></h2>
    <div class="card fields" style="padding:16px">
      <div class="field"><label>締め日</label><select id="closingDay">${[['0','末日'], ...Array.from({length:28},(_,i)=>[String(i+1), `${i+1}日`])].map(([v,l]) => `<option value="${v}" ${String(st.closingDay)===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>給料日</label><div class="row"><select id="payOffset"><option value="1" ${st.payOffset==1?'selected':''}>翌月</option><option value="0" ${st.payOffset==0?'selected':''}>当月</option><option value="2" ${st.payOffset==2?'selected':''}>翌々月</option></select><select id="payDay">${Array.from({length:31},(_,i)=>`<option value="${i+1}" ${st.payDay==i+1?'selected':''}>${i+1===31?'末日':(i+1)+'日'}</option>`).join('')}</select></div></div>
      <div class="field"><label>休憩の自動控除</label><select id="breakRule"><option value="none" ${st.breakRule==='none'?'selected':''}>しない（シフト時間そのまま）</option><option value="auto" ${st.breakRule==='auto'?'selected':''}>6時間超45分・8時間超60分</option></select></div>
      <div class="field"><label>基本の時給（勤務先未設定時）</label><input type="number" id="defaultWage" value="${num(st.defaultWage)}"></div>
      <div class="field full faint">例：「末日締め・翌月25日払い」なら 締め日＝末日、給料日＝翌月25日。今月の給料日 ${D.md(R.c.cur.payDate)} は ${D.md(R.c.cur.start)}〜${D.md(R.c.cur.end)} の勤務分です。</div>
    </div>
    <h2 class="sec"><span>データ</span></h2>
    <div class="card row" style="flex-wrap:wrap">
      <button class="btn" id="exportBtn">JSONで書き出す</button>
      <label class="btn" for="importFile">JSONを読み込む</label><input type="file" id="importFile" accept="application/json" hidden>
      <button class="btn" data-sample>サンプルを入れる</button>
      <button class="btn ghost danger" id="resetBtn">すべて消去</button>
    </div>`;
}

function renderWish(R){
  const c = R.c;
  const list = S.items.filter(i => i.type === 'wish');
  const open = list.filter(i => !i.bought).sort((a,b) => Number(b.priority ?? 1) - Number(a.priority ?? 1) || ((a.useDeadline && a.deadline) || '9999').localeCompare((b.useDeadline && b.deadline) || '9999'));
  const bought = list.filter(i => i.bought);
  const total = open.reduce((s,i) => s + num(i.price), 0);
  const counted = R.flows.filter(f => f.type === 'wish').reduce((s,f) => s + f.amount, 0);
  let room = R.freeWithShift;
  const cards = open.map(it => {
    const a = { ...R.analyses[it.id] };
    const inWin = a.flows.length > 0;
    if (inWin) a.badge = `<span class="badge in">来月締め日までの支出に入っています</span>`;
    else if (num(it.price) <= room){ a.badge = `<span class="badge ok">今の余裕で買えます</span>`; room -= num(it.price); }
    else a.badge = `<span class="badge no">あと ${yen(num(it.price) - room)} 足りません</span>`;
    return itemCard(it, a);
  });
  $('#view-wish').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="k">欲しいものの合計</div><div class="v num">${yen(total)}</div><div class="faint">${open.length}件（未購入）</div></div>
      <div class="kpi free"><div class="k">自由に使えるお金</div><div class="v num">${yen(R.freeWithShift)}</div><div class="faint">期限内の ${yen(counted)} は計算済み</div></div>
    </div>
    <h2 class="sec"><span>欲しいものリスト</span><button class="btn sm add" data-add="wish">＋ 追加</button></h2>
    <div class="faint" style="margin:-4px 2px 0">「いつまでに購入」を${D.md(c.deadline)}（来月締め日）までにすると、支出として計算に入ります。優先度の高い順に「買えるか」を判定します。</div>
    <div class="items">${cards.length ? cards.join('') : '<div class="empty">まだありません</div>'}</div>
    ${bought.length ? `<details class="card"><summary>購入済み（${bought.length}件）</summary><div class="items" style="margin-top:10px">${bought.map(it => itemCard(it, R.analyses[it.id])).join('')}</div></details>` : ''}`;
}

// ---------- 確認ダイアログ ----------
function ask({ title, body, ok = 'OK', danger = false, onInput }){
  return new Promise(resolve => {
    const dlg = $('#confirmDlg');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').innerHTML = body;
    const okb = $('#confirmOk'); okb.textContent = ok; okb.className = 'btn primary' + (danger ? ' danger' : '');
    if (onInput){ $('#confirmBody').oninput = $('#confirmBody').onchange = onInput; $('#confirmBody').onclick = e => { const b = e.target.closest('[data-pseg]'); if (b){ $('#confirmBody').querySelectorAll('[data-pseg]').forEach(x => x.classList.toggle('on', x === b)); onInput(); } }; onInput(); }
    else { $('#confirmBody').oninput = $('#confirmBody').onchange = $('#confirmBody').onclick = null; }
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? $('#confirmBody') : null);
    dlg.returnValue = ''; dlg.showModal();
  });
}
const POSTPONE_NOTE = {
  lump: '返す相手に、延期することを先に連絡しておきましょう。',
  revo: '引き落とし日を自分で変えることはできません。カード会社に相談済みか、口座への入金を遅らせる場合は延滞（遅延損害金・信用情報への影響）になる点に注意してください。',
  card: '引き落としを自分で遅らせると延滞になります。カード会社への相談（支払い方法の変更など）が済んでいるときに使ってください。',
  inst: '分割払いの延期は、お店・カード会社の了承が必要です。延滞にならないよう確認してください。',
  save: '延期・スキップした分は、目標に間に合うよう後の積立額に上乗せされます（期限から逆算の場合）。',
  wish: '',
};
async function askPostpone(id, origYmd){
  const it = S.items.find(i => i.id === id); if (!it) return;
  const T = TYPES[it.type]; const c = context();
  const a = T.analyze(it, c);
  const flow = [...a.flows, a.next].filter(Boolean).find(f => D.ymd(f.orig) === origYmd) || a.next;
  if (!flow) return;
  const curDate = flow.date;
  const def = D.on(curDate.getFullYear(), curDate.getMonth() + 1, curDate.getDate());
  const word = it.type === 'save' ? '積み立て' : it.type === 'wish' ? '購入' : '支払い';
  const before = compute();
  const body = `
    <div><b>${esc(it.name)}</b> の <b>${D.md(curDate)}（${D.wd(curDate)}）</b> の${word} <b class="num">${yen(flow.amount)}</b> を延期します。</div>
    ${T.canSkip ? `<div class="seg" role="group"><button type="button" class="on" data-pseg="move">別の日に延期</button><button type="button" data-pseg="skip">今回はスキップ</button></div>` : ''}
    <div class="field" id="pdField"><label for="pdDate">延期先の日付</label><input type="date" id="pdDate" value="${D.ymd(def)}" min="${D.ymd(D.addD(curDate, 1))}"></div>
    <div class="impact" id="pdImpact"></div>
    ${POSTPONE_NOTE[it.type] ? `<div class="caution">${POSTPONE_NOTE[it.type]}</div>` : ''}`;
  const target = () => {
    const skip = $('#confirmBody').querySelector('[data-pseg="skip"]')?.classList.contains('on');
    return skip ? 'skip' : $('#pdDate').value;
  };
  const withMove = (v, fn) => { const prev = { ...(it.moves || {}) }; it.moves = { ...prev, [origYmd]: v }; try { return fn(); } finally { it.moves = prev; } };
  const onInput = () => {
    const v = target(); $('#pdField').hidden = v === 'skip';
    if (!v){ $('#pdImpact').textContent = '日付を選んでください'; return; }
    const after = withMove(v, () => compute());
    const lines = [`来月締め日までに稼ぐ額：<b>${yen(before.need)}</b> → <b>${yen(after.need)}</b>`, `自由に使えるお金：<b>${yen(before.freeWithShift)}</b> → <b>${yen(after.freeWithShift)}</b>`];
    if (it.type === 'save' && it.mode === 'date'){ const p0 = TYPES.save.monthlyOf(it), p1 = withMove(v, () => TYPES.save.monthlyOf(it)); if (p0 !== p1) lines.push(`毎月の積立額：<b>${yen(p0)}</b> → <b>${yen(p1)}</b>`); }
    if (it.type === 'revo') lines.push('延期した期間も利息はかかります');
    $('#pdImpact').innerHTML = lines.join('<br>');
  };
  const res = await ask({ title: `${word}の延期`, body, ok: '延期する', onInput });
  if (!res) return;
  const v = target(); if (!v) return toast('日付を選んでください');
  if (v !== 'skip' && D.parse(v) <= curDate) return toast('今の予定日より後の日付を選んでください');
  it.moves = { ...(it.moves || {}) };
  if (v === origYmd) delete it.moves[origYmd]; else it.moves[origYmd] = v;
  commit(); toast(v === 'skip' ? `${D.md(curDate)}の${word}をスキップしました` : `${D.md(D.parse(v))}に延期しました`);
}
async function askUnmove(id, k){
  const it = S.items.find(i => i.id === id); const v = it.moves[k];
  const ok = await ask({ title: '延期の取り消し', body: `<div><b>${esc(it.name)}</b> の${v === 'skip' ? `${D.md(D.parse(k))}のスキップ` : `延期（${D.md(D.parse(k))} → ${D.md(D.parse(v))}）`}を取り消して、元の日付に戻しますか？</div>`, ok: '元に戻す' });
  if (!ok) return; delete it.moves[k]; commit(); toast('元の日付に戻しました');
}
async function askBuy(id){
  const it = S.items.find(i => i.id === id);
  const res = await ask({ title: '購入済みにする', body: `<div><b>${esc(it.name)}</b>（<b class="num">${yen(it.price)}</b>）を購入済みにします。</div>
    <div class="field"><label for="buyPrice">実際に払った金額</label><input type="number" inputmode="numeric" id="buyPrice" value="${num(it.price)}"></div>
    <label class="chk"><input type="checkbox" id="buyDeduct" checked> 手元の残高（${yen(S.settings.balance)}）から差し引く</label>`, ok: '購入済みにする' });
  if (!res) return;
  const paid = num(res.querySelector('#buyPrice').value);
  it.bought = true; it.boughtOn = D.ymd(D.today()); it.paidPrice = paid;
  if (res.querySelector('#buyDeduct').checked){ S.settings.balance = num(S.settings.balance) - paid; it.deducted = paid; }
  commit(); toast('購入済みにしました');
}
async function askUnbuy(id){
  const it = S.items.find(i => i.id === id);
  const ok = await ask({ title: '未購入に戻す', body: `<div><b>${esc(it.name)}</b> を未購入に戻しますか？${it.deducted ? `<br>差し引いた ${yen(it.deducted)} は残高に戻します。` : ''}</div>`, ok: '未購入に戻す' });
  if (!ok) return;
  if (it.deducted) S.settings.balance = num(S.settings.balance) + num(it.deducted);
  delete it.bought; delete it.boughtOn; delete it.deducted; delete it.paidPrice; commit();
}

// ---------- 編集ダイアログ ----------
let editing = null;
function openEditor(type, id){
  const T = TYPES[type];
  const it = id ? S.items.find(i => i.id === id) : { id: uid(), type, ...Object.fromEntries(T.fields.filter(f => f.t === 'seg').map(f => [f.k, f.def ?? f.opts[0][0]])) };
  editing = { type, id, vals: { ...it } };
  $('#editorTitle').textContent = (id ? '編集：' : '追加：') + T.label;
  $('#editorDelete').hidden = !id;
  drawFields();
  $('#editor').showModal();
}
function drawFields(){
  const T = TYPES[editing.type]; const v = editing.vals;
  $('#editorFields').innerHTML = T.fields.filter(f => !f.show || f.show(v)).map(f => {
    const val = v[f.k] ?? '';
    let input;
    if (f.t === 'seg') input = `<div class="seg" role="group">${f.opts.map(([o,l]) => `<button type="button" class="${String(v[f.k] ?? f.def ?? f.opts[0][0])===o?'on':''}" data-seg="${f.k}" data-val="${o}">${l}</button>`).join('')}</div>`;
    else if (f.t === 'select') input = `<select name="${f.k}">${f.opts.map(([o,l]) => `<option value="${o}" ${String(val)===o?'selected':''}>${l}</option>`).join('')}</select>`;
    else if (f.t === 'day') input = `<select name="${f.k}"><option value="">—</option>${Array.from({length:31},(_,i)=>`<option value="${i+1}" ${String(val)===String(i+1)?'selected':''}>${i+1===31?'末日':(i+1)+'日'}</option>`).join('')}</select>`;
    else { const type = f.t === 'yen' || f.t === 'number' ? 'number' : f.t; input = `<input name="${f.k}" type="${type}" ${type==='number'?'inputmode="decimal"':''} ${f.step?`step="${f.step}"`:''} value="${esc(val)}" placeholder="${esc(f.ph || (f.t==='yen'?'¥':''))}">`; }
    return `<div class="field ${f.full ? 'full' : ''}"><label>${f.l}</label>${input}${f.hint ? `<span class="hint">${f.hint}</span>` : ''}</div>`;
  }).join('');
  preview();
}
function readFields(){
  const T = TYPES[editing.type];
  $('#editorFields').querySelectorAll('[name]').forEach(el => {
    const f = T.fields.find(x => x.k === el.name);
    editing.vals[el.name] = (f.t === 'yen' || f.t === 'number') ? (el.value === '' ? '' : num(el.value)) : el.value;
  });
}
function preview(){
  try { readFields(); const a = TYPES[editing.type].analyze({ ...editing.vals }, context()); $('#editorPreview').textContent = a.meta || ''; } catch { $('#editorPreview').textContent = ''; }
}

// ---------- サンプル ----------
function sample(){
  const t = D.today(); const y = t.getFullYear(), m = t.getMonth();
  const ym = k => { const x = D.addM(y, m, k); return `${x.y}-${String(x.m+1).padStart(2,'0')}`; };
  S.settings.balance = S.settings.balance || 18000;
  S.items.push(
    { id: uid(), type: 'job', name: '演奏会エキストラ', amount: 8000, date: D.ymd(D.addD(t, 9)) },
    { id: uid(), type: 'allow', name: '仕送り', amount: 20000, mode: 'monthly', day: 1 },
    { id: uid(), type: 'lump', name: '友だちに借りた分', amount: 5000, dueDate: D.ymd(D.addD(t, 14)) },
    { id: uid(), type: 'revo', name: 'カードのリボ', balance: 86000, monthly: 10000, rate: 15, dueDay: 27 },
    { id: uid(), type: 'card', name: 'メインカード', closeDay: 15, dueDay: 10, estimate: 22000, amounts: {} },
    { id: uid(), type: 'inst', name: 'オーディオインターフェース', mode: 'count', total: 36000, count: 12, startMonth: ym(-4), dueDay: 27 },
    { id: uid(), type: 'wish', name: 'コンデンサーマイク', price: 15000, priority: '2', useDeadline: '1', deadline: D.ymd(D.addD(t, 20)) },
    { id: uid(), type: 'wish', name: 'スコア（プロコフィエフ ソナタ集）', price: 4800, priority: '1' },
    { id: uid(), type: 'wish', name: 'ワイヤレスイヤホン', price: 24000, priority: '0', useDeadline: '1', deadline: D.ymd(D.on(y, m + 3, 1)) },
    { id: uid(), type: 'save', name: '新しいマイク', goal: 60000, current: 12000, mode: 'date', targetDate: D.ymd(D.on(y, m + 5, 25)), day: 25, doneMonths: [] },
  );
  commit(); toast('サンプルを追加しました。不要なら各項目から削除できます');
}

// ---------- イベント ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-deposit], [data-postpone], [data-unmove], [data-buy], [data-unbuy], [data-url], button, [data-go], label');
  if (!t) return;
  if (t.dataset.tab) return go(t.dataset.tab);
  if (t.dataset.go) return go(t.dataset.go);
  if (t.hasAttribute('data-sync') || t.id === 'syncChip') return syncAll(true);
  if (t.hasAttribute('data-sample')) return sample();
  if (t.dataset.deposit){ e.stopPropagation(); const it = S.items.find(i => i.id === t.dataset.deposit); const per = TYPES.save.monthlyOf(it); it.current = num(it.current) + per; it.doneMonths = [...(it.doneMonths||[]), D.ym(D.today())]; commit(); return toast(`${yen(per)} を積み立てました`); }
  if (t.dataset.postpone){ e.stopPropagation(); e.preventDefault(); return askPostpone(t.dataset.postpone, t.dataset.orig); }
  if (t.dataset.unmove){ e.stopPropagation(); e.preventDefault(); return askUnmove(t.dataset.unmove, t.dataset.orig); }
  if (t.dataset.buy){ e.stopPropagation(); e.preventDefault(); return askBuy(t.dataset.buy); }
  if (t.dataset.unbuy){ e.stopPropagation(); e.preventDefault(); return askUnbuy(t.dataset.unbuy); }
  if (t.dataset.url){ e.stopPropagation(); e.preventDefault(); if (/^https?:\/\//.test(t.dataset.url)) window.open(t.dataset.url, '_blank', 'noopener'); return; }
  if (t.closest('#confirmBody')) return;
  if (t.dataset.add) return openEditor(t.dataset.add);
  if (t.dataset.edit){ const it = S.items.find(i => i.id === t.dataset.edit); return openEditor(it.type, it.id); }
  if (t.dataset.cardsave){ const inp = document.querySelector(`[data-cardamt="${t.dataset.cardsave}"][data-key="${t.dataset.key}"]`); if (inp.value === '') return toast('金額を入力してください'); const it = S.items.find(i => i.id === t.dataset.cardsave); it.amounts = { ...(it.amounts||{}), [t.dataset.key]: num(inp.value) }; commit(); return toast('確定額を保存しました'); }
  if (t.dataset.seg){ readFields(); editing.vals[t.dataset.seg] = t.dataset.val; return drawFields(); }
  if (t.id === 'balanceSave'){ S.settings.balance = num($('#balanceInput').value); commit(); return toast('残高を更新しました'); }
  if (t.id === 'salaryManualSave'){ const v = $('#salaryManual').value; S.settings.salaryManual = v === '' ? null : num(v); commit(); return toast(v === '' ? '自動計算に戻しました' : '給与を上書きしました'); }
  if (t.id === 'salaryManualClear'){ S.settings.salaryManual = null; commit(); return toast('自動計算に戻しました'); }
  if (t.id === 'connectBtn'){ const v = $('#cidInput').value.trim(); if (v) LS.set(LS_CID, v); if (!v && !clientId()) return toast('クライアントIDを入力してください'); G.token = null; return syncAll(true); }
  if (t.id === 'wpAdd'){ S.settings.workplaces.push({ id: uid(), name: '', keyword: '', wage: num(S.settings.defaultWage), night: 25, transport: 0 }); return commit(); }
  if (t.dataset.wpdel){ S.settings.workplaces = S.settings.workplaces.filter(w => w.id !== t.dataset.wpdel); return commit(); }
  if (t.id === 'exportBtn'){ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' })); a.download = DRIVE_FILE; a.click(); return; }
  if (t.id === 'resetBtn'){ ask({ title: 'すべて消去', body: '<div>すべてのデータを消去しますか？Google Driveのファイルも空になります。先に「JSONで書き出す」で控えを取っておくと安心です。</div>', ok: '消去する', danger: true }).then(ok => { if (ok){ S = blank(); commit(); toast('消去しました'); } }); return; }
  if (t.id === 'editorDelete'){ const id = editing.id, nm = editing.vals.name; $('#editor').close(); ask({ title: '削除の確認', body: `<div><b>${esc(nm)}</b> を削除しますか？</div>`, ok: '削除する', danger: true }).then(ok => { if (ok){ S.items = S.items.filter(i => i.id !== id); commit(); toast('削除しました'); } }); return; }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.cal !== undefined){ const ids = [...document.querySelectorAll('[data-cal]')].filter(x => x.checked).map(x => x.dataset.cal); S.settings.calendarIds = ids; commit(); return; }
  if (el.dataset.wpk){ const id = el.closest('[data-wp]').dataset.wp; const w = S.settings.workplaces.find(x => x.id === id); const k = el.dataset.wpk; w[k] = k === 'keyword' ? el.value : num(el.value); if (k === 'keyword') w.name = el.value; commit(); return; }
  if (['closingDay','payDay','payOffset','defaultWage'].includes(el.id)){ S.settings[el.id] = num(el.value); commit(); return; }
  if (el.id === 'breakRule'){ S.settings.breakRule = el.value; commit(); return; }
  if (el.id === 'importFile' && el.files[0]){ el.files[0].text().then(txt => { S = merge(JSON.parse(txt)); commit(); toast('読み込みました'); }).catch(() => toast('読み込めませんでした')); }
  if (el.closest('#editorFields')) preview();
});
document.addEventListener('input', e => { if (e.target.closest('#editorFields')) preview(); });
$('#editorForm').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value === 'save'){
    readFields();
    const v = editing.vals;
    if (!v.name){ e.preventDefault(); return toast('名前を入力してください'); }
    const i = S.items.findIndex(x => x.id === v.id);
    if (i >= 0) S.items[i] = v; else S.items.push(v);
    commit(); toast('保存しました');
  }
});

// ---------- 起動と毎日の自動更新 ----------
function autoSync(){
  if (!clientId() || !needsDailySync()) return;
  if (G.token || LS.get('shiftMoney.granted')) syncAll(false);
}
function boot(){
  setSync(S.cache.syncedAt ? 'ok' : '', S.cache.syncedAt ? (needsDailySync() ? 'タップで更新' : '今日更新済み') : (clientId() ? 'タップで同期' : '未接続'));
  render();
  const wait = setInterval(() => { if (gisReady()){ clearInterval(wait); autoSync(); } }, 400);
  setTimeout(() => clearInterval(wait), 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden){ render(); autoSync(); } });
  setInterval(() => { render(); autoSync(); }, 60 * 60 * 1000);
}
window.__shift = { S: () => S, compute, dedupeShifts, setShifts(x){ S.cache.shifts = dedupeShifts(x); S.cache.syncedAt = Date.now(); detectWorkplaces(x); commit({ noDrive: true }); } };
boot();
})();
