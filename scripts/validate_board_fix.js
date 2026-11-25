const fs = require('fs');
const { ethers } = require('ethers');
const abi = JSON.parse(fs.readFileSync('/home/hatch/workspace/agent-daily-streak/frontend/abi.js', 'utf8').match(/\[[\s\S]*\]/)[0]);
const addr = '0xa68B69AF101E4262F651119c9830BfBd1603EC97';
const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.publicnode.com',
  'https://rpc.48.club',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let goodRpcIdx = 0;
function makeProvider(url) {
  const req = new ethers.FetchRequest(url);
  req.setHeader('User-Agent', UA);
  return new ethers.JsonRpcProvider(req, 56, { staticNetwork: true });
}
function contractOn(url) {
  return new ethers.Contract(addr, abi, makeProvider(url));
}
async function queryLogsFallback(filter, from, to) {
  for (let k = 0; k < RPCS.length; k++) {
    const idx = (goodRpcIdx + k) % RPCS.length;
    try {
      const logs = await contractOn(RPCS[idx]).queryFilter(filter, from, to);
      goodRpcIdx = idx;
      return logs;
    } catch (e) {
      console.log(`  chunk ${from}-${to} failed on ${RPCS[idx].split('/')[2]}: ${String(e.message || e).slice(0, 60)}`);
    }
  }
  throw new Error('All RPCs failed for getLogs');
}
(async () => {
  const probe = contractOn(RPCS[0]);
  const latest = await makeProvider(RPCS[0]).getBlockNumber();
  const from = 135604541;
  let events = [];
  for (let s = from; s <= latest; s += 4000) {
    events = events.concat(await queryLogsFallback(probe.filters.CheckedIn(), s, Math.min(s + 3999, latest)));
    await sleep(200);
  }
  console.log('events:', events.length, '| first-good RPC:', RPCS[goodRpcIdx]);
  const today = Math.floor(Date.now() / 1000 / 86400);
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
  const rows = [...byAddr.entries()].map(([a, s]) => ({
    addr: a, effective: s.lastDay >= today - 1 ? s.lastStreak : 0, longest: s.longest, total: s.total, lastDay: s.lastDay,
  }));
  rows.sort((x, y) => y.effective - x.effective || y.longest - x.longest || y.total - x.total);
  // Simulate a connected user: pick the 40th wallet in event order (mid-pack).
  const sampleUser = [...byAddr.keys()][39];
  const c = contractOn(RPCS[goodRpcIdx]);
  const s = await c.streakOf(sampleUser);
  const myTotal = Number(s[2]);
  const live = { addr: sampleUser, effective: Number(s[3]) >= today - 1 ? Number(s[0]) : 0, longest: Number(s[1]), total: myTotal, lastDay: Number(s[3]) };
  const i = rows.findIndex((r) => r.addr === sampleUser);
  if (i >= 0) rows[i] = { ...rows[i], ...live }; else rows.push(live);
  rows.sort((x, y) => y.effective - x.effective || y.longest - x.longest || y.total - x.total);
  const scored = [];
  for (let j = 0; j < rows.length; j += 5) {
    scored.push(...await Promise.all(rows.slice(j, j + 5).map(async (r) => ({ ...r, score: Number(await c.scoreOf(r.addr)) }))));
    await sleep(200);
  }
  scored.sort((x, y) => y.score - x.score || y.longest - x.longest || y.total - x.total);
  console.log('leaderboard rows:', rows.length, '| top 10 by score:');
  scored.slice(0, 10).forEach((r, k) => console.log(' #' + (k + 1), r.addr.slice(0, 10) + '…', r.score, 'pts'));
  const myIdx = scored.findIndex((r) => r.addr === sampleUser);
  console.log('sample user', sampleUser.slice(0, 10) + '…', '-> rank #' + (myIdx + 1), 'score', scored[myIdx].score, '| total check-ins', myTotal);
})().catch((e) => console.log('ERR', String(e).slice(0, 200)));
