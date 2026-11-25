# Demo video plan — FlameID

Status: **NOT RECORDED YET — record after deploy, once the website is live.**
This file is the script + shot list only. Do not record before the contract
is deployed and the site shows live on-chain data, or the video will show
placeholder/zero values.

## Format

- Real walkthrough on the live site (same style as the previous project's
  demo v2): no slides, no mockups — every screen is the real website with a
  real wallet.
- Length: ~60 seconds. Resolution 1280×720, browser window, no facecam.
- On-screen captions in English, one short line per shot. No voiceover
  needed; add quiet background music only if it does not distract.
- Wallet: the demo wallet must hold an Agent ID and must NOT have checked in
  yet that day (a check-in can only happen once per UTC day). Plan the
  recording so all shots fit in one session. The Genesis claim is one-time —
  if the demo wallet already claimed it, show the earned Genesis badge
  instead of the claim click.

## Shots

| # | Time | Screen | Action / caption |
|---|------|--------|------------------|
| 1 | 0–6s | Homepage hero | Show the flame + title + stats (streakers / total check-ins / badges). Caption: "Daily on-chain check-ins for Agent ID holders." |
| 2 | 6–14s | Connect wallet | Click Connect, approve in the wallet. Caption: "Connect your Agent ID wallet — no sign-up, no password." |
| 3 | 14–28s | My streak → Check in | Click "Check in today", confirm the transaction (value 0, gas only). Wait for confirmation, streak goes 0 → 1. Caption: "One check-in per day. Value is always 0 — only gas." |
| 4 | 28–38s | Special badges → Genesis | Click "Claim badge" on Genesis. Show the earned badge. Caption: "Genesis badge — only claimable in the first 7 days after launch." |
| 5 | 38–48s | Season 1 + leaderboard | Scroll to Season 1 (top 3, my season stats) and the leaderboard. Caption: "Season 1: 14 days. Survivor for a 7-day clean run, Champion for the top 3." |
| 6 | 48–56s | Profile page | Open /agent/<name>.ai, show streak + badges + score. Click "Share on X" (show the prefilled post, do not post it). Caption: "Your streak has a shareable profile — no wallet needed to view." |
| 7 | 56–60s | End card | https://flame-id.xyz + contract address on screen. Caption: "FlameID — keep the flame alive." |

## After recording

1. Export as `demo.mp4`, keep it under ~2 MB.
2. Upload to the website root (same folder as `index.html`) so it is served
   at `<site>/demo.mp4`, and verify with a plain HTTP 200 check.
3. Put the link in the submission form (video field) and in
   `docs/submission-draft.md` where it currently says "demo video: TODO".
4. Do NOT re-record just to change numbers — the video shows the product
   working; live numbers live on the website, not in the video.
