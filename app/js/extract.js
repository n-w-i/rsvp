import * as pdfjs from '../vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

// Bump when extraction changes shape, so documents imported under an older version
// are rebuilt instead of keeping their stale blocks forever.
export const EXTRACTOR_VERSION = 14;

const LIGATURES = [[/ﬀ/g, 'ff'], [/ﬁ/g, 'fi'], [/ﬂ/g, 'fl'], [/ﬃ/g, 'ffi'], [/ﬄ/g, 'ffl'], [/ﬅ/g, 'st']];

function normalize(s) {
  let out = s.normalize('NFKC');
  for (const [re, rep] of LIGATURES) out = out.replace(re, rep);
  return out
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[­​﻿]/g, '')
    .replace(/[\t   ]/g, ' ')
    .replace(/ {2,}/g, ' ');
}

function toItems(rawItems) {
  const items = [];
  for (const it of rawItems) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, , x, y] = it.transform;
    // Rotated runs are sidebars and watermarks (arXiv stamps, "CONFIDENTIAL"), not prose.
    if (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(a) * 0.05) continue;
    items.push({ x, y, w: it.width || 0, str: it.str, size: Math.abs(it.transform[3]) || it.height || 10 });
  }
  return items;
}

// The gutter of a two-column page is a vertical strip near the middle that no text
// crosses. Finding it before lines are assembled is essential: bucketing by baseline
// alone would fuse a left-column line to the right-column line beside it, which reads
// as two interleaved half-sentences.
function findGutter(items, pageWidth) {
  if (!pageWidth || items.length < 40) return null;
  // Exact coverage, no rounding outwards: a column gutter is only a few points wide,
  // and inflating each item's footprint by a bin at each end erases it.
  const BINS = 200;
  const covered = new Array(BINS).fill(0);
  for (const it of items) {
    const from = Math.max(0, Math.floor((it.x / pageWidth) * BINS));
    const to = Math.min(BINS - 1, Math.floor(((it.x + it.w) / pageWidth) * BINS));
    for (let i = from; i <= to; i++) covered[i]++;
  }

  // Longest empty run whose centre sits in the middle of the page.
  let best = null;
  let run = null;
  for (let i = 0; i <= BINS; i++) {
    if (i < BINS && covered[i] === 0) {
      run ??= i;
    } else if (run !== null) {
      const centre = (run + i) / 2 / BINS;
      if (centre > 0.35 && centre < 0.65 && (!best || i - run > best.to - best.from)) {
        best = { from: run, to: i };
      }
      run = null;
    }
  }
  if (!best) return null;

  const start = (best.from / BINS) * pageWidth;
  const end = (best.to / BINS) * pageWidth;
  // Both sides must carry real text, or this is just a gap inside a figure.
  const left = items.filter((it) => it.x + it.w <= end).length;
  const right = items.filter((it) => it.x >= start).length;
  if (left < items.length * 0.2 || right < items.length * 0.2) return null;
  return { start, end };
}

function bucketLines(items) {
  const lines = [];
  for (const it of items) {
    const existing = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.size * 0.35));
    if (existing) {
      existing.parts.push({ x: it.x, str: it.str, w: it.w });
      existing.size = Math.max(existing.size, it.size);
    } else {
      lines.push({ y: it.y, size: it.size, parts: [{ x: it.x, str: it.str, w: it.w }] });
    }
  }
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const p of l.parts) {
      // pdf.js splits runs mid-word; only insert a space where there is a real gap.
      if (prevEnd !== null && p.x - prevEnd > l.size * 0.16 && !/\s$/.test(text)) text += ' ';
      text += p.str;
      prevEnd = p.x + (p.w || 0);
    }
    l.text = normalize(text).trim();
    l.x = l.parts[0].x;
    l.right = Math.max(...l.parts.map((p) => p.x + (p.w || 0)));
  }
  return lines.filter((l) => l.text).sort((a, b) => b.y - a.y);
}

