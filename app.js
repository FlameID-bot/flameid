// FlameID — frontend logic (static site, no backend).
// The user connects their own wallet in their own browser. This page never
// asks for a seed phrase, private key, or QR login, and never stores a session.
// All writes go through the user's wallet after their own confirmation.
//
// Deployed 2026-11-25 (block 135604541, tx 0xfc076e18dcbffb3e05105cf8247f00c7e36fda83f628c8d98555ebfa6bbc0162)
const CONTRACT_ADDRESS = "0xa68B69AF101E4262F651119c9830BfBd1603EC97";
const DEPLOY_BLOCK = 135604541;
const REGISTRY_ADDRESS = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const CHAIN_ID = 56; // BNB Chain
const BSCSCAN = "https://bscscan.com";

// Public BSC RPCs. Some of them reject the default ethers fetch (403), so
// every request carries a browser User-Agent. Public nodes also cap
// eth_getLogs at ~5,000 blocks per call, so log reads are chunked to
// 4,000-block windows.
const RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
  "https://rpc.48.club",
];
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const LOG_WINDOW = 4000;

// Boards render instantly from this precomputed file when it is fresh
// (rebuilt every 10 minutes by scripts/build_leaderboard.js). Reading
// ~250k blocks of eth_getLogs from every visitor's browser was the
// reason the boards took minutes: public BSC RPCs rate-limit getLogs.
// The live loaders below stay as the fallback when the file is missing
// or older than this, and after connect / check-in.
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

// Multicall3 (same address on BSC): one eth_call for a whole batch of
// view reads, instead of one round-trip per wallet. The boards used to
// read scoreOf/handleOf/referralCount wallet-by-wallet in batches of 5,
// which was ~90 sequential round-trips on top of the log scans — the
// main reason the boards took a minute or more to appear.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])",
];
let multicall = null;

const MILESTONES = [
  { days: 7, tierKey: "tierBronze", color: "#CD7F32" },
  { days: 14, tierKey: "tierSilver", color: "#C0C0C0" },
  { days: 30, tierKey: "tierGold", color: "#FFD700" },
  { days: 60, tierKey: "tierPlatinum", color: "#E5E4E2" },
  { days: 100, tierKey: "tierDiamond", color: "#B9F2FF" },
];

// Special badges: 1 = Genesis (first 7 days after deploy only),
// 2 = Survivor (7/7 days in any Season 1 week), 3 = Champion (top 3
// Season 1 streaks, claimable after the season ends).
const SPECIAL_BADGES = [
  { kind: 1, name: "Genesis", color: "#FF6B35", descKey: "descGenesis" },
  { kind: 2, name: "Survivor", color: "#7EE2A8", descKey: "descSurvivor" },
  { kind: 3, name: "Champion", color: "#FFD700", descKey: "descChampion" },
];
const SEASON_END_TS = 1796803200; // 2026-12-09 08:00:00 UTC

const $ = (id) => document.getElementById(id);
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "–");
const dayToDate = (day) =>
  new Date(Number(day) * 86400 * 1000).toISOString().slice(0, 10);

let readProvider = null;
let contract = null;
let userAddress = null;
let userSigner = null;
let myReferrer = ethers.ZeroAddress;
let myInviteRef = null;
let noAgentId = false;
let myReferredAddr = null;

// Prompt placeholders per language — the fill text must match the
// agentPromptText value of the same language in i18n.js.
const PROMPT_PLACEHOLDERS = {
  en: ["[your wallet address]", "[your .ai name, e.g. yourname.ai]"],
  vi: ["[địa chỉ ví của bạn]", "[tên.ai của bạn, ví dụ yourname.ai]"],
  zh: ["[你的钱包地址]", "[你的 .ai 名称，例如 yourname.ai]"],
  ko: ["[당신의 지갑 주소]", "[당신의 .ai 이름(예: yourname.ai)]"],
  ja: ["[あなたのウォレットアドレス]", "[あなたの .ai 名（例：yourname.ai）]"],
};

// .ai name cache for leaderboard rows: lowercase address -> display string.
const handleCache = new Map();
let readRegistry = null;

function makeProvider(url) {
  const req = new ethers.FetchRequest(url);
  req.setHeader("User-Agent", BROWSER_UA);
  req.timeout = 15000;
  return new ethers.JsonRpcProvider(req);
}

async function pickWorkingProvider() {
  for (const url of RPCS) {
    try {
      const p = makeProvider(url);
      await p.getBlockNumber();
      return p;
    } catch (e) {
      console.warn("RPC failed, trying next:", url, e.message);
    }
  }
  throw new Error("No working BSC RPC");
}

let goodRpcIdx = 0;
function contractOn(url) {
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, makeProvider(url));
}

