const fs = require('fs');
const { ethers } = require('ethers');
const abi = JSON.parse(fs.readFileSync('/home/hatch/workspace/agent-daily-streak/frontend/abi.js', 'utf8').match(/\[[\s\S]*\]/)[0]);
const addr = '0xa68B69AF101E4262F651119c9830BfBd1603EC97';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const req = new ethers.FetchRequest('https://bsc-dataseed1.binance.org');
  req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  const p = new ethers.JsonRpcProvider(req, 56, { staticNetwork: true });
  const c = new ethers.Contract(addr, abi, p);
  const latest = await p.getBlockNumber();
  const from = 135604541;
  let events = [];
  for (let s = from; s <= latest; s += 4000) {
    const e = await c.queryFilter(c.filters.CheckedIn(), s, Math.min(s + 3999, latest));
    events = events.concat(e);
    await sleep(200);
  }
  const byAddr = new Map();
  for (const ev of events) {
    const a = ev.args.user.toLowerCase();
    const cur = byAddr.get(a) || { longest: 0, total: 0 };
    cur.longest = Math.max(cur.longest, Number(ev.args.currentStreak)); cur.total += 1;
    byAddr.set(a, cur);
  }
  const rows = [...byAddr.entries()].map(([a, s]) => ({ addr: a, ...s }));
  const scored = [];
  for (let i = 0; i < rows.length; i += 5) {
    const batch = await Promise.all(rows.slice(i, i + 5).map(async (r) => ({
      ...r, score: Number(await c.scoreOf(r.addr)),
    })));
    scored.push(...batch);
    await sleep(200);
  }
  scored.sort((x, y) => y.score - x.score || y.longest - x.longest || y.total - x.total);
  console.log('wallets:', scored.length, '| events:', events.length);
  scored.slice(0, 10).forEach((r, i) => console.log('#' + (i + 1), r.addr.slice(0, 10) + '…', r.score, 'pts · best', r.longest, 'd · total', r.total));
})().catch((e) => console.log('ERR', String(e).slice(0, 200)));
