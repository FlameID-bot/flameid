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
function contractOn(url) { return new ethers.Contract(addr, abi, makeProvider(url)); }
async function queryLogsFallback(filter, from, to) {
  for (let k = 0; k < RPCS.length; k++) {
    const idx = (goodRpcIdx + k) % RPCS.length;
    try {
      const logs = await contractOn(RPCS[idx]).queryFilter(filter, from, to);
      goodRpcIdx = idx;
      return logs;
    } catch (e) { /* next RPC */ }
  }
  throw new Error('All RPCs failed for getLogs');
}
(async () => {
  const latest = await makeProvider(RPCS[0]).getBlockNumber();
  let events = [];
  for (let s = 135604541; s <= latest; s += 4000) {
    events = events.concat(await queryLogsFallback(contractOn(RPCS[0]).filters.ReferralRecorded(), s, Math.min(s + 3999, latest)));
    await sleep(200);
  }
  console.log('ReferralRecorded events:', events.length, '| via:', RPCS[goodRpcIdx].split('/')[2]);
  const invited = new Map();
  for (const ev of events) {
    const r = ev.args.referrer.toLowerCase();
    invited.set(r, (invited.get(r) || 0) + 1);
  }
  const referrers = [...invited.keys()];
  const c = contractOn(RPCS[goodRpcIdx]);
  const counts = [];
  for (let i = 0; i < referrers.length; i += 5) {
    counts.push(...await Promise.all(referrers.slice(i, i + 5).map(async (r) => ({
      addr: r, count: Number(await c.referralCount(r)), invited: invited.get(r) || 0,
    }))));
    await sleep(200);
  }
  // Simulate connected user = first referrer in event order.
  const sampleUser = referrers[0];
  const myQualified = Number(await c.referralCount(sampleUser));
  const myInvited = invited.get(sampleUser) || 0;
  if (myQualified > 0 || myInvited > 0) {
    const i = counts.findIndex((r) => r.addr === sampleUser);
    if (i >= 0) counts[i] = { addr: sampleUser, count: myQualified, invited: myInvited };
    else counts.push({ addr: sampleUser, count: myQualified, invited: myInvited });
  }
  counts.sort((a, b) => b.count - a.count || b.invited - a.invited);
  console.log('referrers:', counts.length);
  counts.slice(0, 10).forEach((r, i) => {
    const pending = r.invited > r.count ? ` · ${r.invited - r.count} pending` : '';
    console.log('#' + (i + 1), r.addr.slice(0, 10) + '…', r.count, 'qualified' + pending);
  });
  const myIdx = counts.findIndex((r) => r.addr === sampleUser);
  console.log('sample user', sampleUser.slice(0, 10) + '…', '-> referral rank #' + (myIdx + 1), '| qualified', myQualified, '| invited', myInvited);
})().catch((e) => console.log('ERR', String(e).slice(0, 200)));