// One log window, tried on every RPC in turn: dataseed* answer
// getBlockNumber but currently rate-limit eth_getLogs (-32005), so a
// single-provider read comes back empty and the boards look blank.
async function queryLogsFallback(filter, from, to) {
  for (let k = 0; k < RPCS.length; k++) {
    const idx = (goodRpcIdx + k) % RPCS.length;
    try {
      const logs = await contractOn(RPCS[idx]).queryFilter(filter, from, to);
      goodRpcIdx = idx;
      return logs;
    } catch (e) {
      console.warn(`getLogs ${from}-${to} failed on ${RPCS[idx]}:`, e.message);
    }
  }
  throw new Error("All RPCs failed for getLogs");
}

async function getLogsChunked(filter, fromBlock, toBlock) {
  const ranges = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_WINDOW) {
    ranges.push([from, Math.min(from + LOG_WINDOW - 1, toBlock)]);
  }
  // Chunks run 5 at a time: the old sequential scan was ~30 round-trips
  // in a row, each with RPC-fallback retries — the single biggest chunk
  // of board load time. Results are re-sorted chronologically because
  // per-wallet aggregation below assumes ascending event order.
  const out = [];
  const LOG_CONCURRENCY = 5;
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = await Promise.all(ranges.slice(i, i + LOG_CONCURRENCY).map(async ([from, to]) => {
      try {
        return await queryLogsFallback(filter, from, to);
      } catch (e) {
        console.warn(`getLogs ${from}-${to} failed on all RPCs, skipped`);
        return [];
      }
    }));
    for (const logs of batch) out.push(...logs);
  }
  out.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  return out;
}

// Batch many view calls into ONE eth_call via Multicall3.
// items: [{ target, data, decode }] — decode(bytes) -> value.
// Returns values in order, null for any sub-call that failed, and
// all-null when Multicall itself is unreachable — the caller then falls
// back to plain batched reads, so a dead Multicall never breaks a board.
async function multicallBatch(items) {
  if (!multicall || !items.length) return items.map(() => null);
  try {
    const res = await multicall.aggregate3.staticCall(
      items.map((it) => ({ target: it.target, allowFailure: true, callData: it.data }))
    );
    return res.map((r, i) => {
      if (!r.success) return null;
      try { return items[i].decode(r.returnData); } catch (e) { return null; }
    });
  } catch (e) {
    console.warn("multicall failed, falling back to batched reads:", e.message);
    return items.map(() => null);
  }
}

// Referrer from ?ref= : a wallet address OR an Agent ID name
// (?ref=yourname.ai). Names resolve on-chain via the registry:
// ownerOfHandle(label) — label WITHOUT the .ai suffix — with a
// keccak256(label) -> ownerOf fallback (same as agent.html).
// Old ?ref=0x... links keep working.
async function resolveReferrerFromUrl(registry) {
  const ref = new URLSearchParams(window.location.search).get("ref");
  if (!ref) return ethers.ZeroAddress;
  if (ethers.isAddress(ref)) return ethers.getAddress(ref);
  const label = ref.replace(/\.ai$/i, "").toLowerCase().trim();
  if (!label || !/^[a-z0-9][a-z0-9-]*$/.test(label)) return ethers.ZeroAddress;
  try {
    const addr = await registry.ownerOfHandle(label);
    if (addr !== ethers.ZeroAddress) return addr;
  } catch (e) { /* fall through to keccak fallback */ }
  try {
    const tokenId = ethers.keccak256(ethers.toUtf8Bytes(label));
    return await registry.ownerOf(tokenId);
  } catch (e) {
    return ethers.ZeroAddress;
  }
}

// Fill the agent prompt with my wallet + .ai name so it is ready to copy.
// The template comes from the i18n dictionary in the current language,
// so a language switch re-fills it in the new language.
function fillAgentPrompt() {
  if (!userAddress) return;
  const promptEl = $("agentPrompt");
  if (!promptEl) return;
  try {
    const lang = (window.FlameI18n && window.FlameI18n.lang) || "en";
    const ph = PROMPT_PLACEHOLDERS[lang] || PROMPT_PLACEHOLDERS.en;
    let text = t("agentPromptText");
    text = text.replace(ph[0], userAddress);
    if (myInviteRef && myInviteRef !== userAddress) text = text.replace(ph[1], myInviteRef);
    promptEl.textContent = text;
  } catch (e) {
    console.warn("agent prompt fill failed:", e.message);
  }
}

// .ai names for leaderboard / season / referrer / recent rows.
// Rows render the short address first, then swap in "<handle>.ai" once
// the registry answers. Results are cached per address; a failed lookup
// keeps the short address.
async function resolveHandles(addrs) {
  if (!readRegistry) return;
  const missing = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => !handleCache.has(a));
  if (!missing.length) return;
  // One Multicall for every missing .ai name instead of one round-trip
  // per wallet in batches of 5.
  const regIface = new ethers.Interface(["function handleOf(address) view returns (string)"]);
  const values = await multicallBatch(missing.map((a) => ({
    target: REGISTRY_ADDRESS,
    data: regIface.encodeFunctionData("handleOf", [a]),
    decode: (ret) => regIface.decodeFunctionResult("handleOf", ret)[0],
  })));
  const stillMissing = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined) stillMissing.push(missing[i]);
    else handleCache.set(missing[i], v ? `${v}.ai` : shortAddr(missing[i]));
  });
  // Fallback for whatever Multicall could not answer (or if Multicall
  // itself is down): plain reads, 5 at a time.
  for (let i = 0; i < stillMissing.length; i += 5) {
    await Promise.all(stillMissing.slice(i, i + 5).map(async (a) => {
      try {
        const h = await readRegistry.handleOf(a);
        handleCache.set(a, h ? `${h}.ai` : shortAddr(a));
      } catch (e) {
        handleCache.set(a, shortAddr(a));
      }
    }));
  }
}

