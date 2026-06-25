// ダッシュボードのクライアント（ADR 0008「フロントエンド・パネル構成」）。
// "Eris Agent Mesh" デザインモックの見た目を、coordinator が書き出す run ログを tail した
// SSE（/events）の実データへ配線する。EventSource は切断時に自動再接続し、サーバは接続ごとに
// snapshot を送るので状態は復元される。
//
// 実データに無い架空項目はモックから読み替える:
//   SETTLED VOLUME → PRICE SPREAD（pool−fair = 裁定機会）
//   NETWORK TPS    → TX RATE（提出 tx/秒のローリング）
//   win rate/trades 等 → tx 採用/採択（included / submitted / reverted / adopt）

import { Mesh, rgbForPnl } from "./mesh.js";

const el = (id) => document.getElementById(id);

// ============================ state ============================
const S = {
  run: null,
  latestBlock: 0,
  poller: null,
  totals: { txCount: 0, revertCount: 0 },
  connected: false,
  agents: new Map(), // id -> {id,address,kind,base,index,color,baseline}
  order: [], // mesh 円環の並び（登録順）
  ranking: [], // [{id, valueUsdc, pnlUsdc, rank}]
  fairPrice: 0,
  poolPrice: null,
  activity: new Map(), // id -> activity
  agentRecent: new Map(), // id -> recent tx/action rows
  history: new Map(), // id -> number[]（detail スパークライン用）
  blocks: [], // {blockNumber, timingMs, ts}
  feed: [], // 直近 tx（detail の recent 抽出用）
  blockTx: new Map(), // blockNumber -> {submitted, mined}
  selectedId: null,
  lastBlockTs: 0,
  txTimes: [], // tps 計算用の到着時刻
  tpsHist: [],
  tps: 0,
  mempool: 0,
  scenario: null, // 市場ストレスシナリオ {name, runStartBlock, events:[{type,startBlock,endBlock,magnitude}]}
};

function rememberAgentRecent(row) {
  const id = row.ownerId;
  if (!id) return;
  const xs = S.agentRecent.get(id) ?? [];
  const key = row.hash
    ? `h:${row.hash}`
    : `${row.ts}|${row.phase}|${row.status}|${row.actionType}|${row.priorityFeeWei}`;
  if (!xs.some((x) => x._key === key)) {
    xs.unshift({ ...row, _key: key });
    if (xs.length > 20) xs.length = 20;
    S.agentRecent.set(id, xs);
  }
}

// stress シナリオが今のブロックで注入中か（窓内か）。ADR 0009。
function isScenarioActive() {
  const sc = S.scenario;
  if (!sc || !sc.events?.length || !S.latestBlock) return false;
  return sc.events.some((e) => {
    const a = sc.runStartBlock + e.startBlock;
    const b = sc.runStartBlock + e.endBlock;
    return S.latestBlock >= a && S.latestBlock < b;
  });
}
// crash を含むシナリオは amber、それ以外（spike のみ等）は cyan。
function scenarioColor() {
  const types = (S.scenario?.events ?? []).map((e) => e.type);
  return types.includes("crash") ? "#ffcf6b" : "#5cc6ff";
}

// ============================ tx カテゴリ（particle / badge 色）============================
const TYPE_RGB = {
  ARB: "92,198,255",
  BUY: "79,224,168",
  SELL: "255,107,122",
  LIQ: "255,207,107",
  LP: "176,140,255",
};
const TYPE_HEX = {
  ARB: "#5cc6ff",
  BUY: "#4fe0a8",
  SELL: "#ff6b7a",
  LIQ: "#ffcf6b",
  LP: "#b08cff",
};
function classifyAction(actionType) {
  const a = (actionType || "").toLowerCase();
  if (/liquidat|liq/.test(a)) return "LIQ";
  if (/\blp\b|liquidity|range|rebalanc|provide/.test(a)) return "LP";
  if (/sell|short|withdraw|redeem|repay|close|exit|remove|burn/.test(a))
    return "SELL";
  if (/buy|long|deposit|supply|borrow|open|mint|add/.test(a)) return "BUY";
  return "ARB"; // arb / swap / route / 既定
}
function isRevert(status) {
  const s = (status || "").toLowerCase();
  return s === "reverted" || s === "failure" || s === "failed" || s === "0x0";
}

