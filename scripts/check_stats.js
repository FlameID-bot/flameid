#!/usr/bin/env node
// Read live FlameID counters (and one wallet's streak) from BSC.
// Usage: node scripts/check_stats.js [wallet-address]
// The contract address is read from frontend/app.js (CONTRACT_ADDRESS).
// Exits non-zero if the contract is not deployed yet.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
  "https://rpc.48.club",
];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function pickProvider() {
  for (const url of RPCS) {
    try {
      const req = new ethers.FetchRequest(url);
      req.setHeader("User-Agent", UA);
      req.timeout = 15000;
      const p = new ethers.JsonRpcProvider(req);
      await p.getBlockNumber();
      return p;
    } catch (e) {
      console.warn("RPC failed:", url);
    }
  }
  throw new Error("no working RPC");
}

async function main() {
  const appJs = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "app.js"),
    "utf8"
  );
  const m = appJs.match(/const CONTRACT_ADDRESS = "(0x[0-9a-fA-F]{40})"/);
  const address = m && m[1];
  if (!address || address === ethers.ZeroAddress) {
    console.log("Contract not deployed yet (CONTRACT_ADDRESS is still the zero address).");
    process.exit(2);
  }
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "FlameID.json"), "utf8")
  );
  const provider = await pickProvider();
  const c = new ethers.Contract(address, artifact.abi, provider);
  const [streakers, checkIns, badges, day, seasonEnd, genesisDeadline, seasonOn] = await Promise.all([
    c.totalStreakers(),
    c.totalCheckIns(),
    c.totalBadges(),
    c.currentDay(),
    c.SEASON_END(),
    c.GENESIS_DEADLINE(),
    c.seasonActive(),
  ]);
  console.log(`contract: ${address}`);
  console.log(`currentDay (UTC): ${day}`);
  console.log(`totalStreakers: ${streakers}`);
  console.log(`totalCheckIns: ${checkIns}`);
  console.log(`totalBadges: ${badges}`);
  console.log(`seasonActive: ${seasonOn} (SEASON_END ${seasonEnd} = ${new Date(Number(seasonEnd) * 1000).toISOString()})`);
  console.log(`GENESIS_DEADLINE: ${genesisDeadline} = ${new Date(Number(genesisDeadline) * 1000).toISOString()}`);
  const top3 = await c.seasonTop3();
  console.log(`seasonTop3: ${top3[0].map((a, i) => `${a} (${top3[1][i]})`).join(", ")}`);

  const wallet = process.argv[2];
  if (wallet) {
    const a = ethers.getAddress(wallet);
    const s = await c.streakOf(a);
    console.log(`\nwallet ${a}:`);
    console.log(`  currentStreak: ${s[0]}, longestStreak: ${s[1]}, totalCheckIns: ${s[2]}`);
    console.log(`  lastCheckInDay: ${s[3]}, firstCheckInDay: ${s[4]}`);
    console.log(`  canCheckInToday: ${await c.canCheckInToday(a)}`);
    console.log(`  shields: ${await c.shields(a)}`);
    console.log(`  referralCount: ${await c.referralCount(a)}`);
    console.log(`  referredBy: ${await c.referredBy(a)}`);
    console.log(`  scoreOf: ${await c.scoreOf(a)} (max 140)`);
    console.log(`  isActiveAgent(minScore 0): ${await c.isActiveAgent(a, 0)}`);
    for (const ms of [7, 14, 30, 60, 100]) {
      console.log(`  badge ${ms}: ${await c.hasBadge(a, ms)} (token ${await c.badgeTokenOf(a, ms)})`);
    }
    console.log(`  genesis: ${await c.hasGenesis(a)}`);
    for (const [kind, label] of [[2, "Survivor"], [3, "Champion"]]) {
      console.log(`  ${label}: ${await c.hasSpecialBadge(a, kind)} (token ${await c.specialBadgeTokenOf(a, kind)})`);
    }
    const ss = await c.seasonOf(a);
    console.log(`  season: checkInDays ${ss[0]}, currentStreak ${ss[1]}, bestStreak ${ss[2]}, currentCleanStreak ${ss[3]}, bestCleanStreak ${ss[4]}, lastCheckInDay ${ss[5]}`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
