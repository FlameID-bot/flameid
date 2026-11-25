#!/usr/bin/env node
// Test FlameID on a local Hardhat node (chain 31337).
// The contract hardcodes the real SPACE ID Agent ID registry address, which
// has no code on a local chain. The test therefore:
//   1. deploys MockAgentID (test-only, balanceOf only),
//   2. injects its runtime bytecode at the real registry address via
//      hardhat_setCode,
//   3. sets balances directly in storage via hardhat_setStorageAt
//      (mapping(address => uint256) at slot 0).
// Days are UTC days (block.timestamp / 86400). The test aligns the chain
// to 12:00 UTC first, then advances exactly 86400 seconds per day, so no
// day-boundary flake can occur mid-run.
// No real private key is used: Hardhat's unlocked test accounts sign locally.
// Prerequisite: `npx hardhat node` running on http://127.0.0.1:8545
// Run: node test/test.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = "http://127.0.0.1:8545";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const ZERO = ethers.ZeroAddress;

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

  // Signers: Hardhat unlocked test accounts.
  const signers = [];
  for (let i = 0; i < 20; i++) signers.push(await provider.getSigner(i));
  const addr = {};
  const names = [
    "deployer", "A", "B", "C", "D", "E", "F", "G", "G1", "G2",
    "G3", "G4", "H", "I", "nonHolder", "K", "L", "M", "N", "W",
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
  console.log(`MockAgentID deployed at ${mockAddr}`);
  await provider.send("hardhat_setCode", [REGISTRY, mockCode]);
  const injectedCode = await provider.getCode(REGISTRY);
  check("mock code injected at real registry address", injectedCode === mockCode);

  const registry = new ethers.Contract(REGISTRY, mockArtifact.abi, provider);

  // Helper: set a holder balance directly in registry storage (slot 0 mapping).
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
  // Everyone except nonHolder holds an Agent ID.
  for (const n of names) {
    if (n === "deployer" || n === "nonHolder") continue;
    await setHolder(addr[n], 1);
  }
  check(
    "registry.balanceOf(A) == 1",
    (await registry.balanceOf(addr.A)) === 1n
  );
  check(
    "registry.balanceOf(nonHolder) == 0",
    (await registry.balanceOf(addr.nonHolder)) === 0n
  );

  // 2. Deploy FlameID (no constructor args).
  const Factory = new ethers.ContractFactory(
    mainArtifact.abi,
    mainArtifact.bytecode,
    signers[0]
  );
  const contract = await Factory.deploy();
  const deployReceipt = await contract.deploymentTransaction().wait();
  const contractAddr = await contract.getAddress();
  console.log(`FlameID deployed at ${contractAddr}`);
  console.log(`deploy gas used: ${deployReceipt.gasUsed}`);
  check("contract has code", (await provider.getCode(contractAddr)).length > 2);
  check(
    "AGENT_ID_REGISTRY constant is correct",
    (await contract.AGENT_ID_REGISTRY()).toLowerCase() === REGISTRY.toLowerCase()
  );
  check("name() == FlameID Badge", (await contract.name()) === "FlameID Badge");
  check("symbol() == FLAME", (await contract.symbol()) === "FLAME");
  check(
    "milestones() == [7,14,30,60,100]",
    JSON.stringify((await contract.milestones()).map((x) => Number(x))) === "[7,14,30,60,100]"
  );
  check("MAX_SHIELDS == 3", (await contract.MAX_SHIELDS()) === 3n);
  check("REFERRAL_QUALIFY_STREAK == 3", (await contract.REFERRAL_QUALIFY_STREAK()) === 3n);
  check("SECONDS_PER_DAY == 86400", (await contract.SECONDS_PER_DAY()) === 86400n);

  // Time helpers: align to 12:00 UTC, then advance whole days.
  async function currentDay() {
    return Number(await contract.currentDay());
  }
  async function alignToNoon() {
    const block = await provider.getBlock("latest");
    const ts = Number(block.timestamp);
    const dayStart = Math.floor(ts / 86400) * 86400;
    let toNoon = dayStart + 12 * 3600 - ts;
    if (toNoon <= 60) toNoon += 86400; // too close to noon already: next noon
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
  console.log(`aligned to noon UTC, currentDay=${await currentDay()}`);

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
    // Explicit gas limit: Hardhat's estimator occasionally underestimates
    // a check-in by a few hundred gas and the tx runs out of gas.
    // Receipts below still report the true gas used.
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

  // 3. checkIn() happy path (wallet W, no referrer).
  console.log("\n-- checkIn() basics (W) --");
  const day0 = await currentDay();
  let rc = await checkIn("W");
  console.log(`  first checkIn gas used: ${rc.gasUsed}`);
  let w = await streakOf("W");
  check("W currentStreak == 1", w.current === 1);
  check("W longestStreak == 1", w.longest === 1);
  check("W totalCheckIns == 1", w.total === 1);
  check("W lastCheckInDay == today", w.lastDay === day0);
  check("W firstCheckInDay == today", w.firstDay === day0);
  check("totalStreakers == 1", (await contract.totalStreakers()) === 1n);
  check("streakerAt(0) == W", (await contract.streakerAt(0)).toLowerCase() === addr.W.toLowerCase());
  check("totalCheckIns == 1", (await contract.totalCheckIns()) === 1n);
  check("canCheckInToday(W) == false after check-in", (await contract.canCheckInToday(addr.W)) === false);
  check("canCheckInToday(A) == true (holder, not checked in)", (await contract.canCheckInToday(addr.A)) === true);
  check("canCheckInToday(nonHolder) == false", (await contract.canCheckInToday(addr.nonHolder)) === false);
  let events = await contract.queryFilter(contract.filters.CheckedIn);
  check(
    "CheckedIn event emitted (W, day, streak 1)",
    events.length === 1 &&
      events[0].args.user.toLowerCase() === addr.W.toLowerCase() &&
      Number(events[0].args.day) === day0 &&
      Number(events[0].args.currentStreak) === 1
  );

  // 4. Same-day / non-holder / value reverts.
  check(
    "second checkIn same day reverts (AlreadyCheckedInToday)",
    await expectRevert(() => contract.connect(as.W).checkIn(ZERO))
  );
  check(
    "non-holder checkIn reverts (NotAgentIDHolder)",
    await expectRevert(() => contract.connect(as.nonHolder).checkIn(ZERO))
  );
  check(
    "checkIn with value reverts (non-payable)",
    await expectRevert(() =>
      contract.connect(as.A).checkIn(ZERO, { value: ethers.parseEther("0.001") })
    )
  );
  check("A still never checked in", (await streakOf("A")).total === 0);

  // 5. Consecutive days grow the streak (W: day1 -> 2, day2 -> 3).
  console.log("\n-- consecutive days (W) --");
  await advanceDays(1);
  rc = await checkIn("W");
  console.log(`  2nd checkIn gas used: ${rc.gasUsed}`);
  w = await streakOf("W");
  check("W currentStreak == 2 after consecutive day", w.current === 2);
  check("W longestStreak == 2", w.longest === 2);
  await advanceDays(1);
  await checkIn("W");
  w = await streakOf("W");
  check("W currentStreak == 3 after 3rd consecutive day", w.current === 3);
  check("W longestStreak == 3", w.longest === 3);

  // 6. Miss exactly 1 day with NO shield -> reset to 1.
  console.log("\n-- miss 1 day, no shield (W) --");
  await advanceDays(2); // skip one full day
  await checkIn("W");
  w = await streakOf("W");
  check("W currentStreak reset to 1 after missed day", w.current === 1);
  check("W longestStreak stays 3 after reset", w.longest === 3);
  check("W totalCheckIns == 4", w.total === 4);
  check("totalCheckIns == 4", (await contract.totalCheckIns()) === 4n);

  // 7. Referral recording.
  console.log("\n-- referral recording --");
  // A checks in first (referrer must have checked in before).
  await checkIn("A");
  rc = await checkIn("B", addr.A);
  let refEvents = await contract.queryFilter(contract.filters.ReferralRecorded);
  check(
    "ReferralRecorded emitted (B -> A)",
    refEvents.length === 1 &&
      refEvents[0].args.invitee.toLowerCase() === addr.B.toLowerCase() &&
      refEvents[0].args.referrer.toLowerCase() === addr.A.toLowerCase()
  );
  check("referredBy(B) == A", (await contract.referredBy(addr.B)).toLowerCase() === addr.A.toLowerCase());
  check("shields(A) == 0 before B qualifies", (await contract.shields(addr.A)) === 0n);
  check("referralCount(A) == 0 before B qualifies", (await contract.referralCount(addr.A)) === 0n);

  // Self-referral ignored.
  await checkIn("C", addr.C);
  check("self-referral ignored: referredBy(C) == 0", (await contract.referredBy(addr.C)) === ZERO);
  // Referrer who never checked in: ignored.
  await checkIn("D", addr.E);
  check("never-checked-in referrer ignored: referredBy(D) == 0", (await contract.referredBy(addr.D)) === ZERO);
  // No referrer.
  await checkIn("F", ZERO);
  check("no referrer: referredBy(F) == 0", (await contract.referredBy(addr.F)) === ZERO);

  // 8. Referrer passed on a LATER check-in is ignored.
  await advanceDays(1);
  await checkIn("A"); // A streak 2
  await checkIn("B"); // B streak 2
  await checkIn("F", addr.A); // F 2nd check-in, names A — too late
  check("late referrer ignored: referredBy(F) still 0", (await contract.referredBy(addr.F)) === ZERO);
  // K stops at streak 2 with referrer L -> L earns nothing.
  await checkIn("L");
  await checkIn("K", addr.L);
  await advanceDays(1);
  await checkIn("B"); // B streak 3 -> qualifies!
  let shieldEvents = await contract.queryFilter(contract.filters.ShieldEarned);
  check(
    "ShieldEarned emitted once when B hits streak 3 (A, totalShields 1)",
    shieldEvents.length === 1 &&
      shieldEvents[0].args.referrer.toLowerCase() === addr.A.toLowerCase() &&
      Number(shieldEvents[0].args.totalShields) === 1
  );
  check("shields(A) == 1 after B qualifies", (await contract.shields(addr.A)) === 1n);
  check("referralCount(A) == 1 after B qualifies", (await contract.referralCount(addr.A)) === 1n);
  await checkIn("A"); // A streak 3
  await checkIn("K"); // K streak 2 — stops here, never qualifies
  check("shields(L) == 0 (K stopped at streak 2)", (await contract.shields(addr.L)) === 0n);
  check("referralCount(L) == 0 (K never qualified)", (await contract.referralCount(addr.L)) === 0n);
  // B checks in a 4th day: no second shield for the same referral.
  await advanceDays(1);
  await checkIn("B"); // B streak 4
  shieldEvents = await contract.queryFilter(contract.filters.ShieldEarned);
  check("no second ShieldEarned for the same referral", shieldEvents.length === 1);
  check("shields(A) still 1", (await contract.shields(addr.A)) === 1n);

  // 9. Shield use: A misses exactly 1 day, shield keeps streak.
  console.log("\n-- shield use (A) --");
  // A last checked in on day6 (streak 3, 1 shield). B checked in on day7.
  // A skips day7 and checks in on day8: gap 2 = exactly one missed day.
  await advanceDays(1);
  rc = await checkIn("A");
  console.log(`  shield-use checkIn gas used: ${rc.gasUsed}`);
  let a = await streakOf("A");
  check("A currentStreak kept at 3 after shield use", a.current === 3);
  check("A longestStreak still 3", a.longest === 3);
  check("shields(A) == 0 after shield spent", (await contract.shields(addr.A)) === 0n);
  const usedEvents = await contract.queryFilter(contract.filters.ShieldUsed);
  check(
    "ShieldUsed emitted (A, streakKept 3)",
    usedEvents.length === 1 &&
      usedEvents[0].args.user.toLowerCase() === addr.A.toLowerCase() &&
      Number(usedEvents[0].args.streakKept) === 3
  );
  // Consecutive day after shield use grows the streak again.
  await advanceDays(1);
  await checkIn("A");
  a = await streakOf("A");
  check("A currentStreak == 4 the day after shield use", a.current === 4);
  // Miss 1 day with NO shield left -> reset.
  await advanceDays(2);
  await checkIn("A");
  a = await streakOf("A");
  check("A currentStreak reset to 1 (missed day, no shield)", a.current === 1);
  check("A longestStreak stays 4", a.longest === 4);

  // 10. Shield does NOT save a 2+ day gap (M earns a shield via N first).
  console.log("\n-- shield does not save 2+ missed days (M/N) --");
  await checkIn("M"); // M streak 1
  await checkIn("N", addr.M); // N streak 1, referred by M
  await advanceDays(1);
  await checkIn("M"); // M streak 2
  await checkIn("N"); // N streak 2
  await advanceDays(1);
  await checkIn("N"); // N streak 3 -> M earns 1 shield
  check("shields(M) == 1 after N qualifies", (await contract.shields(addr.M)) === 1n);
  check("referralCount(M) == 1", (await contract.referralCount(addr.M)) === 1n);
  // M misses TWO full days (gap 3 from last check-in).
  await advanceDays(3);
  await checkIn("M");
  let m = await streakOf("M");
  check("M currentStreak reset to 1 after 2 missed days", m.current === 1);
  check("M shield NOT spent on 2+ day gap (shields still 1)", (await contract.shields(addr.M)) === 1n);
  // Now M uses the shield on a 1-day gap.
  await advanceDays(1);
  await checkIn("M"); // M streak 2
  await advanceDays(2); // miss exactly 1 day
  await checkIn("M");
  m = await streakOf("M");
  check("M currentStreak kept at 2 after shield use", m.current === 2);
  check("shields(M) == 0 after shield spent", (await contract.shields(addr.M)) === 0n);

  // 11. Shield cap: G earns max 3 shields from 4 qualified invitees.
  console.log("\n-- shield cap at 3 (G + G1..G4) --");
  await checkIn("G");
  for (const g of ["G1", "G2", "G3", "G4"]) await checkIn(g, addr.G);
  await advanceDays(1);
  await checkIn("G");
  for (const g of ["G1", "G2", "G3", "G4"]) await checkIn(g);
  await advanceDays(1);
  for (const g of ["G1", "G2", "G3", "G4"]) await checkIn(g); // all hit streak 3
  check("shields(G) == 3 (capped)", (await contract.shields(addr.G)) === 3n);
  check("referralCount(G) == 4 (all four qualified)", (await contract.referralCount(addr.G)) === 4n);
  shieldEvents = await contract.queryFilter(contract.filters.ShieldEarned);
  const gShields = shieldEvents.filter(
    (e) => e.args.referrer.toLowerCase() === addr.G.toLowerCase()
  );
  check("exactly 3 ShieldEarned events for G (4th capped, no event)", gShields.length === 3);

  // 12. claimBadge().
  console.log("\n-- claimBadge() (H, 7-day streak) --");
  check(
    "claimBadge(5) reverts (InvalidMilestone)",
    await expectRevert(() => contract.connect(as.H).claimBadge(5))
  );
  check(
    "claimBadge(0) reverts (InvalidMilestone)",
    await expectRevert(() => contract.connect(as.H).claimBadge(0))
  );
  check(
    "claimBadge(8) reverts (InvalidMilestone)",
    await expectRevert(() => contract.connect(as.H).claimBadge(8))
  );
  check(
    "claimBadge(7) with streak 0 reverts (StreakTooShort)",
    await expectRevert(() => contract.connect(as.H).claimBadge(7))
  );
  check(
    "non-holder claimBadge reverts (NotAgentIDHolder)",
    await expectRevert(() => contract.connect(as.nonHolder).claimBadge(7))
  );
  check(
    "claimBadge with value reverts (non-payable)",
    await expectRevert(() =>
      contract.connect(as.H).claimBadge(7, { value: ethers.parseEther("0.001") })
    )
  );
  // H builds a 7-day streak; I builds one in parallel.
  await checkIn("H");
  await checkIn("I");
  for (let d = 0; d < 5; d++) {
    await advanceDays(1);
    await checkIn("H");
    await checkIn("I");
  }
  await advanceDays(1);
  await checkIn("H"); // H streak 7
  await checkIn("I"); // I streak 7
  let h = await streakOf("H");
  check("H currentStreak == 7", h.current === 7);
  check("H longestStreak == 7", h.longest === 7);
  check(
    "claimBadge(14) with longest 7 reverts (StreakTooShort)",
    await expectRevert(() => contract.connect(as.H).claimBadge(14))
  );
  rc = await contract.connect(as.H).claimBadge(7, { gasLimit: 500000 });
  const badgeRc = await rc.wait();
  console.log(`  claimBadge(7) gas used: ${badgeRc.gasUsed}`);
  check("hasBadge(H, 7) == true", (await contract.hasBadge(addr.H, 7)) === true);
  check("badgeTokenOf(H, 7) == 1", (await contract.badgeTokenOf(addr.H, 7)) === 1n);
  check("badgeMilestoneOf(1) == 7", (await contract.badgeMilestoneOf(1)) === 7n);
  check("balanceOf(H) == 1 (badge NFT)", (await contract.balanceOf(addr.H)) === 1n);
  check("ownerOf(1) == H", (await contract.ownerOf(1)).toLowerCase() === addr.H.toLowerCase());
  check("totalBadges == 1", (await contract.totalBadges()) === 1n);
  const badgeEvents = await contract.queryFilter(contract.filters.BadgeClaimed);
  check(
    "BadgeClaimed emitted (H, milestone 7, tokenId 1)",
    badgeEvents.length === 1 &&
      badgeEvents[0].args.user.toLowerCase() === addr.H.toLowerCase() &&
      Number(badgeEvents[0].args.milestone) === 7 &&
      Number(badgeEvents[0].args.tokenId) === 1
  );
  check(
    "second claimBadge(7) reverts (BadgeAlreadyClaimed)",
    await expectRevert(() => contract.connect(as.H).claimBadge(7))
  );

  // 13. tokenURI: on-chain SVG metadata.
  console.log("\n-- tokenURI() --");
  const uri = await contract.tokenURI(1);
  check("tokenURI starts with data:application/json;base64,", uri.startsWith("data:application/json;base64,"));
  const meta = JSON.parse(
    Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
  );
  check("metadata name mentions 7-Day Badge (Bronze)", typeof meta.name === "string" && meta.name.includes("7-Day Badge (Bronze)"));
  check("metadata description mentions soulbound", typeof meta.description === "string" && meta.description.toLowerCase().includes("soulbound"));
  check("metadata image is data:image/svg+xml;base64,", typeof meta.image === "string" && meta.image.startsWith("data:image/svg+xml;base64,"));
  const svg = Buffer.from(meta.image.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
  check("SVG contains the milestone number 7", svg.includes(">7<"));
  check("SVG contains tier Bronze", svg.includes("Bronze"));
  check("SVG contains FLAMEID", svg.includes("FLAMEID"));
  check(
    "tokenURI(999) reverts (NonexistentBadgeToken)",
    await expectRevert(() => contract.tokenURI(999))
  );

  // 14. Soulbound: no transfers, no approvals.
  console.log("\n-- soulbound badge --");
  check(
    "transferFrom reverts (Soulbound)",
    await expectRevert(() => contract.connect(as.H).transferFrom(addr.H, addr.A, 1))
  );
  check(
    "safeTransferFrom reverts (Soulbound)",
    await expectRevert(() =>
      contract.connect(as.H)["safeTransferFrom(address,address,uint256)"](addr.H, addr.A, 1)
    )
  );
  check(
    "approve reverts (Soulbound)",
    await expectRevert(() => contract.connect(as.H).approve(addr.A, 1))
  );
  check(
    "setApprovalForAll reverts (Soulbound)",
    await expectRevert(() => contract.connect(as.H).setApprovalForAll(addr.A, true))
  );
  check("getApproved(1) == 0", (await contract.getApproved(1)) === ZERO);
  check("isApprovedForAll(H, A) == false", (await contract.isApprovedForAll(addr.H, addr.A)) === false);
  check("ownerOf(1) still H after blocked transfers", (await contract.ownerOf(1)).toLowerCase() === addr.H.toLowerCase());

  // 15. Longest streak survives a reset: I breaks the streak, badge still claimable.
  console.log("\n-- longest streak survives reset (I) --");
  await advanceDays(3); // I misses 2 days
  await checkIn("I");
  let ii = await streakOf("I");
  check("I currentStreak reset to 1", ii.current === 1);
  check("I longestStreak still 7", ii.longest === 7);
  await contract.connect(as.I).claimBadge(7, { gasLimit: 500000 });
  check("I claims badge 7 from longest streak", (await contract.hasBadge(addr.I, 7)) === true);
  check("badgeTokenOf(I, 7) == 2", (await contract.badgeTokenOf(addr.I, 7)) === 2n);
  check("totalBadges == 2", (await contract.totalBadges()) === 2n);

  // 16. Losing the Agent ID blocks check-ins; regaining re-enables.
  console.log("\n-- losing / regaining Agent ID (W) --");
  await setHolder(addr.W, 0);
  check("registry.balanceOf(W) == 0 after revoke", (await registry.balanceOf(addr.W)) === 0n);
  check(
    "checkIn after losing Agent ID reverts",
    await expectRevert(() => contract.connect(as.W).checkIn(ZERO))
  );
  await setHolder(addr.W, 1);
  // NOTE (Hardhat-node quirk, also seen in the sibling project): eth_estimateGas
  // intermittently reverts right after hardhat_setStorageAt even though
  // eth_call balanceOf reads 1 and staticCall passes. Verify via staticCall,
  // then send with an explicit gas limit.
  await contract.connect(as.W).checkIn.staticCall(ZERO);
  check("staticCall checkIn passes after ID restored", true);
  const txW = await contract.connect(as.W).checkIn(ZERO, { gasLimit: 500000 });
  await txW.wait();
  check("checkIn works again after ID restored", (await streakOf("W")).total === 5);

  // 17. Views on an untouched address.
  console.log("\n-- views on untouched address --");
  const fresh = ethers.Wallet.createRandom().address;
  const fs0 = await contract.streakOf(fresh);
  check(
    "streakOf(fresh) is all zeros",
    Number(fs0[0]) === 0 && Number(fs0[1]) === 0 && Number(fs0[2]) === 0 &&
      Number(fs0[3]) === 0 && Number(fs0[4]) === 0
  );
  check("canCheckInToday(fresh) == false (no Agent ID)", (await contract.canCheckInToday(fresh)) === false);
  check("shields(fresh) == 0", (await contract.shields(fresh)) === 0n);
  check("referralCount(fresh) == 0", (await contract.referralCount(fresh)) === 0n);
  check("referredBy(fresh) == 0", (await contract.referredBy(fresh)) === ZERO);
  check("hasBadge(fresh, 7) == false", (await contract.hasBadge(fresh, 7)) === false);
  check("badgeTokenOf(fresh, 7) == 0", (await contract.badgeTokenOf(fresh, 7)) === 0n);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("TEST SCRIPT ERROR:", e);
  process.exit(1);
});
