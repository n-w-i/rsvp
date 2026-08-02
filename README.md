# Flash — RSVP PDF reader

Reads PDFs one word at a time, each word positioned so its optimal recognition point
sits at a fixed spot on screen. No eye movement, no backtracking.

One codebase, two ways to run it:

- **`app/`** — the reader. A static PWA, installable on macOS and Android.
- **`extension/`** — a Chrome extension that wraps the same reader and adds
  "Read with Flash" to PDF pages, PDF links, and selected text.

## Run it locally

From the project root:

```bash
python3 dev-server.py
```

Then open <http://localhost:3000>. Pass a port (`python3 dev-server.py 4000`) if that one
is busy. This is `http.server` plus `Cache-Control: no-store` — without it the browser
serves stale ES modules after an edit and you end up debugging code that isn't on disk.

## Install on your devices

The app must be served over HTTPS for offline support and installation to work
(localhost is exempt for testing, but the service worker is deliberately skipped there
so you don't fight a stale cache while editing). Deploy `app/` to any static host —
GitHub Pages, Netlify, Cloudflare Pages, Vercel — then:

- **macOS (Chrome/Edge):** open the site, then Install from the address bar. It also
  registers as a PDF file handler, so you get "Open with Flash" in Finder.
- **Android (Chrome):** open the site → menu → Install app. Once installed, Flash
  appears in the Android share sheet, so you can share a PDF to it from any app.

Everything runs locally in the browser. PDFs are parsed on-device and stored in
IndexedDB; nothing is uploaded.

## Install the extension (Chrome, desktop)

```bash
./build.sh
```

Then go to `chrome://extensions`, enable Developer mode, and "Load unpacked" → pick the
`extension/` folder. `build.sh` copies `app/` into `extension/app/`, so re-run it after
changing the reader.

The extension requests broad host access because the reader page fetches PDFs from
whatever site you're on. If you'd rather not grant that, use the PWA and drop files in.

## Controls

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | one word |
| `J` `K` | one sentence |
| `↑` `↓` | speed |
| `Esc` | pause |

Tap the section name above the reader to open the contents and jump to any heading.

Settings cover words-per-flash (1–3), typeface, word size, how long to hold on
punctuation, whether to skip non-prose, and whether to rewind slightly on resume.
Reading position is saved per document automatically.

## How the text extraction works

Getting readable prose out of a PDF is most of the work — PDFs store positioned glyph
runs, not paragraphs. `app/js/extract.js` handles:

- grouping glyph runs into lines by baseline, inserting spaces only at real gaps
- detecting two-column layouts and draining each column in reading order, with
  full-width lines splitting the page into bands
- rebuilding paragraphs using margins relative to the block being built, so an indented
  abstract or block quote isn't shredded into one-line fragments
- rejoining words hyphenated across a line break
- dropping running heads, page numbers, and rotated watermarks
- carrying a paragraph across a page break when it clearly continues
- identifying section headings by type size, then demoting the false positives —
  banners set in large type, and figure labels that repeat across pages

- stripping inline citation markers (`[13]`, `[1, 2]`) from prose, since each one costs
  a full beat and carries nothing — `[sic]` and other worded brackets are left alone
- flagging what isn't linear prose (figure and table captions, equations, bibliography
  entries) so it can be skipped rather than flashed word by word

Headings are shown whole, as a centred card, instead of being flashed word by word, and
the current section stays on screen above the reader. `EXTRACTOR_VERSION` in
`extract.js` is bumped whenever extraction changes, so documents imported under an older
version are rebuilt rather than keeping stale text — your position is carried across.

Playback is driven by `requestAnimationFrame`, not `setTimeout`: a background or
occluded tab clamps timers to roughly one second, which would drag every word out to the
same crawl no matter what speed you set.

Updating pdf.js: `npm i pdfjs-dist@latest`, then copy `build/pdf.min.mjs` and
`build/pdf.worker.min.mjs` into `app/vendor/` as `pdf.mjs` and `pdf.worker.mjs`.
