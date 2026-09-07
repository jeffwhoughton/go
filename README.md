# Go — offline PWA vs the KataGo network

A progressive web app that plays Go against a KataGo neural network entirely
on-device. No server, no connection needed after the first load.

* **Board sizes** 9×9, 13×13, 19×19
* **22 strength settings** in one dropdown, roughly 30 kyu to full strength
* You always play **Black**; the AI plays White
* Chinese rules, area scoring, komi 7.5, positional superko
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

**Scoring.** Scores shown are Chinese area scores, which is what KataGo is
trained on, so they match the final result exactly. At the end of the game dead
stones are identified from the ownership head, removed, and the board is scored
strictly.

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