function pageToLines(rawItems, pageWidth) {
  const items = toItems(rawItems);
  const gutter = findGutter(items, pageWidth);
  if (!gutter) return orderPage(bucketLines(items));

  // Anything crossing the gutter runs full width — a title or a wide figure — and
  // splits the page into bands that each drain left column first, then right.
  const spanning = bucketLines(items.filter((it) => it.x < gutter.start && it.x + it.w > gutter.end));
  const left = bucketLines(items.filter((it) => it.x + it.w <= gutter.end));
  const right = bucketLines(items.filter((it) => it.x >= gutter.start && it.x + it.w > gutter.end));

  // A real two-column page has substance in both. If it doesn't, the "gutter" was an
  // accident of layout and splitting on it would scramble a perfectly good page.
  if (left.length < 3 || right.length < 3) return orderPage(bucketLines(items));

  const out = [];
  let li = 0;
  let ri = 0;
  for (const band of spanning) {
    while (li < left.length && left[li].y > band.y) out.push(left[li++]);
    while (ri < right.length && right[ri].y > band.y) out.push(right[ri++]);
    out.push(band);
  }
  while (li < left.length) out.push(left[li++]);
  while (ri < right.length) out.push(right[ri++]);
  return out;
}

// Reading order, not visual order. A two-column page sorted by height alone would
// interleave the columns line by line, so detect the gutter and drain each column
// in turn. Full-width lines (titles, section heads) split the page into bands.
function orderPage(lines) {
  const sorted = lines.sort((a, b) => b.y - a.y);
  if (sorted.length < 8) return sorted;

  const pageLeft = Math.min(...sorted.map((l) => l.x));
  const pageRight = Math.max(...sorted.map((l) => l.right));
  const mid = (pageLeft + pageRight) / 2;
  const spans = (l) => l.x < mid - 2 && l.right > mid + 2;

  if (sorted.filter(spans).length > sorted.length * 0.3) return sorted;

  const out = [];
  let band = [];
  const drain = () => {
    if (!band.length) return;
    out.push(
      ...band.filter((l) => l.right <= mid + 2),
      ...band.filter((l) => l.right > mid + 2),
    );
    band = [];
  };
  for (const line of sorted) {
    if (spans(line)) {
      drain();
      out.push(line);
    } else {
      band.push(line);
    }
  }
  drain();
  return out;
}