async function enhanceAddrNames() {
  try {
    const spans = [...document.querySelectorAll("span.addr[data-addr]")];
    if (!spans.length) return;
    await resolveHandles(spans.map((s) => s.dataset.addr));
    for (const s of spans) {
      const name = handleCache.get(s.dataset.addr.toLowerCase());
      if (name) s.textContent = name;
    }
  } catch (e) {
    console.warn("addr name enhance failed:", e.message);
  }
}

async function loadStats() {
  try {
    const [streakers, checkIns, badges] = await Promise.all([
      contract.totalStreakers(),
      contract.totalCheckIns(),
      contract.totalBadges(),
    ]);
    $("statStreakers").textContent = Number(streakers);
    $("statCheckIns").textContent = Number(checkIns);
    $("statBadges").textContent = Number(badges);
  } catch (e) {
    console.warn("loadStats failed:", e.message);
  }
}

async function loadBoardsFromCache() {
  try {
    const res = await fetch("leaderboard.json", { cache: "no-store" });
    if (!res.ok) return false;
    const data = await res.json();
    const age = Date.now() - new Date(data.generatedAt).getTime();
    if (!Number.isFinite(age) || age > CACHE_MAX_AGE_MS) return false;
    renderBoardsFromCache(data);
    return true;
  } catch (e) {
    console.warn("leaderboard.json unavailable:", e.message);
    return false;
  }
}

// Fill every board from the precomputed JSON (same rows, ranking and
// labels as the live loaders, so a cached board and a live board agree).
function renderBoardsFromCache(data) {
  const name = (r) => r.handle || shortAddr(r.addr);
  const me = (addr) => userAddress && addr === userAddress.toLowerCase() ? ' class="me"' : "";

  $("statStreakers").textContent = Number(data.stats.streakers);
  $("statCheckIns").textContent = Number(data.stats.checkIns);
  $("statBadges").textContent = Number(data.stats.badges);
  $("statTopStreak").textContent = Number(data.stats.topStreak);

  $("leaderboard").innerHTML = data.streakTop10.length
    ? data.streakTop10.map((r, i) =>
        `<li${me(r.addr)}>#${i + 1} <span class="addr" data-addr="${r.addr}">${name(r)}</span>` +
        `<span class="num">${r.effective}🔥 ${t("lbBest", { n: r.longest })}</span></li>`).join("")
    : `<li class="muted">${t("noCheckIns")}</li>`;

  $("seasonTop10").innerHTML = data.seasonTop10.length
    ? data.seasonTop10.map((r, i) =>
        `<li${me(r.addr)}>#${i + 1} <span class="addr" data-addr="${r.addr}">${name(r)}</span>` +
        `<span class="num">${t("top10Score", { score: r.score, best: r.longest })}</span></li>`).join("")
    : `<li class="muted">${t("noCheckIns")}</li>`;

  $("topReferrers").innerHTML = data.topReferrers.length
    ? data.topReferrers.map((r, i) => {
        const pending = r.invited > r.count ? ` ${t("refPending", { n: r.invited - r.count })}` : "";
        return `<li${me(r.addr)}>#${i + 1} <span class="addr" data-addr="${r.addr}">${name(r)}</span>` +
          `<span class="num">${r.count} ${t("qualified")}${pending}</span></li>`;
      }).join("")
    : `<li class="muted">${t("noReferrals")}</li>`;

  $("recentList").innerHTML = data.recent.length
    ? data.recent.map((ev) =>
        `<li><span class="addr" data-addr="${ev.addr}">${ev.handle || shortAddr(ev.addr)}</span> ` +
        `${t("checkedIn", { streak: ev.streak, date: ev.date })}</li>`).join("")
    : `<li class="muted">${t("recentEmpty")}</li>`;

  // Your ranks, when the connected wallet is inside the cached lists.
  // If it is not there, leave the placeholders: the live loaders fill
  // them in after connect (the wallet may have checked in after this
  // JSON was built).
  if (userAddress) {
    const si = (data.allSeasonAddrs || []).findIndex((a) => a === userAddress.toLowerCase());
    if (si >= 0) $("myRank").textContent = t("myRank", { rank: si + 1, score: data.allSeasonScores[si] });
    const ri = (data.allReferrerAddrs || []).findIndex((a) => a === userAddress.toLowerCase());
    if (ri >= 0) $("myRefRank").textContent = t("myRefRank", { rank: ri + 1, count: data.allReferrerCounts[ri] });
  } else {
    $("myRank").textContent = t("myRankNone");
    $("myRefRank").textContent = t("myRefRankNone");
  }
}

