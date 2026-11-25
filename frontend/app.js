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
let noAgentId = false;
let myReferredAddr = null;

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

async function getLogsChunked(filter, fromBlock, toBlock) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_WINDOW) {
    const to = Math.min(from + LOG_WINDOW - 1, toBlock);
    try {
      const logs = await contract.queryFilter(filter, from, to);
      out.push(...logs);
    } catch (e) {
      console.warn(`getLogs ${from}-${to} failed:`, e.message);
    }
  }
  return out;
}

function readReferrerFromUrl() {
  const ref = new URLSearchParams(window.location.search).get("ref");
  if (ref && ethers.isAddress(ref)) return ethers.getAddress(ref);
  return ethers.ZeroAddress;
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

    $("statTopStreak").textContent = rows.length ? Math.max(...rows.map((r) => r.longest)) : 0;

    lb.innerHTML = rows.length
      ? rows.slice(0, 10).map((r, i) =>
          `<li>#${i + 1} <span class="addr">${shortAddr(r.addr)}</span>` +
          `<span class="num">${r.effective}🔥 ${t("lbBest", { n: r.longest })}</span></li>`).join("")
      : `<li class="muted">${t("noCheckIns")}</li>`;

    const last = events.slice(-10).reverse();
    recent.innerHTML = last.length
      ? last.map((ev) =>
          `<li><span class="addr">${shortAddr(ev.args.user)}</span> ` +
          `${t("checkedIn", { streak: Number(ev.args.currentStreak), date: dayToDate(ev.args.day) })}</li>`).join("")
      : `<li class="muted">${t("recentEmpty")}</li>`;
  } catch (e) {
    console.warn("loadLeaderboardAndRecent failed:", e.message);
    lb.innerHTML = `<li class="muted">${t("loadLbFail")}</li>`;
    recent.innerHTML = `<li class="muted">${t("loadRecentFail")}</li>`;
  }
}

async function loadTopReferrers() {
  const el = $("topReferrers");
  try {
    const latest = await readProvider.getBlockNumber();
    const from = DEPLOY_BLOCK > 0 ? DEPLOY_BLOCK : Math.max(0, latest - 200000);
    const events = await getLogsChunked(contract.filters.ReferralRecorded(), from, latest);
    const referrers = [...new Set(events.map((ev) => ev.args.referrer.toLowerCase()))];
    const counts = await Promise.all(
      referrers.map(async (r) => ({ addr: r, count: Number(await contract.referralCount(r)) }))
    );
    counts.sort((a, b) => b.count - a.count);
    el.innerHTML = counts.length
      ? counts.slice(0, 10).map((r, i) =>
          `<li>#${i + 1} <span class="addr">${shortAddr(r.addr)}</span>` +
          `<span class="num">${r.count} ${t("qualified")}</span></li>`).join("")
      : `<li class="muted">${t("noReferrals")}</li>`;
  } catch (e) {
    console.warn("loadTopReferrers failed:", e.message);
    el.innerHTML = `<li class="muted">${t("loadRefFail")}</li>`;
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
    const top3 = await contract.seasonTop3();
    $("seasonTop3").innerHTML = top3[0].map((a, i) => {
      const best = Number(top3[1][i]);
      return best > 0
        ? `<li>#${i + 1} <span class="addr">${shortAddr(a)}</span><span class="num">${t("top3Streak", { best })}</span></li>`
        : `<li>#${i + 1} <span class="muted">—</span></li>`;
    }).join("");
    if (userAddress) {
      const s = await contract.seasonOf(userAddress);
      $("mySeasonDays").textContent = Number(s[0]);
      $("mySeasonStreak").textContent = Number(s[1]);
      $("mySeasonBest").textContent = Number(s[2]);
      $("mySeasonClean").textContent = Number(s[4]);
    }
  } catch (e) {
    console.warn("loadSeason failed:", e.message);
    $("seasonTop3").innerHTML = `<li class="muted">${t("loadSeasonFail")}</li>`;
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

    // Referrer from ?ref= : only valid if it is not me and it already checked in.
    const ref = readReferrerFromUrl();
    if (ref !== ethers.ZeroAddress && ref.toLowerCase() !== userAddress.toLowerCase()) {
      try {
        const refStreak = await contract.streakOf(ref);
        if (Number(refStreak[4]) !== 0) myReferrer = ref;
      } catch (e) {
        console.warn("referrer check failed:", e.message);
      }
    }

    // Invite link.
    const link = `${window.location.origin}${window.location.pathname}?ref=${userAddress}`;
    $("inviteLink").textContent = link;
    $("inviteBox").classList.remove("hidden");
    $("inviteEmpty").classList.add("hidden");

    // Agent ID check.
    const registry = new ethers.Contract(
      REGISTRY_ADDRESS,
      ["function balanceOf(address) view returns (uint256)"],
      readProvider
    );
    const bal = await registry.balanceOf(userAddress);
    if (bal === 0n) {
      noAgentId = true;
      $("myStreakEmpty").textContent = t("myStreakNoAgent");
      renderBadges(0, {});
      return;
    }
    noAgentId = false;
    await loadMyStreak();
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
    await loadStats();
    await loadLeaderboardAndRecent();
    await loadTopReferrers();
    await loadSeason();
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
  if (contract) {
    loadStats();
    loadLeaderboardAndRecent();
    loadTopReferrers();
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
