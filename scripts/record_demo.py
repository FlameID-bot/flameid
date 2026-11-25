"""Record a REAL screen walkthrough of the live FlameID site with Playwright.

No stills: the browser scrolls the live page while Playwright records video
(CDP screencast). Two takes, joined with xfade in post:
  take 1: home — hero/stats -> badges -> season top 10 -> inviters ->
          leaderboard -> recent check-ins (waits for boards to load first)
  take 2: profile of a stranger wallet (Genesis claimed) via ?a=
No wallet is connected, nothing is signed, no mrchrismast.ai anywhere.
"""
import asyncio
import sys
from playwright.async_api import async_playwright

W, H = 1280, 720
HOME = "http://flame-id.xyz/"
PROFILE = "http://flame-id.xyz/agent.html?a=0x4d50DD3E57d1F4adade559Bd075BcA0496aaa29b"
OUT = "/home/hatch/workspace/agent-daily-streak/frontend/demo_raw"

async def smooth_scroll(page, total, steps=28, step_delay=0.45):
    """Scroll down slowly with the mouse wheel, like a person reading."""
    for _ in range(steps):
        await page.mouse.wheel(0, total / steps)
        await page.wait_for_timeout(int(step_delay * 1000))

async def wait_for_text(page, text, timeout=90000):
    await page.wait_for_function(
        f"document.body.innerText.includes({text!r})", timeout=timeout
    )

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            # --no-sandbox: VM has no user namespaces for the sandbox.
            # --disable-features HttpsFirst*: Chrome 159 upgrades plain-http
            # navigations to HTTPS (CONNECT) by default; the VM egress proxy
            # refuses CONNECT tunnels, so plain http://flame-id.xyz (its HTTPS
            # cert is still pending) must stay plain HTTP.
            args=["--no-sandbox",
                  "--disable-features=HttpsFirstMode,HttpsFirstBalancedMode,HttpsUpgrades"],
            # VM egress proxy (no auth needed — curl without creds gets 200;
            # with username/password Chromium's 407 flow gets ERR_EMPTY_RESPONSE).
            proxy={"server": "http://hatch-egress-proxy:3128"},
        )
        # --- TAKE 1: home ---
        ctx1 = await browser.new_context(
            viewport={"width": W, "height": H},
            record_video_dir=f"{OUT}/take1",
            record_video_size={"width": W, "height": H},
        )
        p1 = await ctx1.new_page()
        await p1.goto(HOME, wait_until="domcontentloaded")
        print("take1: home loaded, waiting for boards...", flush=True)
        # Boards take ~30s (chunked eth_getLogs). Wait for top-10 rows.
        await wait_for_text(p1, "2 pts")
        print("take1: boards loaded, starting scroll", flush=True)
        await p1.wait_for_timeout(1500)
        # Hero + stats are at the top already; linger, then scroll down.
        await p1.wait_for_timeout(2500)
        await smooth_scroll(p1, 900, steps=10, step_delay=0.5)
        await p1.wait_for_timeout(2500)   # badges / my streak
        await smooth_scroll(p1, 1400, steps=14, step_delay=0.5)
        await p1.wait_for_timeout(2500)   # season top 10
        await smooth_scroll(p1, 1400, steps=14, step_delay=0.5)
        await p1.wait_for_timeout(2500)   # inviters + leaderboard
        await smooth_scroll(p1, 1200, steps=12, step_delay=0.5)
        await p1.wait_for_timeout(3000)   # recent check-ins
        await ctx1.close()
        print("take1 done", flush=True)

        # --- TAKE 2: stranger profile ---
        ctx2 = await browser.new_context(
            viewport={"width": W, "height": H},
            record_video_dir=f"{OUT}/take2",
            record_video_size={"width": W, "height": H},
        )
        p2 = await ctx2.new_page()
        await p2.goto(PROFILE, wait_until="domcontentloaded")
        print("take2: profile loaded, waiting for data...", flush=True)
        await wait_for_text(p2, "Genesis")
        await p2.wait_for_timeout(2000)
        print("take2: data loaded, lingering", flush=True)
        await p2.wait_for_timeout(6000)
        await smooth_scroll(p2, 300, steps=6, step_delay=0.5)
        await p2.wait_for_timeout(3000)
        await ctx2.close()
        print("take2 done", flush=True)
        await browser.close()

asyncio.run(main())
