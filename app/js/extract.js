import * as pdfjs from '../vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

// Bump when extraction changes shape, so documents imported under an older version
// are rebuilt instead of keeping their stale blocks forever.
export const EXTRACTOR_VERSION = 4;

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

// Text items arrive in stream order, not visual order. Bucket them into lines by
// baseline y, then sort top-to-bottom so column-less pages read correctly.
function itemsToLines(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, , x, y] = it.transform;
    // Rotated runs are sidebars and watermarks (arXiv stamps, "CONFIDENTIAL"), not prose.
    if (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(a) * 0.05) continue;
    const size = Math.abs(it.transform[3]) || it.height || 10;
    const existing = lines.find((l) => Math.abs(l.y - y) <= Math.max(2, size * 0.35));
    if (existing) {
      existing.parts.push({ x, str: it.str, w: it.width });
      existing.size = Math.max(existing.size, size);
    } else {
      lines.push({ y, size, parts: [{ x, str: it.str, w: it.width }] });
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
  return orderPage(lines.filter((l) => l.text));
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

// Blocks that aren't linear prose. Flashing an equation or a bibliography entry word
// by word is noise, so mark them and let the reader skip them by default.
function classifyNoise(blocks) {
  let inBibliography = false;

  for (const b of blocks) {
    if (b.heading) {
      inBibliography = BIBLIOGRAPHY.test(b.text);
      continue;
    }
    if (inBibliography) {
      b.noise = true;
      continue;
    }
    if (CAPTION.test(b.text)) {
      b.noise = true;
      continue;
    }

    // Maths and tabular debris: mostly symbols and digits rather than letters.
    const letters = (b.text.match(/\p{L}/gu) || []).length;
    if (b.text.length > 6 && letters / b.text.length < 0.55) b.noise = true;
  }
}

// Large type alone doesn't make a heading. Cover banners and pull quotes are set big
// but read as prose; figure labels are set big but repeat. Both would otherwise turn
// into meaningless "you are here" cards, so demote them back to body text.
function demoteFalseHeadings(blocks) {
  for (const b of blocks) {
    if (!b.heading) continue;
    const lastWord = b.text.split(/\s+/).pop() ?? '';
    // A wrapped line of prose ends mid-sentence; a real heading rarely does.
    if (/^\p{Ll}/u.test(lastWord) || /[.,;:]$/.test(b.text)) b.heading = false;
  }

  const counts = new Map();
  for (const b of blocks) if (b.heading) counts.set(b.text, (counts.get(b.text) || 0) + 1);
  for (const b of blocks) if (b.heading && counts.get(b.text) >= 3) b.heading = false;

  // Three or more in a row is a title page or a banner, not a run of sections.
  let start = -1;
  for (let i = 0; i <= blocks.length; i++) {
    if (i < blocks.length && blocks[i].heading) {
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
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items));
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
    if (text) blocks.push({ text, page: buffer.page, heading: buffer.heading, size: buffer.size });
    buffer = null;
  };

  const append = (line) => {
    buffer.size = Math.max(buffer.size, line.size);
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

      const isHeading = line.size > bodySize * 1.18 && line.text.length < 120;
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
        };
      } else {
        append(line);
      }
      firstOnPage = false;
    });
  });
  flush();

  demoteFalseHeadings(blocks);
  classifyNoise(blocks);
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