async function loadLeaderboardAndRecent() {
  const lb = $("leaderboard");
  const recent = $("recentList");
  try {
    const latest = await readProvider.getBlockNumber();
    const from = DEPLOY_BLOCK > 0 ? DEPLOY_BLOCK : Math.max(0, latest - 200000);
    const events = await getLogsChunked(contract.filters.CheckedIn(), from, latest);
    const today = Math.floor(Date.now() / 1000 / 86400);

    // Aggregate per wallet.
    const byAddr = new Map();
    for (const ev of events) {
      const a = ev.args.user.toLowerCase();
      const day = Number(ev.args.day);
      const streak = Number(ev.args.currentStreak);
      const cur = byAddr.get(a) || { lastDay: 0, lastStreak: 0, longest: 0, total: 0 };
      cur.lastDay = Math.max(cur.lastDay, day);
      if (day === cur.lastDay) cur.lastStreak = streak;
      cur.longest = Math.max(cur.longest, streak);
      cur.total += 1;
      byAddr.set(a, cur);
    }
    // Effective current streak: alive if last check-in was today or yesterday.
    const rows = [...byAddr.entries()].map(([a, s]) => ({
      addr: a,
      effective: s.lastDay >= today - 1 ? s.lastStreak : 0,
      longest: s.longest,
      total: s.total,
      lastDay: s.lastDay,
    }));
    rows.sort((x, y) => y.effective - x.effective || y.longest - x.longest || y.total - x.total);

    // Merge the connected wallet's LIVE on-chain state, so their row shows
    // immediately after check-in — public RPCs can take minutes to index
    // the new event, and without this the user never sees themselves.
    let myTotal = 0;
    if (userAddress) {
      try {
        const me = userAddress.toLowerCase();
        const s = await contract.streakOf(userAddress);
        myTotal = Number(s[2]);
        if (myTotal > 0) {
          const live = {
            addr: me,
            effective: Number(s[3]) >= today - 1 ? Number(s[0]) : 0,
            longest: Number(s[1]),
            total: myTotal,
            lastDay: Number(s[3]),
          };
          const i = rows.findIndex((r) => r.addr === me);
          if (i >= 0) rows[i] = { ...rows[i], ...live };
          else rows.push(live);
          rows.sort((x, y) => y.effective - x.effective || y.longest - x.longest || y.total - x.total);
        }
      } catch (e) {
        console.warn("live user merge failed:", e.message);
      }
    }

    $("statTopStreak").textContent = rows.length ? Math.max(...rows.map((r) => r.longest)) : 0;

    lb.innerHTML = rows.length
      ? rows.slice(0, 10).map((r, i) => {
          const me = userAddress && r.addr === userAddress.toLowerCase() ? ' class="me"' : "";
          return `<li${me}>#${i + 1} <span class="addr" data-addr="${r.addr}">${shortAddr(r.addr)}</span>` +
            `<span class="num">${r.effective}🔥 ${t("lbBest", { n: r.longest })}</span></li>`;
        }).join("")
      : `<li class="muted">${t("noCheckIns")}</li>`;

    // Season top 10, ranked by on-chain trust score (scoreOf) — the same
    // ranking the 100 USDT giveaway pays out on. (The contract's
    // seasonTop3() only returns 3, so the top 10 is computed from events.)
    // Own try/catch + 5-at-a-time reads, so a score-read failure or a
    // rate limit never breaks the main leaderboard above.
    const seasonEl = $("seasonTop10");
    const myRankEl = $("myRank");
    try {
      if (!rows.length) {
        seasonEl.innerHTML = `<li class="muted">${t("noCheckIns")}</li>`;
        myRankEl.textContent = !userAddress ? t("myRankNone") : t("myRankZero");
      } else {
        // One Multicall for every wallet's trust score, with a batched
        // fallback for any wallet Multicall could not answer.
        const scores = await multicallBatch(rows.map((r) => ({
          target: CONTRACT_ADDRESS,
          data: contract.interface.encodeFunctionData("scoreOf", [r.addr]),
          decode: (ret) => Number(contract.interface.decodeFunctionResult("scoreOf", ret)[0]),
        })));
        const scored = rows.map((r, i) => ({ ...r, score: scores[i] }));
        const missingScores = scored.filter((r) => r.score === null || r.score === undefined);
        for (let i = 0; i < missingScores.length; i += 5) {
          await Promise.all(missingScores.slice(i, i + 5).map(async (r) => {
            try { r.score = Number(await contract.scoreOf(r.addr)); }
            catch (e) { r.score = 0; }
          }));
        }
        scored.sort((x, y) => y.score - x.score || y.longest - x.longest || y.total - x.total);
        seasonEl.innerHTML = scored.slice(0, 10).map((r, i) => {
          const me = userAddress && r.addr === userAddress.toLowerCase() ? ' class="me"' : "";
          return `<li${me}>#${i + 1} <span class="addr" data-addr="${r.addr}">${shortAddr(r.addr)}</span>` +
            `<span class="num">${t("top10Score", { score: r.score, best: r.longest })}</span></li>`;
        }).join("");
        // Your rank among all wallets (not just the top 10 shown).
        if (!userAddress) myRankEl.textContent = t("myRankNone");
        else if (myTotal === 0) myRankEl.textContent = t("myRankZero");
        else {
          const myIdx = scored.findIndex((r) => r.addr === userAddress.toLowerCase());
          myRankEl.textContent = myIdx >= 0
            ? t("myRank", { rank: myIdx + 1, score: scored[myIdx].score })
            : t("myRankNone");
        }
      }
    } catch (e) {
      console.warn("season top 10 failed:", e.message);
      seasonEl.innerHTML = `<li class="muted">${t("loadSeasonFail")}</li>`;
      myRankEl.textContent = t("loadSeasonFail");
    }

    const last = events.slice(-10).reverse();
    recent.innerHTML = last.length
      ? last.map((ev) =>
          `<li><span class="addr" data-addr="${ev.args.user.toLowerCase()}">${shortAddr(ev.args.user)}</span> ` +
          `${t("checkedIn", { streak: Number(ev.args.currentStreak), date: dayToDate(ev.args.day) })}</li>`).join("")
      : `<li class="muted">${t("recentEmpty")}</li>`;

    // Swap short addresses for .ai names on all four lists above.
    enhanceAddrNames();
  } catch (e) {
    console.warn("loadLeaderboardAndRecent failed:", e.message);
    lb.innerHTML = `<li class="muted">${t("loadLbFail")}</li>`;
    $("seasonTop10").innerHTML = `<li class="muted">${t("loadSeasonFail")}</li>`;
    recent.innerHTML = `<li class="muted">${t("loadRecentFail")}</li>`;
  }
}

