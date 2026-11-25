# FlameID 🔥

Daily on-chain check-in streaks for Binance Agent ID holders. Check in once
per UTC day, build your streak, claim soulbound badges — and invite friends to
earn streak shields that save your streak when life gets in the way.

- **Website:** https://flame-id.xyz (TODO: publish the frontend after deploy; Diệt is buying the domain on Porkbun, $1.29 first year)
- **X:** [@FlameIDOfficial](https://x.com/FlameIDOfficial)
- **Contract:** [`0xa68B69AF101E4262F651119c9830BfBd1603EC97`](https://bscscan.com/address/0xa68B69AF101E4262F651119c9830BfBd1603EC97#code) — BNB Chain, deployed 2026-11-25 (block 135604541, tx `0xfc076e18dcbffb3e05105cf8247f00c7e36fda83f628c8d98555ebfa6bbc0162`), Sourcify exact_match
- **Hackathon:** Binance Wallet × BNB Chain Agent ID Hackathon, submissions close 09/12 15:00 Bangkok

## How it works

1. **Check in** — `checkIn(referrer)` once per UTC day (value 0, Agent ID
   holders only). Check in on consecutive days and the streak grows; miss a
   day and it resets to 1.
2. **Badges** — reach a 7 / 14 / 30 / 60 / 100-day streak and claim that
   milestone's badge with `claimBadge(milestone)`. Badges are soulbound
   ERC-721 NFTs with fully on-chain SVG artwork — they can never be
   transferred, approved, or sold. A badge is earned from your LONGEST streak,
   so a broken streak never loses a badge you already earned.
3. **Referrals** — a first check-in can name a referrer (a wallet that already
   checked in before). When the invited friend reaches a 3-day streak, the
   referral qualifies and the referrer earns one streak shield (max 3).
4. **Shields** — if you miss exactly one day and hold a shield, the shield is
   spent automatically and your streak is kept. Miss 2+ days, or miss a day
   with no shield, and the streak resets as usual.
5. **Genesis badge** — check in at least once in the first 7 days after
   deploy and claim the one-time Genesis badge with `claimGenesis()`. After
   that week the window closes forever — the badge can never be claimed
   again. It is soulbound, like all badges.
6. **Reputation score + API gate** — `scoreOf(address)` (max 140) is built
   from your current streak (max 50) + total check-ins (max 30) + qualified
   referrals (max 30) + account age from your first check-in day (max 20) +
   shields held (max 10). `isActiveAgent(address, minScore)` returns true
   when a wallet is registered, checked in today or yesterday, and scores at
   least `minScore`. Both are pure view functions — other dApps can call them
   on-chain to gate features for active agents, no integration work needed.
   See [agent.md](frontend/agent.md).
7. **Season 1** — a 14-day season from deploy until 09 December 2026, 08:00
   UTC. Check-ins during the season also count toward a season streak and a
   **clean run** (consecutive days with no missed day and no shield save).
   `claimSurvivor()` mints a badge for any 7-day clean run inside the season;
   `claimChampion()` mints a badge for the top 3 season streaks (claimable
   only after the season ends). The contract keeps an on-chain top 3
   (`seasonTop3()`), so the frontend never has to scan every wallet. After
   the season ends, daily check-ins keep working — only the season state
   freezes, and it stays readable forever (`seasonOf`, `seasonActive()`).

## Shareable streak profiles

Every Agent ID holder has a public profile at
`/agent/<name>.ai` (e.g. `/agent/mrchrismast.ai`) showing their streak,
badges (including Genesis), shields, qualified referrals and reputation
score — read straight from the contract, no wallet needed to view. The name
is resolved fully on-chain: `ownerOf(keccak256(label))` on the Agent ID
registry. A "Share on X" button on the profile posts a ready-made text with
the streak and score.

## Giveaway (off-chain)

If this project wins a prize in the hackathon, **20% of the prize will be
shared among the top 10 longest streaks** at the close of submissions
(09 December, 15:00 Bangkok time). The giveaway is not part of the smart
contract; the exact prize amount will be confirmed on the website once decided.

## Why referral farming does not pay

- A referral only qualifies when the invitee **really checks in 3 days in a
  row** — that costs gas on three separate days, takes three days of waiting,
  and requires the invitee to hold a Binance Agent ID (non-transferable).
- The referrer must be a real user who checked in before the invitee's first
  check-in. Self-referrals and referrers who never checked in are ignored.
- Each wallet can only ever have one referrer, and each referrer can hold at
  most **3 shields**. Shields have no monetary value in the contract — they
  only protect a streak.
- Creating many Agent IDs to farm shields costs far more (time, gas, and
  Agent IDs) than the shields are worth.

## Contract

`contracts/FlameID.sol` — Solidity 0.8.26, OpenZeppelin ERC-721.

- NO owner, NO admin, NO pause, NO fees, NO token, NO upgradeability.
- Every state-changing function is non-payable (value must be 0).
- Agent ID gate: every `checkIn` / `claimBadge` reads `balanceOf` on the
  SPACE ID Agent ID registry (`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`).
- Days are UTC days: `day = block.timestamp / 86400`.
- Events: `CheckedIn`, `BadgeClaimed`, `ReferralRecorded`, `ShieldEarned`,
  `ShieldUsed`, `GenesisClaimed`, `SurvivorClaimed`, `ChampionClaimed`.
- Views: `streakOf`, `canCheckInToday`, `currentDay`, `totalStreakers`,
  `streakerAt`, `totalCheckIns`, `totalBadges`, `hasBadge`, `badgeTokenOf`,
  `badgeMilestoneOf`, `referralCount`, `shields`, `referredBy`, `milestones`,
  `hasGenesis`, `GENESIS_DEADLINE`, `scoreOf`, `isActiveAgent`,
  `seasonActive`, `seasonOf`, `seasonTop3`, `hasSpecialBadge`,
  `specialBadgeTokenOf`, `badgeKindOf`, `SEASON_END`.
- Genesis badge: `claimGenesis()` — needs ≥1 check-in, only within 7 days
  after deploy (`GENESIS_DEADLINE`, immutable), once per wallet.
- Season 1: runs from deploy to 09/12/2026 08:00 UTC (`SEASON_END`,
  immutable). `claimSurvivor()` needs a 7-day clean run in the season;
  `claimChampion()` needs a top-3 season streak and only works after the
  season ends. The season top 3 is tracked on-chain in O(1) per check-in
  (ties keep the earlier wallet).

Gas (local Hardhat test, season active): deploy 3,558,071 · first check-in
218,740 · later check-in 67,933 · shield-use check-in 59,034 · first badge
claim 167,616 · claimGenesis 166,878 · claimSurvivor 149,825 ·
claimChampion 132,687. (After the season ends, check-ins get cheaper again
— first check-in 143,731 — because season tracking stops.)

## Repo layout

```
contracts/FlameID.sol   main contract
test/MockAgentID.sol             test-only registry mock (never deploy to mainnet)
test/test.js                     114 checks (original behaviour), run against a local Hardhat node
test/test2.js                    91 checks (Genesis, season, score — needs a FRESH node per run)
scripts/compile.js               solc 0.8.26 (remote) + verify standard JSON (LF + CRLF)
scripts/export_frontend_abi.js   writes frontend/abi.js from the build artifact
scripts/check_stats.js           read live counters / a wallet's streak, season + score from BSC
scripts/demo_plan.md             demo video script + shot plan (record after deploy, once the site is live)
docs/submission-draft.md         draft submission-form answers (Chinese)
frontend/                        static website (index.html, style.css, app.js, agent.md, agent.html, 404.html, CNAME)
verify/                          standard-json-input.json (+ CRLF variant) for Sourcify/BscScan
```

## Build & test

```bash
npm install
node scripts/compile.js        # writes build/*.json + verify/*.json
npx hardhat node --port 8545   # in a separate terminal
node test/test.js               # 114 checks, must all pass
# restart the node (test2 advances chain time ~65 days), then:
node test/test2.js              # 91 checks, must all pass
node scripts/export_frontend_abi.js   # after every recompile
```

Total: **205 checks, all must pass.**

## Deploy

See [DEPLOY.md](DEPLOY.md) — Remix + wallet extension, then Sourcify/BscScan
verification, then fill in the contract address in `frontend/app.js`,
`frontend/agent.md`, and this README.

## License

MIT — see [LICENSE](LICENSE).