// kind タグ（自己改善 / 固定 / baseline の識別。labels.ts の色帯と対応）
const KIND_TAG = {
  si: { label: "SI", bg: "#7aa2ff" },
  frozen: { label: "FRZ", bg: "#ffb86b" },
  baseline: { label: "BASE", bg: "#9aa6b3" },
};

// ============================ formatters ============================
function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}
function fmtUsd(n) {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${Math.round(a)}`;
}
function fmtPnlPct(pnl, start) {
  const p = start > 0 ? (pnl / start) * 100 : 0;
  return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
}
function fmtGwei(wei) {
  const g = Number(wei) / 1e9;
  if (!isFinite(g)) return "0";
  return g >= 100 ? g.toFixed(0) : g.toFixed(1);
}
function timeOfDay(ts) {
  const d = new Date(ts);
  return (
    d.toTimeString().slice(0, 8) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}
function agoStr(ts, now) {
  const s = Math.round((now - ts) / 1000);
  return s <= 0 ? "now" : `${s}s`;
}
function startOf(row) {
  return row.valueUsdc - row.pnlUsdc;
}
// hist → SVG polyline points（モック spark() の移植）
function spark(hist, wd, ht) {
  if (!hist || hist.length < 2) return "";
  const min = Math.min.apply(null, hist);
  const max = Math.max.apply(null, hist);
  const rng = max - min || 1;
  const n = hist.length;
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * wd;
    const y = ht - 2 - ((hist[i] - min) / rng) * (ht - 4);
    out += (i ? " " : "") + x.toFixed(1) + "," + y.toFixed(1);
  }
  return out;
}

// ============================ mesh ============================
const mesh = new Mesh(el("mesh-canvas"));
mesh.onSelect = (id) => selectAgent(id);
mesh.start();

// ============================ header ============================
function renderHeader() {
  el("stat-block").textContent = fmtInt(S.latestBlock || 0);
  el("stat-agents").textContent = String(S.agents.size);
  el("stat-tps").textContent = S.tps.toFixed(1);
  el("tps-spark").setAttribute("points", spark(S.tpsHist, 120, 26));

  if (S.poolPrice == null) {
    el("stat-spread").textContent = "—";
  } else {
    const sp = S.poolPrice - S.fairPrice;
    el("stat-spread").textContent = (sp >= 0 ? "+" : "") + sp.toFixed(2);
  }

  // live pill: SSE 接続状態 + run の協定（protocols / runId）。RPC degrade も注記。
  const ld = el("live-dot");
  const ll = el("live-label");
  if (S.connected) {
    ll.textContent = "LIVE";
    ld.style.background = "#4fe0a8";
    ld.style.boxShadow = "0 0 8px #4fe0a8";
  } else {
    ll.textContent = "OFFLINE";
    ld.style.background = "#565c68";
    ld.style.boxShadow = "none";
  }
  const protos = S.run?.enabledProtocols ?? [];
  let sub = protos.length
    ? protos.join(" · ")
    : S.run?.runId
      ? S.run.runId.slice(0, 19)
      : "—";
  if (S.poller?.degraded) sub += " · RPC tail-only";
  el("live-sub").textContent = sub;

  // 右上チップ: stress シナリオがあれば SCENARIO + 名前、無ければ run フェーズ（ADR 0009）。
  const dot = el("scenario-dot");
  const nm = el("scenario-name");
  const kEl = el("scenario-k");
  const active = isScenarioActive();
  if (S.scenario) {
    const accent = scenarioColor();
    const color = active ? accent : "#565c68"; // 窓外は dim
    kEl.textContent = "SCENARIO";
    nm.textContent = S.scenario.name + (active ? " · injected" : "");
    dot.style.background = color;
    dot.style.boxShadow = active ? `0 0 9px ${color}` : "none";
  } else {
    let color = "#565c68";
    let label = "idle";
    if (S.run?.finalized) {
      color = "#b08cff";
      label = "finalized";
    } else if (S.run?.phase === "completed") {
      color = "#5cc6ff";
      label = "completed";
    } else if (S.run?.phase === "started") {
      color = "#4fe0a8";
      label = "live";
    }
    kEl.textContent = "PHASE";
    dot.style.background = color;
    dot.style.boxShadow = `0 0 9px ${color}`;
    nm.textContent = label;
  }

  // 中央バナー: 注入中は "SCENARIO INJECTED <name>"（amber）、確定後は FINALIZED（violet）。
  const banner = el("banner");
  if (active) {
    el("banner-k").textContent = "SCENARIO INJECTED";
    el("banner-v").textContent = S.scenario.name;
    banner.classList.add("injected", "show");
  } else if (S.run?.finalized) {
    el("banner-k").textContent = "FINALIZED";
    el("banner-v").textContent = "reconstruct";
    banner.classList.remove("injected");
    banner.classList.add("show");
  } else {
    banner.classList.remove("show", "injected");
  }

  const rate = S.run?.blockTimeSec
    ? `≈${S.run.blockTimeSec}s / block`
    : S.run?.runBlocks
      ? `${S.run.processedBlocks || 0} / ${S.run.runBlocks} blk`
      : "—";
  el("blocks-rate").textContent = rate;

  const proto = protos.length ? ` · ${protos.join(" / ")}` : "";
  el("mesh-label").textContent = `AGENT MESH · ${S.agents.size} NODES${proto}`;
}

// ============================ standings ============================
const standEl = el("standings");
const standRows = new Map(); // id -> row element

function ensureStandRow(id) {
  let row = standRows.get(id);
  if (row) return row;
  const info = S.agents.get(id);
  const tag = KIND_TAG[info?.kind ?? "frozen"] ?? KIND_TAG.frozen;
  const handle = info?.address
    ? `${info.address.slice(0, 6)}…${info.address.slice(-4)}`
    : (info?.base ?? "agent");
  row = document.createElement("div");
  row.className = "stand-row";
  row.dataset.id = id;
  row.onclick = () => selectAgent(id);
  row.innerHTML = `
    <span class="rk"></span>
    <span class="dot"></span>
    <div class="who">
      <div class="nm">
        <span class="kind-tag" style="background:${tag.bg}">${tag.label}</span>
        <span class="lbl" title="${id}">${id}</span>
      </div>
      <div class="handle">${handle}</div>
    </div>
    <div class="vals">
      <div class="bal"></div>
      <div class="pnl"></div>
    </div>`;
  standRows.set(id, row);
  return row;
}

function renderStandings() {
  const rows = S.ranking;
  el("stand-empty").style.display = rows.length ? "none" : "";
  for (const r of rows) {
    const row = ensureStandRow(r.id);
    const start = startOf(r);
    const colorRgb = rgbForPnl(r.pnlUsdc, start);
    row.querySelector(".rk").textContent = String(r.rank).padStart(2, "0");
    const dot = row.querySelector(".dot");
    dot.style.background = `rgb(${colorRgb})`;
    dot.style.boxShadow = `0 0 7px rgb(${colorRgb})`;
    row.querySelector(".bal").textContent = fmtUsd(r.valueUsdc);
    const pnl = row.querySelector(".pnl");
    pnl.textContent = fmtPnlPct(r.pnlUsdc, start);
    pnl.className = `pnl ${r.pnlUsdc >= 0 ? "pos" : "neg"}`;
    row.classList.toggle("sel", r.id === S.selectedId);
    standEl.appendChild(row); // rank 順に並べ替え（既存要素の移動＝スクロール維持）
  }
}

// ============================ blocks ============================
const blocksEl = el("blocks");
const blockCards = new Map(); // blockNumber -> { card, ts }

function addBlockCard(b) {
  if (blockCards.has(b.blockNumber)) return;
  const conn = document.createElement("div");
  conn.className = "block-conn";
  const card = document.createElement("div");
  card.className = "block-card";
  card.dataset.blk = b.blockNumber;
  card.innerHTML = `
    <div class="row1"><span class="hgt">#${fmtInt(b.blockNumber)}</span><span class="acc"></span></div>
    <div class="txc"></div>
    <div class="ago"></div>`;
  blocksEl.appendChild(conn);
  blocksEl.appendChild(card);
  blockCards.set(b.blockNumber, { card, conn, ts: b.ts, timingMs: b.timingMs });
  // 最新のみ accent（cyan）、それ以外はグレー
  refreshBlockAccents();
  // 7 枚を超えたら古い方（左端）から除去
  const nums = [...blockCards.keys()].sort((a, c) => a - c);
  while (nums.length > 7) {
    const old = nums.shift();
    const e = blockCards.get(old);
    e.card.remove();
    e.conn.remove();
    blockCards.delete(old);
  }
  refreshBlocks();
}

function refreshBlockAccents() {
  const nums = [...blockCards.keys()].sort((a, c) => a - c);
  const latest = nums[nums.length - 1];
  for (const n of nums) {
    const e = blockCards.get(n);
    const isLatest = n === latest;
    const accent = isLatest ? "#5cc6ff" : "#7c8493";
    const acc = e.card.querySelector(".acc");
    acc.style.background = accent;
    acc.style.boxShadow = `0 0 7px ${accent}`;
    e.card.querySelector(".txc").style.color = accent;
    e.card.style.borderColor = isLatest ? "#5cc6ff" : "#1c202a";
    e.card.style.boxShadow = isLatest
      ? "0 0 20px rgba(92,198,255,0.18)"
      : "none";
    e.card.style.background = isLatest ? "rgba(92,198,255,0.05)" : "#0f1116";
  }
}

function refreshBlocks() {
  const now = Date.now();
  for (const [n, e] of blockCards) {
    const c = S.blockTx.get(n);
    const txc = c ? c.mined || c.submitted : 0;
    e.card.querySelector(".txc").textContent = `${txc} txns`;
    e.card.querySelector(".ago").textContent = agoStr(e.ts, now);
  }
}

// ============================ tx feed ============================
const feedEl = el("feed");
function addFeedRow(tx, animate) {
  const cat = isRevert(tx.status) ? null : classifyAction(tx.actionType);
  const reverted = isRevert(tx.status);
  const badgeLabel = reverted
    ? "REVERT"
    : tx.phase === "submitted"
      ? "SUB"
      : cat;
  const rgb = reverted ? TYPE_RGB.SELL : (TYPE_RGB[cat] ?? TYPE_RGB.ARB);
  const hex = reverted ? TYPE_HEX.SELL : (TYPE_HEX[cat] ?? TYPE_HEX.ARB);
  const row = document.createElement("div");
  row.className = "tx-row";
  if (!animate) row.style.animation = "none";
  row.style.opacity = tx.phase === "submitted" ? "0.78" : "1";
  row.innerHTML = `
    <span class="time">${timeOfDay(tx.ts)}</span>
    <span class="tx-badge" style="background:rgba(${rgb},0.13);color:${hex}">${badgeLabel}</span>
    <div class="mid">
      <span class="from" title="${tx.ownerId}">${tx.ownerId}</span>
      <span class="arrow">→</span>
      <span class="act">${tx.actionType || tx.role || "tx"}</span>
    </div>
    <span class="fee">${fmtGwei(tx.priorityFeeWei)}g</span>`;
  feedEl.prepend(row);
  while (feedEl.childElementCount > 40) feedEl.lastElementChild.remove();
}

// 清算イベント（ADR 0009 stress_liquidation）を LIQ 行としてフィードへ。tx 集計には混ぜない。
function addLiquidationRow(liq, animate) {
  const rgb = TYPE_RGB.LIQ;
  const hex = TYPE_HEX.LIQ;
  const usd = fmtUsd((liq.repaidBaseUsd || 0) / 1e8);
  const row = document.createElement("div");
  row.className = "tx-row";
  if (!animate) row.style.animation = "none";
  row.innerHTML = `
    <span class="time">${timeOfDay(liq.ts || Date.now())}</span>
    <span class="tx-badge" style="background:rgba(${rgb},0.13);color:${hex}">LIQ</span>
    <div class="mid">
      <span class="from" title="${liq.victimId}">${liq.victimId}</span>
      <span class="arrow">→</span>
      <span class="act">liquidated</span>
    </div>
    <span class="fee">${usd}</span>`;
  feedEl.prepend(row);
  while (feedEl.childElementCount > 40) feedEl.lastElementChild.remove();
}

// ============================ agent detail ============================
function renderDetail() {
  const id = S.selectedId;
  const empty = el("detail-empty");
  const bodyEl = el("detail-body");
  if (!id) {
    empty.style.display = "";
    bodyEl.classList.remove("show");
    return;
  }
  empty.style.display = "none";
  bodyEl.classList.add("show");
  const info = S.agents.get(id);
  const rank = S.ranking.find((r) => r.id === id);
  const act = S.activity.get(id) ?? {
    submitted: 0,
    rejected: 0,
    submitFailed: 0,
    included: 0,
    reverted: 0,
  };
  const value = rank ? rank.valueUsdc : 0;
  const pnl = rank ? rank.pnlUsdc : 0;
  const start = rank ? startOf(rank) : 0;
  const colorRgb = rgbForPnl(pnl, start);

  el("d-dot").style.background = `rgb(${colorRgb})`;
  el("d-dot").style.boxShadow = `0 0 9px rgb(${colorRgb})`;
  el("d-name").textContent = id;
  el("d-handle").textContent = info?.address ?? info?.base ?? "—";
  el("d-equity").textContent = rank ? fmtUsd(value) : "—";
  const pnlEl = el("d-pnl");
  pnlEl.textContent = rank ? fmtPnlPct(pnl, start) : "—";
  pnlEl.className = `pnl ${pnl >= 0 ? "pos" : "neg"}`;

  const hist = S.history.get(id) ?? [];
  const sp = el("d-spark");
  sp.setAttribute("points", spark(hist, 300, 46));
  sp.setAttribute("stroke", pnl >= 0 ? "#4fe0a8" : "#ff6b7a");

  el("d-included").textContent = fmtInt(act.included || 0);
  el("d-submitted").textContent = fmtInt(act.submitted || 0);
  el("d-reverted").textContent = fmtInt(act.reverted || 0);
  const denom =
    (act.submitted || 0) + (act.rejected || 0) + (act.submitFailed || 0);
  el("d-adopt").textContent = denom
    ? Math.round(((act.submitted || 0) / denom) * 100) + "%"
    : "—";

  const recentEl = el("d-recent");
  const recent = (S.agentRecent.get(id) ?? []).slice(0, 5);
  if (recent.length === 0) {
    recentEl.innerHTML = `<div class="recent-empty">—</div>`;
  } else {
    recentEl.innerHTML = recent
      .map((t) => {
        const reverted = isRevert(t.status);
        const cat = reverted ? "SELL" : classifyAction(t.actionType);
        const label = reverted ? "✗" : cat;
        return `<div class="recent-row">
          <span class="badge" style="background:rgba(${TYPE_RGB[cat]},0.13);color:${TYPE_HEX[cat]}">${label}</span>
          <span class="act" title="${t.actionType}">${t.actionType || t.role || "tx"}</span>
          <span class="fee">${fmtGwei(t.priorityFeeWei)}g</span>
        </div>`;
      })
      .join("");
  }
}

function selectAgent(id) {
  if (!id) return;
  S.selectedId = id;
  mesh.setSelected(id);
  for (const [rid, row] of standRows) row.classList.toggle("sel", rid === id);
  renderDetail();
}

// ============================ agents ============================
function applyAgents(list) {
  let added = false;
  for (const a of list) {
    if (!S.agents.has(a.id)) {
      S.order.push(a.id);
      added = true;
    }
    S.agents.set(a.id, a);
  }
  if (added) mesh.setAgents(S.order.map((id) => ({ id })));
}

function ensureActivity(id) {
  let act = S.activity.get(id);
  if (!act) {
    act = {
      id,
      submitted: 0,
      rejected: 0,
      submitFailed: 0,
      included: 0,
      reverted: 0,
    };
    S.activity.set(id, act);
  }
  return act;
}

// ============================ tx 取り込み ============================
function ingestTx(tx, opts) {
  const t = { ...tx, ts: tx.ts ?? Date.now() };
  rememberAgentRecent(t);
  S.feed.unshift(t);
  if (S.feed.length > 120) S.feed.pop();
  // ブロック別 tx カウント
  const bt = S.blockTx.get(t.blockNumber) ?? { submitted: 0, mined: 0 };
  if (t.phase === "mined") bt.mined += 1;
  else bt.submitted += 1;
  S.blockTx.set(t.blockNumber, bt);
  // mined の確定集計
  if (t.phase === "mined") {
    S.totals.txCount += 1;
    if (isRevert(t.status)) S.totals.revertCount += 1;
    if (t.role === "agent") {
      const act = ensureActivity(t.ownerId);
      act.included += 1;
      if (isRevert(t.status)) act.reverted += 1;
    }
  } else if (!opts?.historical) {
    // mempool / tps はライブ提出のみ（snapshot 復元の履歴 tx では加算しない）
    S.mempool += 1;
    S.txTimes.push(t.ts);
  }
  if (opts?.feed !== false) addFeedRow(t, opts?.animate !== false);
  if (opts?.mesh !== false) {
    const cat = isRevert(t.status) ? "SELL" : classifyAction(t.actionType);
    mesh.spawnTx({ ownerId: t.ownerId, colorRgb: TYPE_RGB[cat] });
  }
  if (S.selectedId && t.ownerId === S.selectedId) renderDetail();
}

// ============================ values 取り込み ============================
function applyValues(v) {
  S.ranking = v.ranking ?? [];
  S.fairPrice = v.fairPrice ?? S.fairPrice;
  S.poolPrice = v.poolPrice ?? S.poolPrice;
  for (const r of S.ranking) {
    const h = S.history.get(r.id) ?? [];
    h.push(r.valueUsdc);
    if (h.length > 64) h.shift();
    S.history.set(r.id, h);
  }
  mesh.updateValues(S.ranking);
  if (!S.selectedId && S.ranking.length) selectAgent(S.ranking[0].id);
  renderStandings();
  renderHeader();
  if (S.selectedId) renderDetail();
}

// ============================ snapshot ============================
function applySnapshot(snap) {
  S.run = snap.run;
  S.latestBlock = snap.latestBlock ?? 0;
  S.poller = snap.poller;
  S.totals = snap.totals ?? S.totals;
  S.fairPrice = snap.fairPrice ?? 0;
  S.poolPrice = snap.poolPrice ?? null;
  S.agents = new Map((snap.agents ?? []).map((a) => [a.id, a]));
  S.order = (snap.agents ?? []).map((a) => a.id);
  S.activity = new Map((snap.activity ?? []).map((a) => [a.id, a]));
  S.agentRecent = new Map(
    Object.entries(snap.agentRecent ?? {}).map(([id, rows]) => [id, rows]),
  );
  S.ranking = snap.ranking ?? [];
  S.blocks = snap.blocks ?? [];
  S.scenario = snap.scenario ?? null;

  // mesh
  mesh.setAgents(S.order.map((id) => ({ id })));
  for (const r of S.ranking) {
    const h = [r.valueUsdc];
    S.history.set(r.id, h);
  }
  mesh.updateValues(S.ranking);

  // DOM クリア → 再構築
  for (const [, row] of standRows) row.remove();
  standRows.clear();
  for (const [, e] of blockCards) {
    e.card.remove();
    e.conn.remove();
  }
  blockCards.clear();
  feedEl.innerHTML = "";

  for (const b of S.blocks.slice(-7)) {
    addBlockCard(b);
    if (b.ts > S.lastBlockTs) S.lastBlockTs = b.ts;
  }
  for (const tx of (snap.tx ?? []).slice(-40)) {
    ingestTx(tx, { mesh: false, animate: false, historical: true });
  }
  for (const liq of (snap.liquidations ?? []).slice(-10)) {
    addLiquidationRow(liq, false);
  }
  if (!S.selectedId && S.ranking.length) S.selectedId = S.ranking[0].id;
  mesh.setSelected(S.selectedId);

  renderStandings();
  renderHeader();
  renderDetail();
  refreshBlocks();
}

// ============================ SSE ============================
function connect() {
  const es = new EventSource("/events");
  es.addEventListener("snapshot", (e) => {
    S.connected = true;
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener("run", (e) => {
    S.run = JSON.parse(e.data);
    renderHeader();
  });
  es.addEventListener("agents", (e) => {
    applyAgents(JSON.parse(e.data));
    renderHeader();
    renderStandings();
  });
  es.addEventListener("block", (e) => {
    const b = JSON.parse(e.data);
    S.latestBlock = Math.max(S.latestBlock, b.blockNumber);
    if (S.run)
      S.run.processedBlocks = b.processedBlocks ?? S.run.processedBlocks;
    const bp = {
      blockNumber: b.blockNumber,
      timingMs: b.timingMs,
      ts: b.ts ?? Date.now(),
    };
    S.blocks.push(bp);
    if (S.blocks.length > 900) S.blocks.shift();
    S.lastBlockTs = bp.ts;
    S.mempool = 0;
    addBlockCard(bp);
    mesh.pulseBlock();
    renderHeader();
  });
  es.addEventListener("values", (e) => applyValues(JSON.parse(e.data)));
  es.addEventListener("tx", (e) => ingestTx(JSON.parse(e.data)));
  es.addEventListener("scenario", (e) => {
    S.scenario = JSON.parse(e.data);
    renderHeader();
  });
  es.addEventListener("liquidation", (e) => {
    const liq = JSON.parse(e.data);
    addLiquidationRow(liq, true);
    mesh.spawnTx({ ownerId: liq.victimId, colorRgb: TYPE_RGB.LIQ });
    renderHeader();
  });
  es.addEventListener("agentAction", (e) => {
    const a = JSON.parse(e.data);
    const act = ensureActivity(a.agentId);
    act.submitted = a.submitted ?? act.submitted;
    act.rejected = a.rejected ?? act.rejected;
    act.submitFailed = a.submitFailed ?? act.submitFailed;
    act.lastEvent = a.event;
    act.lastActionType = a.actionType ?? act.lastActionType;
    act.lastReason = a.reason ?? act.lastReason;
    act.lastTs = a.lastTs ?? Date.now();
    rememberAgentRecent({
      phase: a.event,
      blockNumber: S.latestBlock,
      txIndex: null,
      ownerId: a.agentId,
      role: "agent",
      actionType: a.actionType ?? a.event,
      priorityFeeWei: "0",
      status: a.event,
      ts: act.lastTs,
    });
    if (S.selectedId === a.agentId) renderDetail();
  });
  es.addEventListener("pollerStatus", (e) => {
    S.poller = JSON.parse(e.data);
    renderHeader();
  });
  es.onerror = () => {
    S.connected = false;
    renderHeader();
    // EventSource が自動再接続。次接続でサーバが snapshot を再送する
  };
}

// ============================ UI tick（時間依存の更新）============================
function uiTick() {
  const now = Date.now();
  // tps: 直近 3 秒の提出 tx 数 / 3
  while (S.txTimes.length && now - S.txTimes[0] > 3000) S.txTimes.shift();
  S.tps = S.txTimes.length / 3;
  S.tpsHist.push(S.tps);
  if (S.tpsHist.length > 42) S.tpsHist.shift();
  el("stat-tps").textContent = S.tps.toFixed(1);
  el("tps-spark").setAttribute("points", spark(S.tpsHist, 120, 26));

  // mempool / 次ブロック進捗
  el("center-block").textContent = fmtInt(S.latestBlock || 0);
  el("center-mempool").textContent = fmtInt(S.mempool);
  const bt = (S.run?.blockTimeSec || 0) * 1000;
  const pct =
    bt && S.lastBlockTs ? Math.min(100, ((now - S.lastBlockTs) / bt) * 100) : 0;
  el("nextbar-fill").style.width = `${pct}%`;

  refreshBlocks();
}

connect();
setInterval(uiTick, 200);
uiTick();