async function loadTopReferrers() {
  const el = $("topReferrers");
  const myRefRankEl = $("myRefRank");
  try {
    const latest = await readProvider.getBlockNumber();
    const from = DEPLOY_BLOCK > 0 ? DEPLOY_BLOCK : Math.max(0, latest - 200000);
    const events = await getLogsChunked(contract.filters.ReferralRecorded(), from, latest);
    // Invites per referrer from events — includes not-yet-qualified ones
    // (qualification needs the invitee to reach a 3-day streak, so on
    // day 1 every qualified count is still 0).
    const invited = new Map();
    for (const ev of events) {
      const r = ev.args.referrer.toLowerCase();
      invited.set(r, (invited.get(r) || 0) + 1);
    }
    const referrers = [...invited.keys()];
    // One Multicall for every referrer's qualified count, with a batched
    // fallback for any referrer Multicall could not answer.
    const refCounts = await multicallBatch(referrers.map((r) => ({
      target: CONTRACT_ADDRESS,
      data: contract.interface.encodeFunctionData("referralCount", [r]),
      decode: (ret) => Number(contract.interface.decodeFunctionResult("referralCount", ret)[0]),
    })));
    const counts = referrers.map((r, i) => ({
      addr: r,
      count: refCounts[i],
      invited: invited.get(r) || 0,
    }));
    const missingCounts = counts.filter((r) => r.count === null || r.count === undefined);
    for (let i = 0; i < missingCounts.length; i += 5) {
      await Promise.all(missingCounts.slice(i, i + 5).map(async (r) => {
        try { r.count = Number(await contract.referralCount(r.addr)); }
        catch (e) { r.count = 0; }
      }));
    }
    // Merge the connected wallet's LIVE counts so they appear right away.
    let myQualified = 0;
    let myInvited = 0;
    if (userAddress) {
      try {
        const me = userAddress.toLowerCase();
        myQualified = Number(await contract.referralCount(userAddress));
        myInvited = invited.get(me) || 0;
        if (myQualified > 0 || myInvited > 0) {
          const i = counts.findIndex((r) => r.addr === me);
          if (i >= 0) counts[i] = { addr: me, count: myQualified, invited: myInvited };
          else counts.push({ addr: me, count: myQualified, invited: myInvited });
        }
      } catch (e) {
        console.warn("live referrer merge failed:", e.message);
      }
    }
    counts.sort((a, b) => b.count - a.count || b.invited - a.invited);
    el.innerHTML = counts.length
      ? counts.slice(0, 10).map((r, i) => {
          const me = userAddress && r.addr === userAddress.toLowerCase() ? ' class="me"' : "";
          const pending = r.invited > r.count ? ` ${t("refPending", { n: r.invited - r.count })}` : "";
          return `<li${me}>#${i + 1} <span class="addr" data-addr="${r.addr}">${shortAddr(r.addr)}</span>` +
            `<span class="num">${r.count} ${t("qualified")}${pending}</span></li>`;
        }).join("")
      : `<li class="muted">${t("noReferrals")}</li>`;
    // Swap short addresses for .ai names.
    enhanceAddrNames();
    // Your referral rank among all referrers.
    if (!userAddress) myRefRankEl.textContent = t("myRefRankNone");
    else if (myQualified === 0 && myInvited === 0) myRefRankEl.textContent = t("myRefRankZero");
    else {
      const myIdx = counts.findIndex((r) => r.addr === userAddress.toLowerCase());
      myRefRankEl.textContent = myIdx >= 0
        ? t("myRefRank", { rank: myIdx + 1, count: counts[myIdx].count })
        : t("myRefRankNone");
    }
  } catch (e) {
    console.warn("loadTopReferrers failed:", e.message);
    el.innerHTML = `<li class="muted">${t("loadRefFail")}</li>`;
    myRefRankEl.textContent = t("loadRefFail");
  }
}

