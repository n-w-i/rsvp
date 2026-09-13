# Flash — RSVP PDF reader

A PDF reader that shows you one word at a time, each word positioned so the bit
your eye actually locks onto sits in the same spot every time. No eye movement,
no backtracking.

The reading part was the easy bit. Getting readable prose out of a PDF was most
of the work. Here's the whole thing start to finish, in the order I actually did
it.

## 1. What I wanted

I wanted to read papers without my eyes moving across the page. That's what
**RSVP** does — rapid serial visual presentation. You flash one word at a time in
a fixed spot, and because your eye never has to travel or jump back, you can go a
lot faster than you can reading normally.

The detail that makes it work is where you put the word. Every word has an
**optimal recognition point**, which isn't the middle — it's slightly left of it.
So each word gets positioned so that point lands in the same place on screen
every single time. Your eye just sits there.

## 2. One codebase, two ways to run it

I wanted it on my laptop and my phone, and I also wanted it to grab PDFs I was
already looking at in the browser. So it's one reader with two wrappers around
it.

- **`app/`** — the reader. A static PWA, installable on macOS and Android.
- **`extension/`** — a Chrome extension that wraps the same reader and adds
  "Read with Flash" to PDF pages, PDF links, and selected text.

`build.sh` copies `app/` into `extension/app/`, so there's only ever one reader to
maintain — re-run it after changing the reader.

No build step, no framework, plain files with relative paths. It'll run from any
static host, or from a subdirectory, and I don't have to think about it.

## 3. Running it locally

From the project root:

```bash
python3 dev-server.py
```

Then open <http://localhost:3000>. Pass a port (`python3 dev-server.py 4000`) if
that one is busy.

This is `http.server` plus `Cache-Control: no-store` — without it the browser
serves stale ES modules after an edit and you end up debugging code that isn't on
disk.

## 4. Getting readable text out of a PDF

This is the part that turned out to be most of the project. A PDF doesn't store
paragraphs — it stores **positioned glyph runs**. It knows there's an "e" at
these coordinates in this font. It has no idea what a sentence is.

So everything a reader needs has to be reconstructed. `app/js/extract.js` groups
glyph runs into lines by their baseline, and only inserts a space where there's a
real gap rather than at every run boundary. Then it rebuilds paragraphs using
margins relative to the block being built, so an indented abstract or a block
quote doesn't get shredded into a pile of one-line fragments.

## 5. All the things that break it

Then it's a long list of things that are obvious to a human reader and completely
invisible to the parser.

- **Two-column layouts** get detected and drained one column at a time in reading
  order, with full-width lines splitting the page into bands.
- **Words hyphenated across a line break** get rejoined.
- **Running heads, page numbers and rotated watermarks** get dropped.
- **A paragraph that continues across a page break** gets carried over.
- **Front matter** has to go — the author list, affiliations, emails and the
  footnotes wedged between the title and the abstract, plus anything set smaller
  than the body text.
- **Inline citation markers** (`[13]`, `[1, 2]`) get stripped out of prose. Every
  one costs you a full beat and carries nothing. But `[sic]` and other worded
  brackets get left alone, because those actually mean something.
- **Anything that isn't linear prose** — figure and table captions, equations,
  bibliography entries — gets flagged so it can be skipped rather than flashed
  word by word.

## 6. Finding the headings

Headings are shown whole, as a centred card, instead of being flashed word by
word — and the current section stays on screen above the reader so you always
know where you are.

Finding them takes two signals, not one. Type size is the obvious one, but
**subsections are usually set at body size**, so something like
`3.2.1 Scaled Dot-Product Attention` is only findable from its number. That
number is doing double duty: it tells you it's a heading, and its depth gives you
the nesting level shown in the contents panel.

Then I had to demote the *false* headings — banners set in big type, figure
labels that repeat on every page, and anything that reads like a wrapped line of
prose.

## 7. Playing it back

Playback runs on `requestAnimationFrame` rather than `setTimeout`, and that's not
a style preference. A backgrounded or occluded tab **clamps timers to roughly one
second**, which would drag every single word out to the same crawl no matter what
speed you'd set.

Controls are all one-handed:

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | one word |
| `J` `K` | one sentence |
| `↑` `↓` | speed |
| `Esc` | pause |

Tap the section name above the reader to open the contents and jump to any
heading.

Settings cover words-per-flash (1–3), typeface, word size, how long to hold on
punctuation, whether to skip non-prose, and whether to rewind slightly on resume.
Reading position is saved per document automatically.

## 8. Checking I hadn't broken it

Every one of those extraction rules is a heuristic, and **every one of them was
wrong on some real paper before it was right**. So fixing one thing quietly
breaking another is the main risk in the whole project.

`./tools/check-extraction.sh` downloads eight papers that between them cover
single-column, two-column, small-type abstracts, appendices sitting after the
references, and a table of contents. Then it installs an audit harness. Open the
app and run:

```js
await import('/_audit.js'); console.table(await __audit(['attention', 'bert', 'resnet']))
```

It reports, per paper: headings found by level, the share of blocks skipped, and
the number that actually matters — **`droppedProse`**, the count of prose-shaped
blocks the filters discarded. That should be captions and footnotes only.
Anything else is a regression.

`EXTRACTOR_VERSION` in `extract.js` gets bumped whenever extraction changes, so
documents imported under an older version are rebuilt rather than keeping stale
text — your position is carried across.

## 9. Getting it onto my devices

The app must be served over HTTPS for offline support and installation to work.
Localhost is exempt for testing, but the service worker is deliberately skipped
there so you don't fight a stale cache while editing.

`.github/workflows/pages.yml` publishes `app/` to GitHub Pages on every push to
`main`, so the site lives at the repository root URL rather than under `/app/`.
It needs Pages set to deploy from GitHub Actions once: **Settings → Pages →
Source → GitHub Actions**. Any static host works equally well.

- **macOS (Chrome/Edge):** open the site, then Install from the address bar. It
  also registers as a PDF file handler, so you get "Open with Flash" in Finder.
- **Android (Chrome):** open the site → menu → Install app. Once installed, Flash
  appears in the Android share sheet, so you can share a PDF to it from any app.

For the extension: run `./build.sh`, then go to `chrome://extensions`, enable
Developer mode, and "Load unpacked" → pick the `extension/` folder. It requests
broad host access because the reader page fetches PDFs from whatever site you're
on. If you'd rather not grant that, use the PWA and drop files in.

## 10. Privacy

Everything runs locally in the browser. PDFs are parsed on-device and stored in
IndexedDB, and **nothing is uploaded**.

## Updating pdf.js

`npm i pdfjs-dist@latest`, then copy `build/pdf.min.mjs` and
`build/pdf.worker.min.mjs` into `app/vendor/` as `pdf.mjs` and `pdf.worker.mjs`.
