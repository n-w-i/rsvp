// Optimal Recognition Point: the eye fixates slightly left of centre, so the word
// is shifted to hold that letter at a constant screen position.
function orpIndex(word) {
  const letters = word.replace(/^[^\p{L}\p{N}]+/u, '');
  const lead = word.length - letters.length;
  const n = letters.length;
  let i;
  if (n <= 1) i = 0;
  else if (n <= 5) i = 1;
  else if (n <= 9) i = 2;
  else if (n <= 13) i = 3;
  else i = 4;
  return Math.min(lead + i, word.length - 1);
}

const ABBREV = /^(mr|mrs|ms|dr|prof|st|jr|sr|vs|etc|e\.g|i\.e|fig|no|vol|ch|pp|al)\.$/i;

function pauseAfter(word, isLast) {
  if (isLast) return 2.4;
  if (/[.!?]["')\]]?$/.test(word) && !ABBREV.test(word)) return 2.0;
  if (/[;:]$/.test(word)) return 1.6;
  if (/[,–—]$/.test(word)) return 1.35;
  if (/["')\]]$/.test(word)) return 1.15;
  return 1;
}

function weight(word) {
  const len = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  let w = 1;
  if (len > 8) w += (len - 8) * 0.045; // long words need more fixation time
  if (/\d/.test(word)) w += 0.35; // numerals resist chunking
  return w;
}

export function tokenize(blocks, { chunkSize = 1, skipNoise = true } = {}) {
  const tokens = [];
  blocks.forEach((block, bi) => {
    if (skipNoise && block.noise) return;
    const words = block.text.split(/\s+/).filter(Boolean);

    // A heading is a signpost, not prose: show it whole, as one card, so you can
    // see where you've arrived before the section starts flashing past.
    if (block.heading) {
      tokens.push({
        text: block.text,
        orp: 0,
        weight: 1,
        pause: 1,
        block: bi,
        page: block.page,
        heading: true,
        level: block.level ?? 1,
        blockEnd: true,
        wordCount: words.length,
      });
      return;
    }

    for (let i = 0; i < words.length; i += chunkSize) {
      const group = words.slice(i, i + chunkSize);
      const text = group.join(' ');
      const last = group[group.length - 1];
      const isBlockEnd = i + chunkSize >= words.length;
      tokens.push({
        text,
        orp: chunkSize === 1 ? orpIndex(text) : orpIndex(group[0]),
        weight: group.reduce((a, w) => a + weight(w), 0) / group.length,
        pause: isBlockEnd ? Math.max(pauseAfter(last, false), 2.2) : pauseAfter(last, false),
        block: bi,
        page: block.page,
        heading: block.heading,
        blockEnd: isBlockEnd,
        wordCount: group.length,
      });
    }
  });
  return tokens;
}

export function durationMs(token, wpm, punctuationScale = 1) {
  const base = (60000 / wpm) * token.wordCount;
  // Headings are read at a glance, but need a beat to register as a change of place.
  if (token.heading) return Math.min(3000, Math.max(900, base * 1.6));
  const pause = 1 + (token.pause - 1) * punctuationScale;
  return base * token.weight * pause;
}

export function estimateMs(tokens, from, wpm, punctuationScale) {
  let total = 0;
  for (let i = from; i < tokens.length; i++) total += durationMs(tokens[i], wpm, punctuationScale);
  return total;
}

// Sentence boundaries power the "jump back a sentence" control, which is the main
// recovery action when attention slips.
export function sentenceStarts(tokens) {
  const starts = [0];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const endsSentence = /[.!?]["')\]]?$/.test(t.text) && !ABBREV.test(t.text.split(/\s+/).pop());
    if (endsSentence || t.blockEnd) starts.push(i + 1);
  }
  return [...new Set(starts)];
}