function renderBadges(myLongest, claimed) {
  $("badgeGrid").innerHTML = MILESTONES.map((m) => {
    const isClaimed = claimed[m.days];
    const canClaim = !isClaimed && myLongest >= m.days && userAddress;
    return `<div class="badge ${isClaimed ? "earned" : ""}">
      <div class="badge-days" style="color:${m.color}">${m.days}</div>
      <div class="badge-tier" style="color:${m.color}">${t(m.tierKey)}</div>
      ${isClaimed
        ? `<div class="claimed">${t("claimed")}</div>`
        : `<button data-milestone="${m.days}" ${canClaim ? "" : "disabled"}>${t("claimBadge")}</button>`}
    </div>`;
  }).join("");
  document.querySelectorAll("#badgeGrid button[data-milestone]").forEach((btn) => {
    btn.addEventListener("click", () => claimBadge(Number(btn.dataset.milestone)));
  });
}

function renderSpecialBadges(claimed, canClaim, genesisOpen) {
  $("specialGrid").innerHTML = SPECIAL_BADGES.map((b) => {
    const isClaimed = claimed[b.kind];
    const ok = canClaim[b.kind] && userAddress;
    return `<div class="badge ${isClaimed ? "earned" : ""}">
      <div class="badge-days" style="color:${b.color}">${b.name}</div>
      <div class="badge-desc">${t(b.descKey)}</div>
      ${isClaimed
        ? `<div class="claimed">${t("claimed")}</div>`
        : b.kind === 1 && !genesisOpen
          ? `<div class="muted small">${t("windowClosed")}</div>`
          : `<button data-kind="${b.kind}" ${ok ? "" : "disabled"}>${t("claimBadge")}</button>`}
    </div>`;
  }).join("");
  document.querySelectorAll("#specialGrid button[data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => claimSpecial(Number(btn.dataset.kind)));
  });
}

async function loadSpecialBadges() {
  if (!userAddress) {
    renderSpecialBadges({}, {}, false);
    return;
  }
  try {
    const claimed = {};
    const canClaim = {};
    const [genesisDeadline, mySeason] = await Promise.all([
      contract.GENESIS_DEADLINE(),
      contract.seasonOf(userAddress),
    ]);
    const genesisOpen = Math.floor(Date.now() / 1000) < Number(genesisDeadline);
    for (const b of SPECIAL_BADGES) {
      claimed[b.kind] = await contract.hasSpecialBadge(userAddress, b.kind);
    }
    const myStreak = await contract.streakOf(userAddress);
    const myLongest = Number(myStreak[1]);
    canClaim[1] = genesisOpen && Number(myStreak[4]) !== 0; // needs ≥1 check-in
    canClaim[2] = Number(mySeason[4]) >= 7; // bestCleanStreak
    canClaim[3] = false; // Champion eligibility needs the top-3 check below.
    if (!claimed[3]) {
      const top3 = await contract.seasonTop3();
      const inTop3 = top3[0].some((a) => a.toLowerCase() === userAddress.toLowerCase());
      const seasonOver = Math.floor(Date.now() / 1000) >= SEASON_END_TS;
      canClaim[3] = seasonOver && inTop3;
    }
    renderSpecialBadges(claimed, canClaim, genesisOpen);
    $("genesisNote").textContent = genesisOpen
      ? t("genesisOpen", { date: new Date(Number(genesisDeadline) * 1000).toISOString().slice(0, 10) })
      : t("genesisClosed");
  } catch (e) {
    console.warn("loadSpecialBadges failed:", e.message);
  }
}

async function loadSeason() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const active = now < SEASON_END_TS;
    const endDate = new Date(SEASON_END_TS * 1000).toISOString().slice(0, 16).replace("T", " ");
    $("seasonStatus").textContent = active
      ? t("seasonLive", { end: endDate, days: Math.max(0, Math.ceil((SEASON_END_TS - now) / 86400)) })
      : t("seasonEnded", { end: endDate });
    // Season top 10 is rendered by loadLeaderboardAndRecent() (ranked by
    // trust score); the contract's seasonTop3() is only used for the
    // Champion claim check in loadSpecialBadges().
    if (userAddress) {
      const s = await contract.seasonOf(userAddress);
      $("mySeasonDays").textContent = Number(s[0]);
      $("mySeasonStreak").textContent = Number(s[1]);
      $("mySeasonBest").textContent = Number(s[2]);
      $("mySeasonClean").textContent = Number(s[4]);
    }
  } catch (e) {
    console.warn("loadSeason failed:", e.message);
  }
}

