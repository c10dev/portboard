// Inline SVG sparklines (no libraries). Values are fractions on [0, scale]; null is a gap, never 0.

const NS = 'http://www.w3.org/2000/svg';

export function svg(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** Line + area paths for values on [0, scale] in a w×h box; consecutive non-null runs only, so gaps stay gaps. */
export function paths(vals, w, h, scale) {
  const n = vals.length;
  const x = (i) => (n === 1 ? w : (i / (n - 1)) * w);
  const y = (v) => h - Math.min(1, v / scale) * (h - 1.5) - 0.75;
  let line = '';
  let area = '';
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) run.push([run[0][0] + 0.01, run[0][1]]);
    line += `M${run.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join('L')}`;
    area += `M${run[0][0].toFixed(2)},${h}L${run.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join('L')}L${run[run.length - 1][0].toFixed(2)},${h}Z`;
    run = [];
  };
  vals.forEach((v, i) => (v === null ? flush() : run.push([x(i), y(v)])));
  flush();
  return { line, area };
}

/** A small sparkline: <svg class="spark kind"> sized by CSS */
export function sparkline(vals, { kind = 'cpu', scale = 1, label = '' } = {}) {
  const w = 100, h = 24;
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', class: `spark ${kind}`, role: 'img', 'aria-label': label });
  const { line, area } = paths(vals, w, h, scale);
  s.append(svg('path', { d: area, class: 'area' }), svg('path', { d: line, class: 'line', 'vector-effect': 'non-scaling-stroke' }));
  return s;
}
