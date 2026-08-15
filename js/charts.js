export function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

export function barChart(items, { width = 480, height = 200 } = {}) {
  const pad = 30;
  const innerH = height - pad * 2;
  const maxAbs = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  const zeroY = pad + innerH / 2;
  const bw = (width - pad * 2) / items.length * 0.6;
  const gap = (width - pad * 2) / items.length;
  let bars = "";
  items.forEach((it, idx) => {
    const x = pad + gap * idx + (gap - bw) / 2;
    const h = (Math.abs(it.value) / maxAbs) * (innerH / 2);
    const y = it.value >= 0 ? zeroY - h : zeroY;
    const color = it.color || (it.value >= 0 ? "#2f9e44" : "#d64545");
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="3"/>`;
    bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="12">${escapeXml(it.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="${pad}" y1="${zeroY}" x2="${width - pad}" y2="${zeroY}" stroke="#ccc"/>` +
    bars + `</svg>`;
}