async function loadMyStreak() {
  if (!userAddress) return;
  try {
    const s = await contract.streakOf(userAddress);
    const myLongest = Number(s[1]);
    $("myStreakEmpty").classList.add("hidden");
    $("myStreakBody").classList.remove("hidden");
    $("myCurrent").textContent = Number(s[0]);
    $("myLongest").textContent = myLongest;
    $("myTotal").textContent = Number(s[2]);
    $("myShields").textContent = Number(await contract.shields(userAddress));
    $("myLast").textContent = Number(s[3]) ? dayToDate(s[3]) : "–";
    $("myReferrals").textContent = Number(await contract.referralCount(userAddress));
    $("myScore").textContent = Number(await contract.scoreOf(userAddress));

    const can = await contract.canCheckInToday(userAddress);
    const btn = $("checkInBtn");
    btn.disabled = !can;
    $("checkInMsg").textContent = can
      ? t("checkInNotYet")
      : t("checkInDone");

    const referred = await contract.referredBy(userAddress);
    if (referred !== ethers.ZeroAddress) {
      myReferredAddr = referred;
      $("referrerLine").classList.remove("hidden");
      $("referrerLine").textContent = t("invitedBy", { addr: shortAddr(referred) });
    }

    const claimed = {};
    for (const m of MILESTONES) {
      claimed[m.days] = await contract.hasBadge(userAddress, m.days);
    }
    renderBadges(myLongest, claimed);
    await loadSpecialBadges();
    await loadSeason();
  } catch (e) {
    console.warn("loadMyStreak failed:", e.message);
  }
}

async function checkIn() {
  const btn = $("checkInBtn");
  try {
    btn.disabled = true;
    $("checkInMsg").textContent = t("checkInConfirm");
    const c = contract.connect(userSigner);
    const tx = await c.checkIn(myReferrer);
    $("checkInMsg").textContent = t("checkInSent", { hash: tx.hash });
    await tx.wait();
    $("checkInMsg").textContent = t("checkInSuccess");
    await loadMyStreak();
    await loadStats();
    await loadLeaderboardAndRecent();
    await loadTopReferrers();
  } catch (e) {
    $("checkInMsg").textContent = t("checkInFailed", { err: e.reason || e.message });
    btn.disabled = false;
  }
}

async function claimBadge(milestone) {
  try {
    const c = contract.connect(userSigner);
    const tx = await c.claimBadge(milestone);
    await tx.wait();
    alert(t("badgeClaimedAlert", { days: milestone }));
    await loadMyStreak();
    await loadStats();
  } catch (e) {
    alert(t("claimFailed", { err: e.reason || e.message }));
  }
}

async function claimSpecial(kind) {
  const fn = kind === 1 ? "claimGenesis" : kind === 2 ? "claimSurvivor" : "claimChampion";
  const label = kind === 1 ? "Genesis" : kind === 2 ? "Survivor" : "Champion";
  try {
    const c = contract.connect(userSigner);
    const tx = await c[fn]();
    await tx.wait();
    alert(t("specialClaimedAlert", { label }));
    await loadMyStreak();
    await loadStats();
  } catch (e) {
    alert(t("claimFailed", { err: e.reason || e.message }));
  }
}

async function connectWallet() {
  const btn = $("connectBtn");
  try {
    if (!window.ethereum) {
      alert(t("noWallet"));
      return;
    }
    btn.disabled = true;
    btn.textContent = t("connecting");
    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const network = await browserProvider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      alert(t("wrongChain"));
      btn.disabled = false;
      btn.textContent = t("connectWallet");
      return;
    }
    const accounts = await browserProvider.send("eth_requestAccounts", []);
    userAddress = ethers.getAddress(accounts[0]);
    userSigner = await browserProvider.getSigner();
    $("walletLine").classList.remove("hidden");
    $("walletLine").textContent = t("connectedPrefix") + userAddress;
    btn.textContent = t("connected");
    btn.disabled = true;

    // Registry (read-only): Agent ID checks + .ai handle lookups.
    const registry = new ethers.Contract(
      REGISTRY_ADDRESS,
      [
        "function balanceOf(address) view returns (uint256)",
        "function handleOf(address) view returns (string)",
        "function ownerOfHandle(string) view returns (address)",
        "function ownerOf(uint256) view returns (address)",
      ],
      readProvider
    );

    // Referrer from ?ref= : only valid if it is not me and it already checked in.
    const ref = await resolveReferrerFromUrl(registry);
    if (ref !== ethers.ZeroAddress && ref.toLowerCase() !== userAddress.toLowerCase()) {
      try {
        const refStreak = await contract.streakOf(ref);
        if (Number(refStreak[4]) !== 0) myReferrer = ref;
      } catch (e) {
        console.warn("referrer check failed:", e.message);
      }
    }

    // Invite link: the user's .ai name when they have one
    // (?ref=yourname.ai), otherwise their wallet address.
    // Old ?ref=0x... links keep working.
    let inviteRef = userAddress;
    try {
      const handle = await registry.handleOf(userAddress);
      if (handle) inviteRef = `${handle}.ai`;
    } catch (e) {
      console.warn("handle lookup failed, using address:", e.message);
    }
    const link = `${window.location.origin}${window.location.pathname}?ref=${inviteRef}`;
    $("inviteLink").textContent = link;
    $("inviteBox").classList.remove("hidden");
    $("inviteEmpty").classList.add("hidden");

    // Fill the agent prompt with my wallet + .ai name so it is ready to copy.
    myInviteRef = inviteRef;
    fillAgentPrompt();

    // Agent ID check.
    const bal = await registry.balanceOf(userAddress);
    if (bal === 0n) {
      noAgentId = true;
      $("myStreakEmpty").textContent = t("myStreakNoAgent");
      renderBadges(0, {});
      return;
    }
    noAgentId = false;
    await loadMyStreak();
    await Promise.all([loadLeaderboardAndRecent(), loadTopReferrers()]);
  } catch (e) {
    alert(t("connectFailed", { err: e.reason || e.message }));
    btn.disabled = false;
    btn.textContent = t("connectWallet");
  }
}

