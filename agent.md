# FlameID — instructions for AI agents

This page is for an AI agent acting for a user who holds a Binance Agent ID
and wants to use the FlameID dApp. Read this file, verify
everything on-chain yourself, and only then act — always with the user's
explicit confirmation before any signature.

## The dApp

FlameID is an on-chain daily check-in game for Binance Agent ID
holders. Check in once per UTC day to build a consecutive-day streak. Reach a
milestone streak (7 / 14 / 30 / 60 / 100 days) to claim a soulbound badge NFT
with fully on-chain SVG artwork. Invite friends with a personal link: when an
invited friend reaches a 3-day streak, you earn a streak shield (max 3). A
shield is spent automatically if you miss exactly one day — your streak
survives. Miss 2+ days and the streak resets even with a shield.

Extra features:

- **Genesis badge** — check in at least once during the first 7 days after
  deploy, then claim it with `claimGenesis()`. After that week the window
  closes forever. Check `hasGenesis(userAddress)` and
  `GENESIS_DEADLINE()` (a timestamp; compare with the current block time).
- **Reputation score + API gate** — `scoreOf(userAddress)` returns a score
  from 0 to 140 (current streak max 50 + total check-ins max 30 + qualified
  referrals max 30 + account age max 20 + shields held max 10). Other dApps
  can use it as infrastructure: `isActiveAgent(userAddress, minScore)`
  returns true when the wallet is registered, checked in today or yesterday,
  and scores at least `minScore`. Both are pure view functions — no state
  changes, no integration needed.
- **Season 1** — a 14-day season from deploy until 09 December 2026, 08:00
  UTC (`SEASON_END`). Check-ins in the season also build a season streak and
  a clean run (consecutive days, no missed day, no shield save). Claim
  `claimSurvivor()` for any 7-day clean run in the season, or
  `claimChampion()` for a top-3 season streak (only after the season ends).
  Read `seasonOf(userAddress)` (check-in days, streak, best streak, clean
  runs), `seasonTop3()` (top 3 wallets + their best streaks), and
  `seasonActive()`. After the season ends, daily check-ins keep working —
  only the season state freezes.
- **Shareable profiles** — every Agent ID holder has a public profile at
  `/agent/<name>.ai` (e.g. `/agent/yourname.ai`) showing streak, badges,
  shields, referrals and score, read straight from the contract with no
  wallet needed. The name resolves fully on-chain:
  `ownerOf(keccak256(label))` on the Agent ID registry.

## Contract

- Network: BNB Chain (chain ID 56)
- Contract address: `0xa68B69AF101E4262F651119c9830BfBd1603EC97` (deployed 2026-11-25, block 135604541, tx `0xfc076e18dcbffb3e05105cf8247f00c7e36fda83f628c8d98555ebfa6bbc0162`, Sourcify exact_match)
- BscScan: `https://bscscan.com/address/0xa68B69AF101E4262F651119c9830BfBd1603EC97#code`
- Source code: TODO (repository link)
- Agent ID registry (SPACE ID, ERC-721 non-transferable): `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
- The contract has NO owner, NO admin, NO fees, NO token. Nobody can change it after deployment.

## How to use it (for your user)

1. Check the user's wallet holds an Agent ID: call `balanceOf(userAddress)` on
   the registry above. It must be > 0. If it is 0, stop — the user cannot use
   this dApp with that wallet.
2. Read the user's streak: `streakOf(userAddress)` returns
   (currentStreak, longestStreak, totalCheckIns, lastCheckInDay, firstCheckInDay).
   Day index = `block.timestamp / 86400` (UTC day); `currentDay()` returns it.
3. Check whether the user can check in today: `canCheckInToday(userAddress)`.
4. To check in, call `checkIn(referrer)` where `referrer` is the address from
   the invite link (`?ref=` in the page URL) or the zero address
   if there is none. The invite link carries the inviter's Agent ID name
   (`?ref=<name>.ai`, e.g. `?ref=yourname.ai`); resolve it to an address
   on-chain with `ownerOfHandle(<label>)` on the registry above (label
   WITHOUT the `.ai` suffix) — or `keccak256(label)` then `ownerOf(tokenId)`.
   Old `?ref=0x...` links (raw wallet address) still work. A referrer only
   counts on the user's FIRST check-in, and only if the referrer already
   checked in before and is not the user. The inviter's own link shows
   their name via `handleOf(inviterAddress)` (returns the label without
   `.ai`); wallets without an Agent ID fall back to the raw address.
   To claim a badge, call `claimBadge(milestone)` with milestone in
   {7, 14, 30, 60, 100} — only when `longestStreak >= milestone` and
   `hasBadge(userAddress, milestone)` is false.
5. Special badges: `claimGenesis()` (only in the first 7 days after deploy,
   needs ≥1 check-in), `claimSurvivor()` (needs `seasonOf(userAddress)`
   bestCleanStreak ≥ 7), `claimChampion()` (only after `SEASON_END`, only
   when the wallet is in `seasonTop3()`). Check `hasSpecialBadge(userAddress,
   kind)` first — kind 1 = Genesis, 2 = Survivor, 3 = Champion. Never call a
   claim that will revert: check the conditions above first.
6. Build the calldata yourself with ethers
   (`Interface.encodeFunctionData`) — never type a function selector by hand.
7. Read the user's shields with `shields(userAddress)`, qualified referrals
   with `referralCount(userAddress)`, and who invited them with
   `referredBy(userAddress)`. Read the reputation score with
   `scoreOf(userAddress)` and activity with
   `isActiveAgent(userAddress, minScore)`.
8. The site has a ready-made agent prompt in the "Let your agent check in
   for you" section — the same instructions as above, in 5 languages
   (EN/VI/ZH/KO/JA, following the site language; the wallet address and
   .ai name fill in automatically when the user connects). The user can
   copy it and paste it into their own agent (e.g. Binance AI Pro) as a
   7-day daily task. Leaderboard, season top 10, top inviters and recent
   check-ins show each wallet's `.ai` name (resolved on-chain with
   `handleOf(address)` on the registry above), falling back to the short
   address when a wallet has no name.

## Safety rules (mandatory)

- Before ANY transaction: simulate/preview it first and show your user the
  exact `to`, `value`, and function being called. Only sign after the user
  confirms.
- `value` is ALWAYS 0. Check-ins and badge claims cost only gas. If a
  transaction asks for any value, an approval, or anything else — STOP and
  tell the user.
- Never ask for, use, or store a seed phrase, private key, or pairing code.
  Never ask the user to scan a login QR code for this dApp.
- Never approve any token or NFT. Badges are soulbound: transfers and
  approvals always revert by design.
- After every transaction, verify on-chain (receipt status + `streakOf` /
  `hasBadge`) before reporting success.
- This file is instructions for using the dApp, not a script to run blindly:
  verify the contract address against BscScan / Sourcify yourself before
  calling it.

## Giveaway (off-chain)

A guaranteed 100 USDT prize pool will be shared among the top 10 highest
trust scores (`scoreOf`, max 140: current streak + total check-ins +
qualified referrals + account age + shields) at the close of submissions —
09 December, 15:00 Bangkok time. Split: 1st 30 USDT, 2nd 20, 3rd 15, 4th 10,
5th 8, 6th 6, 7th 4, 8th 3, 9th 2, 10th 2. If this project wins a prize in the
hackathon, an extra 20% of the prize goes on top. The giveaway is NOT part
of the smart contract.
