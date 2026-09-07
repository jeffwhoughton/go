# Go — offline PWA vs the KataGo network

A progressive web app that plays Go against a KataGo neural network entirely
on-device. No server, no connection needed after the first load.

* **Board sizes** 9×9, 13×13, 19×19
* **24 strength settings** in one dropdown, 30 kyu to full strength, each named
* You always play **Black**; the AI plays White
* Komi 7.5, positional superko, scored by territory + prisoners
* Drag to place: press anywhere, guide lines show the target intersection,
  slide to adjust, release to play
* Live territory/score estimate from the network's ownership head
* Undo · Pass · Resign; two passes end the game and it is scored automatically
* A **PASSED** badge on a player's row whenever their last move was a pass
* **The game in progress survives closing the app** — the menu offers Resume
* **Match history**: every finished game of 6+ moves is kept, with a review
  screen you can scrub move by move
* Board size and strength are remembered between sessions

---

## Deploying to GitHub Pages (and installing on Android)

```bash
cd JeffGo
git init
git add -A
git commit -m "Go PWA"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
After a minute the app is at `https://<you>.github.io/<repo>/`.

On your Android phone, open that URL in Chrome, wait for the status line to say
**“Ready … works offline”** (that is the service worker finishing its download of
the 6 MB network), then **⋮ → Add to Home screen**. From then on it launches
full-screen and runs with no connection at all — try it in aeroplane mode.

A PWA needs an HTTPS origin, which is why a plain folder of files will not
install; GitHub Pages, Netlify, Cloudflare Pages or any static host all work.

### Testing locally first

```bash
python serve.py        # then open http://localhost:8080
```

`localhost` counts as a secure origin, so the service worker and offline mode
behave exactly as they will on the phone.

### After you change any file

Bump the cache name at the top of `sw.js` (`go-katago-v1` → `-v2`), otherwise
returning visitors keep the old cached copy.

---

## How it works

```
index.html        screens and layout
css/style.css
js/goban.js       rules: chains, captures, ko, positional superko,
                  Benson pass-alive, area scoring
js/features.js    KataGo input encoding (input version 7: 22 spatial + 19
                  global channels), ported from nninputs.cpp fillRowV7,
                  including the ladder and pass-alive-area features
js/engine.js      network wrapper + PUCT Monte-Carlo tree search
js/ui.js          canvas goban, drag-to-place, territory overlay
js/store.js       localStorage: settings, game in progress, match history
js/app.js         screens and game flow
model/            KataGo b10c128 network, TensorFlow.js graph format,
                  float16 weights (~6 MB)
js/vendor/        TensorFlow.js + its WASM backend, vendored so nothing is
                  fetched from a CDN at runtime
sw.js             precaches everything above on install
```

**The network.** There is no official KataGo WebAssembly build. This uses the
KataGo `b10c128` network converted to a TensorFlow.js graph model, with the
weights re-quantised here to float16 — half the download, and numerically
identical to three decimal places on every position tested.

The exported graph has a fixed 19×19 input tensor, but KataGo networks are
mask-aware: channel 0 marks on-board points and every pooling layer normalises
by that mask. Smaller boards are therefore encoded into the top-left corner of
the 19×19 buffer and the network masks the rest itself — verified to produce
correct, board-size-appropriate play on all three sizes.

**Search.** The raw network is roughly 2 dan. On top of it sits a PUCT tree
search using the policy, value, score and ownership heads, so the strength
settings are real search depth rather than injected noise. The lowest five
settings play from the raw policy with increasing temperature and a chance of a
random move; from “Club player” upward the search runs, up to 800 visits at
maximum with a wall-clock cap so a slow phone degrades gracefully instead of
hanging.

**Scoring.** Games are counted the Japanese way — enclosed territory, plus
prisoners taken during play, plus the opponent's dead stones, plus komi for
White. The live figure on each player's row is the *same* quantity estimated
from the ownership head, so it converges on the final count rather than jumping
to a different one at the end. Each point only contributes as far as the network
is confident about it (an empty point is worth its ownership magnitude to
whoever it favours, an enemy stone that looks dead is worth two), so an
unsettled board sits near zero for both players instead of splitting the whole
board 50/50.

The ownership head returns raw logits — KataGo's backends emit logits and leave
the final activations to the client — so `tanh` is applied before any of this.
Without it a single point can contribute more than one, and a player's score can
run negative.

The engine itself plays under KataGo's native area rules, which is the
configuration the network is strongest in. The two rulesets differ by about a
point in normal play; the visible effect is that the AI has no incentive to
avoid filling its own territory in the last few moves, which under territory
counting can cost it a point or two.

**Backends.** WebGL first, WASM second, plain CPU last. The status line on the
menu says which one is in use.

---

## Credits

* [KataGo](https://github.com/lightvector/KataGo) by lightvector (MIT) — the
  network and the input-feature specification this encoder follows
* [y-ich/KataGo](https://github.com/y-ich/KataGo) (Yuji Ichikawa) — the original
  KataGo → TensorFlow.js network conversion
* [kata-model-js](https://github.com/maksimKorzh/kata-model-js) (Maksim Korzh) —
  where this converted network was published