async function init() {
  $("connectBtn").textContent = t("connectWallet");
  $("copyInviteBtn").textContent = t("copy");
  renderBadges(0, {});
  $("checkInBtn").addEventListener("click", checkIn);
  $("connectBtn").addEventListener("click", connectWallet);
  $("copyInviteBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("inviteLink").textContent);
      $("copyInviteBtn").textContent = t("copied");
      setTimeout(() => { $("copyInviteBtn").textContent = t("copy"); }, 2000);
    } catch (e) {
      alert(t("copyFailed"));
    }
  });
  $("copyPromptBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("agentPrompt").textContent);
      $("copyPromptBtn").textContent = t("copied");
      setTimeout(() => { $("copyPromptBtn").textContent = t("copy"); }, 2000);
    } catch (e) {
      alert(t("copyFailed"));
    }
  });

  if (CONTRACT_ADDRESS === ethers.ZeroAddress) {
    $("deployBanner").classList.remove("hidden");
    $("contractLink").textContent = t("notDeployed");
    return;
  }
  $("contractLink").textContent = shortAddr(CONTRACT_ADDRESS);
  $("contractLink").href = `${BSCSCAN}/address/${CONTRACT_ADDRESS}#code`;

  try {
    readProvider = await pickWorkingProvider();
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, readProvider);
    // Registry (read-only): .ai handle lookups for leaderboard rows.
    readRegistry = new ethers.Contract(REGISTRY_ADDRESS, [
      "function handleOf(address) view returns (string)",
    ], readProvider);
    multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, readProvider);
    // Boards first: the precomputed JSON renders instantly when fresh.
    // The heavy live log scans only run when the cache is missing or
    // stale — never overwrite a good cached board with a gappy live
    // read, and never leave the page blank while RPCs are slow.
    const cached = await loadBoardsFromCache();
    await Promise.all(cached
      ? [loadStats(), loadSeason()]
      : [loadStats(), loadLeaderboardAndRecent(), loadTopReferrers(), loadSeason()]);
    renderSpecialBadges({}, {}, false);
    $("genesisNote").textContent = t("genesisConnect");
  } catch (e) {
    console.warn("init failed:", e.message);
    $("leaderboard").innerHTML = `<li class="muted">${t("loadChainFail")}</li>`;
    $("recentList").innerHTML = `<li class="muted">${t("loadChainFail")}</li>`;
    $("topReferrers").innerHTML = `<li class="muted">${t("loadChainFail")}</li>`;
  }
}

// Re-render dynamic (JS-set) strings when the language changes.
// Static strings are handled by i18n.js applyI18n() before this event.
document.addEventListener("flameid-lang", () => {
  $("connectBtn").textContent = userAddress ? t("connected") : t("connectWallet");
  if (!$("inviteBox").classList.contains("hidden")) $("copyInviteBtn").textContent = t("copy");
  if (!userAddress) {
    $("myStreakEmpty").textContent = t("myStreakEmpty");
    $("genesisNote").textContent = t("genesisConnect");
  } else if (noAgentId) {
    $("myStreakEmpty").textContent = t("myStreakNoAgent");
  }
  if (myReferredAddr) {
    $("referrerLine").textContent = t("invitedBy", { addr: shortAddr(myReferredAddr) });
  }
  // Re-fill the agent prompt in the new language (applyI18n already
  // reset it to the new language's template).
  fillAgentPrompt();
  if (contract) {
    // Re-render in the new language: cached board first, live scan
    // only when the cache is missing or stale.
    loadBoardsFromCache().then((cached) => {
      if (!cached) { loadLeaderboardAndRecent(); loadTopReferrers(); }
    });
    loadStats();
    loadSeason();
    if (userAddress && !noAgentId) {
      loadMyStreak();
    } else {
      renderBadges(0, {});
      renderSpecialBadges({}, {}, false);
    }
  }
});

init();
