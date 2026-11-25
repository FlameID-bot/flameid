#!/usr/bin/env node
// Test the NEW FlameID features (Genesis badge, reputation score +
// API gate, Season 1) on a FRESH local Hardhat node + FRESH deploy.
// Kept separate from test/test.js on purpose: the Genesis window (7 days
// from deploy) and the Season 1 end (2026-12-09 08:00 UTC) are absolute
// timestamps, so these tests need their own timeline starting at deploy.
// Run after test/test.js, with a restarted node:
//   npx hardhat node --port 8545   # in a separate terminal
//   node test/test.js && node test/test2.js   (restart the node between runs,
//   or run test2.js first — the two files are independent)
//
// Timeline (day 0 = deploy day, aligned to 12:00 UTC, real date 2026-11-25):
//   day 0-2   Genesis claims + referral/shield setup
//   day 0-6   A builds a 7-day clean run -> Survivor
//   day 7-8   G reaches streak 7 with clean run stuck at 4 (shield save)
//   day 8     Genesis window closed (deploy + 8 days)
//   day 8-12  C/D/E build season streaks -> top 3 forms
//   day 15    Season 1 over (past 2026-12-09 08:00 UTC) -> Champion claims
//   day 15-65 F builds a 51-day streak -> score caps
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = "http://127.0.0.1:8545";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const ZERO = ethers.ZeroAddress;
const SEASON_END_EXPECTED = 1796803200; // 2026-12-09 08:00:00 UTC

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra}`);
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const chainId = (await provider.getNetwork()).chainId;
  console.log(`connected to local node, chainId=${chainId}`);

  const buildDir = path.join(__dirname, "..", "build");
  const mainArtifact = JSON.parse(
    fs.readFileSync(path.join(buildDir, "FlameID.json"), "utf8")
  );
  const mockArtifact = JSON.parse(
    fs.readFileSync(path.join(buildDir, "MockAgentID.json"), "utf8")
  );

  const signers = [];
  for (let i = 0; i < 20; i++) signers.push(await provider.getSigner(i));
  const addr = {};
  const names = [
    "deployer", "P", "Q", "R", "S", "T", "A", "B", "C", "D",
    "E", "F", "G", "H", "nonHolder", "J", "K", "L", "M", "N",
  ];
  for (let i = 0; i < names.length; i++) {
    addr[names[i]] = await signers[i].getAddress();
  }
  const as = {};
  names.forEach((n, i) => { as[n] = signers[i]; });

  // 1. Deploy mock registry, inject its code at the real registry address.
  const MockFactory = new ethers.ContractFactory(
    mockArtifact.abi,
    mockArtifact.bytecode,
    signers[0]
  );
  const mock = await MockFactory.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  const mockCode = await provider.getCode(mockAddr);
  await provider.send("hardhat_setCode", [REGISTRY, mockCode]);
  const injectedCode = await provider.getCode(REGISTRY);
  check("mock code injected at real registry address", injectedCode === mockCode);

  const registry = new ethers.Contract(REGISTRY, mockArtifact.abi, provider);

  async function setHolder(a, value) {
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [a, 0])
    );
    const val = ethers.zeroPadValue(ethers.toBeHex(value), 32);
    await provider.send("hardhat_setStorageAt", [REGISTRY, slot, val]);
    for (let i = 0; i < 10; i++) {
      if ((await registry.balanceOf(a)) === BigInt(value)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`setHolder failed: balanceOf(${a}) != ${value}`);
  }
  for (const n of names) {
    if (n === "deployer" || n === "nonHolder") continue;
    await setHolder(addr[n], 1);
  }
  check("registry.balanceOf(P) == 1", (await registry.balanceOf(addr.P)) === 1n);

  // 2. Deploy FlameID (fresh timeline for Genesis + Season 1).
  const Factory = new ethers.ContractFactory(
    mainArtifact.abi,
    mainArtifact.bytecode,
    signers[0]
  );
  const contract = await Factory.deploy();
  const deployReceipt = await contract.deploymentTransaction().wait();
  const deployBlock = await provider.getBlock(deployReceipt.blockNumber);
  const deployTs = Number(deployBlock.timestamp);
  console.log(`FlameID deployed at ${await contract.getAddress()}`);
  console.log(`deploy gas used: ${deployReceipt.gasUsed}`);
  console.log(`deploy timestamp: ${deployTs} (${new Date(deployTs * 1000).toISOString()})`);
  check("SEASON_END == 2026-12-09 08:00 UTC (1796803200)", (await contract.SEASON_END()) === BigInt(SEASON_END_EXPECTED));
  check("SEASON_START == deploy timestamp", Number(await contract.SEASON_START()) === deployTs);
  check("GENESIS_DEADLINE == deploy + 7 days", Number(await contract.GENESIS_DEADLINE()) === deployTs + 7 * 86400);
  check("GENESIS_KIND == 1", (await contract.GENESIS_KIND()) === 1n);
  check("SURVIVOR_KIND == 2", (await contract.SURVIVOR_KIND()) === 2n);
  check("CHAMPION_KIND == 3", (await contract.CHAMPION_KIND()) === 3n);
  check("seasonActive() == true right after deploy", (await contract.seasonActive()) === true);

  // Time helpers: align to 12:00 UTC, then advance whole days.
  async function currentDay() {
    return Number(await contract.currentDay());
  }
  async function alignToNoon() {
    const block = await provider.getBlock("latest");
    const ts = Number(block.timestamp);
    const dayStart = Math.floor(ts / 86400) * 86400;
    let toNoon = dayStart + 12 * 3600 - ts;
    if (toNoon <= 60) toNoon += 86400;
    await provider.send("evm_increaseTime", [toNoon]);
    await provider.send("evm_mine", []);
  }
  async function advanceDays(n) {
    const before = await currentDay();
    await provider.send("evm_increaseTime", [n * 86400]);
    await provider.send("evm_mine", []);
    const after = await currentDay();
    if (after !== before + n) {
      throw new Error(`advanceDays(${n}) moved day ${before} -> ${after}, expected ${before + n}`);
    }
  }
  await alignToNoon();
  const day0 = await currentDay();
  console.log(`aligned to noon UTC, currentDay=${day0} (day 0)`);

  async function expectRevert(promiseFn) {
    try {
      await (await promiseFn()).wait();
      return false;
    } catch (e) {
      return true;
    }
  }
  async function checkIn(signerName, referrer = ZERO) {
    const c = contract.connect(as[signerName]);
    const tx = await c.checkIn(referrer, { gasLimit: 500000 });
    return tx.wait();
  }
  async function streakOf(name) {
    const s = await contract.streakOf(addr[name]);
    return {
      current: Number(s[0]),
      longest: Number(s[1]),
      total: Number(s[2]),
      lastDay: Number(s[3]),
      firstDay: Number(s[4]),
    };
  }
  async function seasonOf(name) {
    const s = await contract.seasonOf(addr[name]);
    return {
      days: Number(s[0]),
      current: Number(s[1]),
      best: Number(s[2]),
      currentClean: Number(s[3]),
      bestClean: Number(s[4]),
      lastDay: Number(s[5]),
    };
  }
  async function claimGenesis(name, opts = {}) {
    const tx = await contract.connect(as[name]).claimGenesis({ gasLimit: 500000, ...opts });
    return tx.wait();
  }
  async function claimSurvivor(name, opts = {}) {
    const tx = await contract.connect(as[name]).claimSurvivor({ gasLimit: 500000, ...opts });
    return tx.wait();
  }
  async function claimChampion(name, opts = {}) {
    const tx = await contract.connect(as[name]).claimChampion({ gasLimit: 500000, ...opts });
    return tx.wait();
  }

  // 3. Genesis badge — day 0.
  console.log("\n-- Genesis badge (day 0) --");
  check(
    "claimGenesis before any check-in reverts (GenesisRequiresCheckIn)",
    await expectRevert(() => contract.connect(as.S).claimGenesis())
  );
  check(
    "non-holder claimGenesis reverts (NotAgentIDHolder)",
    await expectRevert(() => contract.connect(as.nonHolder).claimGenesis())
  );
  let rc = await checkIn("P");
  console.log(`  first checkIn (with season tracking) gas used: ${rc.gasUsed}`);
  rc = await claimGenesis("P");
  console.log(`  claimGenesis gas used: ${rc.gasUsed}`);
  check("hasSpecialBadge(P, 1 Genesis) == true", (await contract.hasSpecialBadge(addr.P, 1)) === true);
  check("specialBadgeTokenOf(P, 1) == 1", (await contract.specialBadgeTokenOf(addr.P, 1)) === 1n);
  check("badgeKindOf(1) == 1 (Genesis)", (await contract.badgeKindOf(1)) === 1n);
  check("totalBadges == 1 (Genesis counts)", (await contract.totalBadges()) === 1n);
  check(
    "claimGenesis with value reverts (non-payable)",
    await expectRevert(() =>
      contract.connect(as.P).claimGenesis({ value: ethers.parseEther("0.001") })
    )
  );
  check(
    "second claimGenesis reverts (BadgeAlreadyClaimed)",
    await expectRevert(() => contract.connect(as.P).claimGenesis())
  );
  const genesisUri = await contract.tokenURI(1);
  const genesisMeta = JSON.parse(
    Buffer.from(genesisUri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
  );
  check("Genesis metadata name mentions Genesis Badge", typeof genesisMeta.name === "string" && genesisMeta.name.includes("Genesis Badge"));
  const genesisSvg = Buffer.from(genesisMeta.image.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
  check("Genesis SVG contains GENESIS", genesisSvg.includes("GENESIS"));
  check("Genesis SVG contains FIRST WEEK", genesisSvg.includes("FIRST WEEK"));
  check(
    "Genesis token transfer reverts (Soulbound)",
    await expectRevert(() => contract.connect(as.P).transferFrom(addr.P, addr.Q, 1))
  );
  check("ownerOf(1) == P", (await contract.ownerOf(1)).toLowerCase() === addr.P.toLowerCase());

  // Day-0 check-ins for the referral / season setup.
  await checkIn("Q"); // Q will try to claim Genesis after the window closes.
  await checkIn("R", addr.P); // R referred by P.
  await checkIn("G"); // G refers H below.
  await checkIn("H", addr.G); // H referred by G.
  await checkIn("A"); // A starts the 7-day Survivor run.
  await checkIn("B"); // B stops at a 3-day streak.

  // 4. Days 1-2: referrals qualify (streak 3), shields earned.
  console.log("\n-- days 1-2: referrals qualify --");
  await advanceDays(1);
  await checkIn("P");
  await checkIn("R");
  await checkIn("G");
  await checkIn("H");
  await checkIn("A");
  await checkIn("B");
  await advanceDays(1);
  await checkIn("P"); // P streak 3
  await checkIn("R"); // R streak 3 -> P earns a shield
  await checkIn("G"); // G streak 3
  await checkIn("H"); // H streak 3 -> G earns a shield
  await checkIn("A"); // A streak 3
  await checkIn("B"); // B streak 3 (stops here)
  check("shields(P) == 1 after R qualifies", (await contract.shields(addr.P)) === 1n);
  check("referralCount(P) == 1", (await contract.referralCount(addr.P)) === 1n);
  check("shields(G) == 1 after H qualifies", (await contract.shields(addr.G)) === 1n);
  check("referralCount(G) == 1", (await contract.referralCount(addr.G)) === 1n);
  check(
    "claimSurvivor(B) reverts (bestClean 3 < 7)",
    await expectRevert(() => contract.connect(as.B).claimSurvivor())
  );

  // 5. Days 3-6: A completes a 7-day clean run; G's shield saves a streak
  //    but breaks the clean run.
  console.log("\n-- days 3-6: Survivor run (A) + shield vs clean run (G) --");
  await advanceDays(1); // day 3
  await checkIn("A"); // A streak 4
  await checkIn("G"); // G streak 4
  // Day 4: G misses a day; A keeps going.
  await advanceDays(1); // day 4
  await checkIn("A"); // A streak 5
  // Day 5: G checks in after exactly one missed day -> shield saves streak.
  await advanceDays(1); // day 5
  await checkIn("A"); // A streak 6
  rc = await checkIn("G"); // gap 2, shield used, streak stays 4
  let g = await streakOf("G");
  check("G currentStreak kept at 4 after shield use", g.current === 4);
  check("shields(G) == 0 after shield spent", (await contract.shields(addr.G)) === 0n);
  let gs = await seasonOf("G");
  check("G season bestStreak == 4", gs.best === 4);
  check("G season bestCleanStreak == 4 (from the day 0-3 run)", gs.bestClean === 4);
  check("G season currentCleanStreak == 1 (shield broke the clean run)", gs.currentClean === 1);
  // Day 6: A completes day 7; G grows to streak 5, clean run 2.
  await advanceDays(1); // day 6
  await checkIn("A"); // A streak 7
  await checkIn("G"); // G streak 5, clean 2
  gs = await seasonOf("G");
  check("G season bestStreak == 5 after day 6", gs.best === 5);
  check("G season bestCleanStreak still 4", gs.bestClean === 4);
  check("G season currentCleanStreak == 2", gs.currentClean === 2);
  let a = await streakOf("A");
  check("A currentStreak == 7", a.current === 7);
  const aSeason6 = await seasonOf("A");
  check("A season checkInDays == 7", aSeason6.days === 7);
  check("A season bestStreak == 7", aSeason6.best === 7);
  check("A season bestCleanStreak == 7", aSeason6.bestClean === 7);
  rc = await claimSurvivor("A");
  console.log(`  claimSurvivor gas used: ${rc.gasUsed}`);
  check("hasSpecialBadge(A, 2 Survivor) == true", (await contract.hasSpecialBadge(addr.A, 2)) === true);
  check("specialBadgeTokenOf(A, 2) == 2", (await contract.specialBadgeTokenOf(addr.A, 2)) === 2n);
  check("badgeKindOf(2) == 2 (Survivor)", (await contract.badgeKindOf(2)) === 2n);
  const survUri = await contract.tokenURI(2);
  const survMeta = JSON.parse(
    Buffer.from(survUri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
  );
  check("Survivor metadata name mentions Survivor Badge", typeof survMeta.name === "string" && survMeta.name.includes("Survivor Badge"));
  const survSvg = Buffer.from(survMeta.image.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
  check("Survivor SVG contains 7/7", survSvg.includes("7/7"));
  check(
    "second claimSurvivor reverts (BadgeAlreadyClaimed)",
    await expectRevert(() => contract.connect(as.A).claimSurvivor())
  );
  // Top 3 after day 6: A(7), G(5), then a 3-streak wallet (P first).
  const top3d6 = await contract.seasonTop3();
  check(
    "seasonTop3 after day 6: [A(7), G(5), P(3)]",
    top3d6[0][0].toLowerCase() === addr.A.toLowerCase() &&
      top3d6[0][1].toLowerCase() === addr.G.toLowerCase() &&
      Number(top3d6[1][0]) === 7 && Number(top3d6[1][1]) === 5 && Number(top3d6[1][2]) === 3
  );

  // 6. Days 7-8: G keeps checking in — streak 7, but the clean run never
  //    recovers past 4, so Survivor stays out of reach despite a 7-streak.
  //    Genesis window closes at the end of day 7 (deploy + 7 days).
  console.log("\n-- days 7-8: G reaches streak 7, clean run stuck at 4; Genesis window closes --");
  await advanceDays(1); // day 7
  await checkIn("G"); // G streak 6, clean 3
  await advanceDays(1); // day 8
  await checkIn("G"); // G streak 7, clean 4
  gs = await seasonOf("G");
  check("G season bestStreak == 7", gs.best === 7);
  check("G season bestCleanStreak == 4 (shield save does not count as clean)", gs.bestClean === 4);
  check(
    "claimSurvivor(G) reverts (bestClean 4 < 7 despite bestStreak 7)",
    await expectRevert(() => contract.connect(as.G).claimSurvivor())
  );
  check(
    "Q claimGenesis after window reverts (GenesisWindowClosed)",
    await expectRevert(() => contract.connect(as.Q).claimGenesis())
  );
  await checkIn("T"); // T checks in after the window
  check(
    "T claimGenesis after window reverts (GenesisWindowClosed)",
    await expectRevert(() => contract.connect(as.T).claimGenesis())
  );
  check("hasSpecialBadge(Q, 1) == false", (await contract.hasSpecialBadge(addr.Q, 1)) === false);
  // C, D, E start their season runs (day 8).
  await checkIn("C");
  await checkIn("D");
  await checkIn("E");

  // 7. Days 9-12: C builds a 5-day streak, D 3 days, E 2 days.
  console.log("\n-- days 9-12: season runs (C/D/E) --");
  await advanceDays(1); // day 9
  await checkIn("C");
  await checkIn("D");
  await checkIn("E");
  await advanceDays(1); // day 10
  await checkIn("C");
  await checkIn("D");
  await advanceDays(1); // day 11
  await checkIn("C");
  await advanceDays(1); // day 12
  await checkIn("C"); // C best 5
  const cs = await seasonOf("C");
  check("C season bestStreak == 5", cs.best === 5);
  check("C season checkInDays == 5", cs.days === 5);
  const ds = await seasonOf("D");
  check("D season bestStreak == 3", ds.best === 3);
  // Top 3: A(7, first), G(7), C(5) — G tied A at 7 but A got there first.
  const top3d12 = await contract.seasonTop3();
  check(
    "seasonTop3 after day 12: [A(7), G(7), C(5)]",
    top3d12[0][0].toLowerCase() === addr.A.toLowerCase() &&
      top3d12[0][1].toLowerCase() === addr.G.toLowerCase() &&
      top3d12[0][2].toLowerCase() === addr.C.toLowerCase() &&
      Number(top3d12[1][0]) === 7 && Number(top3d12[1][1]) === 7 && Number(top3d12[1][2]) === 5
  );
  check(
    "claimChampion before season end reverts (SeasonNotOver)",
    await expectRevert(() => contract.connect(as.A).claimChampion())
  );

  // 8. Day 15: season is over (past 2026-12-09 08:00 UTC).
  console.log("\n-- day 15: season over --");
  await advanceDays(3); // day 15
  check("seasonActive() == false after SEASON_END", (await contract.seasonActive()) === false);
  // Regular check-ins still work, but season state freezes.
  await checkIn("A"); // A streak resets to 1 (gap from day 6); season frozen.
  const aSeason = await seasonOf("A");
  check("A season checkInDays still 7 after season end", aSeason.days === 7);
  check("A season bestStreak still 7 after season end", aSeason.best === 7);
  check("A season bestCleanStreak still 7 after season end", aSeason.bestClean === 7);
  const top3end = await contract.seasonTop3();
  check(
    "seasonTop3 frozen at [A(7), G(7), C(5)]",
    top3end[0][0].toLowerCase() === addr.A.toLowerCase() &&
      top3end[0][1].toLowerCase() === addr.G.toLowerCase() &&
      top3end[0][2].toLowerCase() === addr.C.toLowerCase()
  );

  // 9. Champion claims (after season end).
  console.log("\n-- Champion claims --");
  rc = await claimChampion("A");
  console.log(`  claimChampion gas used: ${rc.gasUsed}`);
  check("hasSpecialBadge(A, 3 Champion) == true", (await contract.hasSpecialBadge(addr.A, 3)) === true);
  check("specialBadgeTokenOf(A, 3) == 3", (await contract.specialBadgeTokenOf(addr.A, 3)) === 3n);
  check("badgeKindOf(3) == 3 (Champion)", (await contract.badgeKindOf(3)) === 3n);
  const champUri = await contract.tokenURI(3);
  const champMeta = JSON.parse(
    Buffer.from(champUri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
  );
  check("Champion metadata name mentions Champion Badge", typeof champMeta.name === "string" && champMeta.name.includes("Champion Badge"));
  const champSvg = Buffer.from(champMeta.image.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
  check("Champion SVG contains TOP 3", champSvg.includes("TOP 3"));
  await claimChampion("G");
  check("G claims Champion (top 3)", (await contract.hasSpecialBadge(addr.G, 3)) === true);
  await claimChampion("C");
  check("C claims Champion (top 3)", (await contract.hasSpecialBadge(addr.C, 3)) === true);
  check(
    "D claimChampion reverts (NotSeasonTop3, best 3 is 4th)",
    await expectRevert(() => contract.connect(as.D).claimChampion())
  );
  check(
    "E claimChampion reverts (NotSeasonTop3)",
    await expectRevert(() => contract.connect(as.E).claimChampion())
  );
  check(
    "second claimChampion reverts (BadgeAlreadyClaimed)",
    await expectRevert(() => contract.connect(as.A).claimChampion())
  );
  check(
    "non-holder claimChampion reverts (NotAgentIDHolder)",
    await expectRevert(() => contract.connect(as.nonHolder).claimChampion())
  );
  check("totalBadges == 5 (Genesis + Survivor + 3 Champion)", (await contract.totalBadges()) === 5n);

  // 10. Reputation score + isActiveAgent (day 15).
  console.log("\n-- scoreOf / isActiveAgent (day 15) --");
  const fresh = ethers.Wallet.createRandom().address;
  check("scoreOf(fresh) == 0", (await contract.scoreOf(fresh)) === 0n);
  check("isActiveAgent(fresh, 0) == false", (await contract.isActiveAgent(fresh, 0)) === false);
  const dayNow = await currentDay();
  async function expectedScore(name) {
    const s = await streakOf(name);
    const refs = Number(await contract.referralCount(addr[name]));
    const sh = Number(await contract.shields(addr[name]));
    const age = s.firstDay === 0 ? 0 : dayNow - s.firstDay;
    return (
      Math.min(s.current, 50) +
      Math.min(s.total, 30) +
      Math.min(refs, 30) +
      Math.min(age, 20) +
      Math.min(sh, 10)
    );
  }
  const expA = await expectedScore("A");
  check(
    `scoreOf(A) == ${expA} (1 streak + 8 check-ins + 0 ref + 15 age + 0 shields)`,
    Number(await contract.scoreOf(addr.A)) === expA && expA === 24
  );
  const expP = await expectedScore("P");
  check(
    `scoreOf(P) == ${expP} (3 streak + 3 check-ins + 1 ref + 15 age + 1 shield)`,
    Number(await contract.scoreOf(addr.P)) === expP && expP === 23
  );
  check("isActiveAgent(A, 20) == true (checked in today, score 24)", (await contract.isActiveAgent(addr.A, 20)) === true);
  check("isActiveAgent(A, 25) == false (score 24 < 25)", (await contract.isActiveAgent(addr.A, 25)) === false);
  check("isActiveAgent(B, 0) == false (last check-in 13 days ago)", (await contract.isActiveAgent(addr.B, 0)) === false);
  check("isActiveAgent(P, 0) == false (last check-in 13 days ago)", (await contract.isActiveAgent(addr.P, 0)) === false);

  // 11. Score caps: F builds a 51-day streak (days 15-65).
  console.log("\n-- score caps (F, 51-day streak) --");
  await checkIn("F"); // day 15
  for (let d = 0; d < 50; d++) {
    await advanceDays(1);
    await checkIn("F");
  }
  const f = await streakOf("F");
  check("F currentStreak == 51", f.current === 51);
  check("F longestStreak == 51", f.longest === 51);
  check("F totalCheckIns == 51", f.total === 51);
  check(
    "scoreOf(F) == 100 (streak capped 50 + check-ins capped 30 + age capped 20)",
    Number(await contract.scoreOf(addr.F)) === 100
  );
  check("isActiveAgent(F, 100) == true", (await contract.isActiveAgent(addr.F, 100)) === true);
  check("isActiveAgent(F, 101) == false", (await contract.isActiveAgent(addr.F, 101)) === false);
  // F's check-ins happened after the season ended: no season state.
  const fSeason = await seasonOf("F");
  check("F season checkInDays == 0 (checked in after season end)", fSeason.days === 0);
  check("F season bestStreak == 0", fSeason.best === 0);
  // Milestone badge from the long streak still works.
  await contract.connect(as.F).claimBadge(30, { gasLimit: 500000 });
  check("F claims milestone badge 30 from longest streak 51", (await contract.hasBadge(addr.F, 30)) === true);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("TEST SCRIPT ERROR:", e);
  process.exit(1);
});