// Running heads and folios repeat verbatim across pages; drop anything that shows
// up in the top/bottom band of at least a third of the document.
function findRepeats(pages) {
  if (pages.length < 4) return new Set();
  const counts = new Map();
  for (const lines of pages) {
    const band = [...lines.slice(0, 2), ...lines.slice(-2)];
    for (const l of new Set(band.map((l) => l.text))) {
      const key = l.replace(/\d+/g, '#');
      if (key.length < 2 || key.length > 90) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(pages.length / 3));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Subsections are typeset barely larger than body text — sometimes identical — so size
// alone never finds them. Numbering is the reliable signal, and its depth gives the
// nesting level: "3" is level 1, "3.2" level 2, "3.2.1" level 3.
const NUMBERED_HEADING = /^(\d+(?:\.\d+){0,3})\.?\s+(\p{Lu}\S*)/u;

// Diagrams and data labels also begin with a number — "1 N [SEP] 1 M" from a BERT
// figure, "0.3 F1 behind fine-tuning" from a results plot. A section heading is
// numbered from one, and what follows the number reads like a title.
function looksNumberedHeading(text) {
  if (text.length > 90) return false;
  const match = text.match(NUMBERED_HEADING);
  if (!match || match[1].startsWith('0')) return false;
  const rest = text.slice(match[1].length).trim();
  if (rest.length < 3 || /[[\]{}=<>|]/.test(rest)) return false;
  // Needs a real word in it — "N 1 M" is a diagram, "SWAG" is a section.
  if (!/\p{L}{3,}/u.test(rest)) return false;
  const wordish = (rest.match(/[\p{L} -]/gu) || []).length;
  return wordish / rest.length > 0.75 && !/[.;,]$/.test(text);
}

function headingLevel(block, bodySize) {
  if (looksNumberedHeading(block.text)) {
    return block.text.match(NUMBERED_HEADING)[1].split('.').length;
  }
  if (block.size > bodySize * 1.45) return 1;
  return 2;
}

// Inline reference markers are pure interruption when read aloud one word at a time:
// "[13]" costs a full beat and carries nothing. Only numeric forms are stripped —
// "[sic]" and "[emphasis mine]" are real words and stay.
function stripCitations(text) {
  return text
    .replace(/\s*\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// The delimiter matters: "Table 2: Variations on..." labels a table, but
// "Table 2 summarizes our results" is a sentence about one.
const CAPTION =
  /^(figure|fig\.?|table|algorithm|listing|exhibit|chart|scheme|eq\.?|equation)\s*\d+\s*[:.：—–|]/i;
const BIBLIOGRAPHY = /^(references|bibliography|works cited|literature cited)\b/i;
// A reference entry announces itself: a bracketed number, a "Surname, I." author, or
// a year in the citation position. Appendix prose has none of these.
const REFERENCE_ENTRY =
  /^\[\d+\]|^\p{Lu}[\p{L}'’-]+,\s*\p{Lu}\.|\b(?:19|20)\d{2}[a-z]?\s*[.),]|\barXiv\b|\bdoi\b/u;

const CONTENTS_HEADING = /^(table of )?contents\b/i;
// A contents entry ends in the page number it points at, or carries dot leaders on the
// way there. Leaders can run long, so this deliberately allows a generous length.
const CONTENTS_ENTRY = /\.{3,}|\s\d{1,3}$/;

const EMAIL = /\S+@\S+\.\S/;
const FOOTNOTE_MARK = /^[∗*†‡§¶]/;
const CONTENT_START = /^(abstract|summary|introduction|contents)\b/i;

// Blocks that aren't linear prose. Flashing an equation or a bibliography entry word
// by word is noise, so mark them and let the reader skip them by default.
function classifyNoise(blocks, bodySize) {
  let inBibliography = false;

  const drop = (b, why) => {
    b.noise = true;
    b.why = why;
  };

  let inContents = false;
  let missedContents = 0;

  for (const b of blocks) {
    // A table of contents duplicates every heading in the document and reads as a
    // list of page numbers. Its entries look like headings, so clear that too or they
    // fill the contents panel with phantom sections.
    if (inContents) {
      if (b.text.length < 200 && CONTENTS_ENTRY.test(b.text)) {
        b.heading = false;
        drop(b, 'contents');
        missedContents = 0;
        continue;
      }
      // One odd line shouldn't end the list — a stray artefact mid-contents would
      // otherwise let every remaining entry through as a phantom section.
      if (++missedContents >= 2) inContents = false;
    }

    if (b.heading) {
      inBibliography = BIBLIOGRAPHY.test(b.text);
      if (CONTENTS_HEADING.test(b.text)) {
        inContents = true;
        missedContents = 0;
      }
      continue;
    }
    // Appendices routinely follow the references, and their headings aren't always
    // detectable — so leave bibliography mode as soon as a block stops looking like
    // a reference entry, rather than swallowing everything to the end of the document.
    if (inBibliography) {
      if (REFERENCE_ENTRY.test(b.text)) {
        drop(b, 'bibliography');
        continue;
      }
      inBibliography = false;
    }
    if (CAPTION.test(b.text)) drop(b, 'caption');
    else if (EMAIL.test(b.text)) drop(b, 'email');
    else if (FOOTNOTE_MARK.test(b.text)) drop(b, 'footnote-mark');
    // Small type at the foot of the page is a footnote or a credit line. Size alone
    // is not enough: LaTeX sets abstracts and block quotes small too, and they sit
    // nowhere near the bottom.
    else if (b.size && b.size < bodySize * 0.95 && b.foot < 0.18) drop(b, 'footnote');
    else {
      // Maths and tabular debris: mostly symbols and digits rather than letters.
      const letters = (b.text.match(/\p{L}/gu) || []).length;
      if (b.text.length > 6 && letters / b.text.length < 0.55) drop(b, 'symbols');
    }
  }

  dropContentsEntries(blocks);
  markFrontMatter(blocks);
}

// Whatever the sequential scan misses, this catches: a contents entry is a heading that
// says the same thing as a later heading, but trails a page number or dot leaders.
// Keeping the last occurrence keeps the real section and drops the phantom.
function dropContentsEntries(blocks) {
  const norm = (t) =>
    t
      .replace(/\.{2,}/g, ' ')
      .replace(/\s+\d{1,3}$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const headings = blocks.filter((b) => b.heading);
  const totals = new Map();
  for (const h of headings) totals.set(norm(h.text), (totals.get(norm(h.text)) || 0) + 1);

  const seen = new Map();
  for (const h of headings) {
    const key = norm(h.text);
    const index = seen.get(key) || 0;
    seen.set(key, index + 1);
    const isEarlierDuplicate = totals.get(key) > 1 && index < totals.get(key) - 1;
    if (isEarlierDuplicate && /\.{2,}|\s\d{1,3}$/.test(h.text)) {
      h.heading = false;
      h.noise = true;
      h.why = 'contents';
    }
  }
}

// The author list, affiliations and email block sit between the title and the abstract.
// They're the first thing you'd hear on opening a paper and never what you came for.
function markFrontMatter(blocks) {
  const start = blocks.findIndex(
    (b) => b.heading && (CONTENT_START.test(b.text) || looksNumberedHeading(b.text)),
  );
  if (start < 1 || start > 30) return; // not a paper, or no recognisable front matter

  const titleSize = Math.max(...blocks.slice(0, start).map((b) => b.size || 0));
  let titleKept = false;
  for (let i = 0; i < start; i++) {
    // Keep the title itself — it's the one thing up there worth seeing.
    if (!titleKept && blocks[i].size === titleSize) {
      titleKept = true;
      continue;
    }
    // Names, affiliations and credits are short. A long paragraph up here is the
    // abstract of a paper that never labelled it "Abstract", and must survive.
    if (blocks[i].text.length > 200) continue;
    blocks[i].noise = true;
    blocks[i].why = 'front-matter';
  }
}

// Large type alone doesn't make a heading. Cover banners and pull quotes are set big
// but read as prose; figure labels are set big but repeat. Both would otherwise turn
// into meaningless "you are here" cards, so demote them back to body text.
function demoteFalseHeadings(blocks) {
  for (const b of blocks) {
    if (!b.heading) continue;
    const lastWord = b.text.split(/\s+/).pop() ?? '';
    // Ending on a lowercase word suggests a wrapped line of prose — but only when the
    // line is long. Plenty of real headings are sentence case ("5 Related work"), and
    // an earlier version of this rule quietly deleted most of them.
    const wrappedProse =
      /^\p{Ll}/u.test(lastWord) && b.text.length > 55 && !looksNumberedHeading(b.text);
    // An enumerated list item ("1. Inner alignment: when a learned algorithm…") opens
    // exactly like a numbered heading, then keeps going for a paragraph. Headings don't.
    if (wrappedProse || /[.,;:]$/.test(b.text) || b.text.length > 120) b.heading = false;
  }

  const counts = new Map();
  for (const b of blocks) if (b.heading) counts.set(b.text, (counts.get(b.text) || 0) + 1);
  for (const b of blocks) if (b.heading && counts.get(b.text) >= 3) b.heading = false;

  // Three or more in a row is a title page or a banner, not a run of sections —
  // except when they're numbered, since "3.2" followed straight by "3.2.1" is normal.
  let start = -1;
  for (let i = 0; i <= blocks.length; i++) {
    const unnumbered =
      i < blocks.length && blocks[i].heading && !looksNumberedHeading(blocks[i].text);
    if (unnumbered) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 3) for (let j = start; j < i; j++) blocks[j].heading = false;
      start = -1;
    }
  }
}

export async function extractPdf(data, onProgress) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  const pageHeights = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    pages.push(pageToLines(content.items, viewport.width));
    pageHeights.push(viewport.height);
    page.cleanup();
    onProgress?.(i / doc.numPages);
  }

  const meta = await doc.getMetadata().catch(() => null);
  const repeats = findRepeats(pages);
  const bodySize = median(pages.flat().map((l) => l.size));

  const blocks = [];
  let buffer = null;
  const flush = () => {
    if (!buffer) return;
    const text = buffer.text.replace(/\s+/g, ' ').trim();
    if (text) {
      blocks.push({
        text,
        page: buffer.page,
        heading: buffer.heading,
        size: buffer.size,
        // Distance of the block's lowest line from the foot of the page, as a
        // fraction of page height — footnotes sit at the bottom, abstracts don't.
        foot: buffer.pageHeight ? buffer.bottom / buffer.pageHeight : 1,
      });
    }
    buffer = null;
  };

  const append = (line) => {
    buffer.size = Math.max(buffer.size, line.size);
    buffer.bottom = Math.min(buffer.bottom, line.y);
    buffer.right = Math.max(buffer.right, line.right);
    buffer.left = Math.min(buffer.left, line.x);
    buffer.lastRight = line.right;
    buffer.lastY = line.y;
    // Words broken across a line end are rejoined; everything else gets a space.
    if (/[‐-]$/.test(buffer.text) && /^[a-z]/.test(line.text)) {
      buffer.text = buffer.text.replace(/[‐-]$/, '') + line.text;
    } else {
      buffer.text += ' ' + line.text;
    }
  };

  pages.forEach((lines, pi) => {
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
    const lead = median(gaps) || bodySize * 1.2;

    // A paragraph carried over a page break keeps going only if its last line ran
    // the full measure and didn't close a sentence.
    if (buffer && (buffer.lastRight < buffer.right - bodySize * 2.5 || /[.!?]["')\]]?$/.test(buffer.text))) {
      flush();
    }
    let firstOnPage = true;

    lines.forEach((line) => {
      if (repeats.has(line.text.replace(/\d+/g, '#'))) return;
      if (/^\d{1,4}$/.test(line.text)) return; // bare page number

      const isHeading =
        (line.size > bodySize * 1.18 && line.text.length < 120) || looksNumberedHeading(line.text);
      let startsNew = !buffer || isHeading || buffer.heading;

      if (!startsNew) {
        const gap = Math.abs(buffer.lastY - line.y);
        // Every test is relative to the block being built, so an indented abstract or
        // block quote is measured against its own margins rather than the page's.
        startsNew =
          (!firstOnPage && gap > lead * 1.45) ||
          buffer.lastRight < buffer.right - bodySize * 2.5 || // previous line ended short
          line.x - buffer.left > bodySize * 0.6 || // indented: a new paragraph
          buffer.left - line.x > bodySize * 1.5; // outdented: a different text block
      }

      if (startsNew) {
        flush();
        buffer = {
          text: line.text,
          page: pi + 1,
          heading: isHeading,
          size: line.size,
          left: line.x,
          right: line.right,
          lastRight: line.right,
          lastY: line.y,
          bottom: line.y,
          pageHeight: pageHeights[pi],
        };
      } else {
        append(line);
      }
      firstOnPage = false;
    });
  });
  flush();

  demoteFalseHeadings(blocks);
  for (const b of blocks) if (b.heading) b.level = headingLevel(b, bodySize);
  classifyNoise(blocks, bodySize);
  for (const b of blocks) if (!b.noise) b.text = stripCitations(b.text);

  const firstPage = blocks.filter((b) => b.page === 1 && b.text.length > 6 && b.text.length < 200);
  const biggest = firstPage.sort((a, b) => b.size - a.size)[0];
  const title = (meta?.info?.Title || '').trim() || biggest?.text || '';

  return { blocks, numPages: doc.numPages, title };
}

export function textToBlocks(raw) {
  return normalize(raw)
    .split(/\n\s*\n+/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ text, page: 1, heading: false }));
}
