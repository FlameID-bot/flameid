# Deploy guide — FlameID

Deploy the contract to BNB Chain mainnet with Remix and a wallet browser
extension. No private key is ever pasted anywhere; the deployer wallet signs
in its own extension.

## 0. Before you start

- A wallet with a little BNB for gas (deploy ≈ 3.57M gas) and, for the
  post-deploy smoke test, a wallet that holds a Binance Agent ID.
- The contract source: `contracts/FlameID.sol`.
- Compiler version: **0.8.26** (exact). The contract pins `pragma solidity 0.8.26`.

## 1. Compile in Remix

1. Open https://remix.ethereum.org.
2. Create a new file `FlameID.sol` and paste the full contents of
   `contracts/FlameID.sol`.
3. Open the Solidity compiler panel. Set:
   - Compiler: **0.8.26**
   - EVM Version: **cancun**
   - Optimizer: **enabled, 200 runs**
   - Language: Solidity
4. Compile. Remix resolves the `@openzeppelin/...` imports itself — if it
   asks, allow it to fetch the OpenZeppelin contracts (version 5.x).
5. Confirm there are no errors or warnings that change behaviour.

## 2. Deploy

**Deployer wallet: thaile.ai — `0x30B1a0E287319774B526d43525FFD60BBeD8D06e`.** Fund it
first: balance was only **0.000106 BNB** (checked 2026-11-25 12:53) — not enough
for the 3,558,071-gas deploy. Top up to **~0.01 BNB** to cover deploy + smoke
test + Genesis claim.

1. Open the "Deploy & run transactions" panel. Set Environment to your wallet
   extension (in newer Remix this is called "Browser Extension" / "Injected
   Provider"). Connect the deployer wallet and check the network is **BNB
   Smart Chain Mainnet** (chain ID 56).
2. Select contract `FlameID` (no constructor arguments).
3. Deploy, confirm in the wallet, wait for the receipt. Note the contract
   address, transaction hash, block number, and gas used.
4. Sanity-check on-chain (read-only): `name()` → "FlameID Badge",
   `symbol()` → "FLAME", `AGENT_ID_REGISTRY()` →
   `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`, `milestones()` → [7,14,30,60,100],
   `GENESIS_DEADLINE()` → deploy time + 7 days, `SEASON_END()` →
   1796803200 (2026-12-09 08:00:00 UTC), `seasonActive()` → true.

## 3. Verify the source

### Sourcify (preferred — also feeds BscScan)

```bash
curl -X POST "https://sourcify.dev/server/v2/verify/56/<CONTRACT_ADDRESS>" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "stdJsonInput": <contents of verify/standard-json-input.json>,
  "compilerVersion": "0.8.26+commit.8a97fa7a",
  "contractIdentifier": "FlameID.sol:FlameID"
}
JSON
```

Build the request with a small script rather than by hand (the standard JSON
is ~170 KB). Expect `exact_match` for both creation and runtime bytecode.
If it does not match, retry with `verify/standard-json-input-crlf.json`
(the same sources with CRLF line endings — Remix compiles the pasted file,
and the pasted copy may use CRLF).

### BscScan

Open `https://bscscan.com/address/<CONTRACT_ADDRESS>#code` → "Verify and
Publish" → "Standard JSON Input" → paste the contents of
`verify/standard-json-input.json` (or the CRLF variant), compiler 0.8.26,
optimizer enabled, 200 runs, EVM cancun. If BscScan reports the contract is
already verified, Sourcify verification already propagated — check the page
shows the source instead of re-submitting.

## 4. Smoke test on mainnet (from an Agent ID wallet)

1. `checkIn(0x0000000000000000000000000000000000000000)` — value 0.
   Preview/simulate first; only send when the preview is clean.
2. Read back `streakOf(<your wallet>)` → currentStreak 1, totalCheckIns 1.
3. `canCheckInToday(<your wallet>)` → false until tomorrow.
4. `claimGenesis()` — value 0. It works on day one (needs ≥1 check-in and
   the Genesis window open). Read back `hasGenesis(<your wallet>)` → true.
5. `scoreOf(<your wallet>)` → 2 on day one (1 current streak + 1 check-in
   + 0 referrals + 0 account age — age is whole days since the first
   check-in day, capped at 20 — + 0 shields). `isActiveAgent(<your wallet>,
   2)` → true.
6. `seasonOf(<your wallet>)` → checkInDays 1, currentStreak 1, bestStreak 1.
   Badge claims for milestones need a 7-day streak first — they cannot be
   smoke-tested on day one.

## 5. Publish the website

1. Fill in `CONTRACT_ADDRESS` and `DEPLOY_BLOCK` in `frontend/app.js`
   (top of the file), and the contract address + BscScan link in
   `frontend/agent.md` and `README.md`.
2. Run `node scripts/export_frontend_abi.js` once more after any recompile.
3. Publish the `frontend/` folder as a static site (e.g. GitHub Pages).
4. Open the live site, connect a wallet, and confirm the stats cards load
   (totalStreakers / totalCheckIns / totalBadges) and the leaderboard renders.

### Custom domain — flame-id.xyz (decided, Diệt is buying it on Porkbun)

The domain is **flame-id.xyz** ($1.29 first year). The plain brand variants
were taken / resale-priced, hence the hyphen. The `frontend/CNAME` file
already contains exactly `flame-id.xyz` — do not remove it.

After the purchase, point DNS at GitHub Pages following GitHub's standard
"custom domain" guide:

1. In the domain registrar (Porkbun) DNS settings, add the records GitHub
   Pages asks for: for an apex domain, the four A records
   (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
   `185.199.111.153`) and the AAAA records from GitHub's docs; or use a
   CNAME record pointing a subdomain (e.g. `www`) at
   `<github-username>.github.io`. Follow the current GitHub docs — the exact
   IPs are listed there and are the authoritative source.
2. In the GitHub repository settings → Pages, set the custom domain to
   `flame-id.xyz` and wait for DNS check to pass (can take up to ~24h for
   DNS to propagate; GitHub usually verifies within minutes to an hour).
3. Confirm the site loads on https://flame-id.xyz and the stats/leaderboard
   render. The domain is already filled in where it belongs (`README.md`
   Website line, `docs/submission-draft.md`, `scripts/demo_plan.md`).
