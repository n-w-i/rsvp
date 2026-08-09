// Runs the real extractor over each paper and reports the signals that matter:
// did we find the structure, and are we reading things we shouldn't be.
window.__audit = async (names) => {
  const { extractPdf } = await import('/js/extract.js');
  const { tokenize } = await import('/js/tokenize.js');
  const out = [];

  for (const name of names) {
    try {
      const buf = await fetch(`/_papers/${name}.pdf`).then((r) => r.arrayBuffer());
      const { blocks, numPages, title } = await extractPdf(buf);
      const kept = blocks.filter((b) => !b.noise);
      const prose = kept.filter((b) => !b.heading);
      const headings = kept.filter((b) => b.heading);
      const tokens = tokenize(blocks, { chunkSize: 1, skipNoise: true });

      // Red flags
      const emails = prose.filter((b) => /\S+@\S+\.\S/.test(b.text)).length;
      const citationsLeft = prose.filter((b) => /\[\d+(,\s*\d+)*\]/.test(b.text)).length;
      // prose-shaped blocks we discarded — the expensive kind of mistake
      const droppedProse = blocks.filter(
        (b) =>
          b.noise &&
          b.text.length > 120 &&
          (b.text.match(/\p{L}/gu) || []).length / b.text.length > 0.8 &&
          /[.?!]$/.test(b.text) &&
          !/^(figure|fig\.?|table|algorithm)\s*\d+\s*[:.]/i.test(b.text) &&
          !/^[∗*†‡§¶]/.test(b.text),
      );
      const firstProse = prose[0]?.text.slice(0, 60) ?? '(none)';
      const levels = headings.reduce((a, h) => ((a[h.level] = (a[h.level] || 0) + 1), a), {});

      out.push({
        name,
        title: (title || '').slice(0, 42),
        pages: numPages,
        words: prose.reduce((a, b) => a + b.text.split(' ').length, 0),
        headings: headings.length,
        levels,
        skipPct: Math.round((blocks.filter((b) => b.noise).length / blocks.length) * 100),
        emails,
        citationsLeft,
        droppedProse: droppedProse.length,
        droppedSample: droppedProse[0]?.text.slice(0, 80) ?? '',
        firstProse,
        toc: headings.slice(0, 40).map((h) => '  '.repeat((h.level || 1) - 1) + h.text.slice(0, 52)),
        tokens: tokens.length,
      });
    } catch (e) {
      out.push({ name, error: String(e).slice(0, 160) });
    }
  }
  return out;
};
