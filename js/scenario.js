export function formatKRW(n) {
  const r = Math.round(n);
  return "₩ " + r.toLocaleString("en-US");
}

export function simulateScenarios(netRows, rates, deltas = [-0.10, -0.05, 0, 0.05]) {
  return deltas.map((delta) => {
    const byCurrency = [];
    for (const row of netRows) {
      const rate = rates[row.currency];
      if (rate == null) continue;
      const shockedRate = rate * (1 + delta);
      const krwAtSpot = row.net * rate;
      const krwAtShock = row.net * shockedRate;
      byCurrency.push({
        currency: row.currency,
        net: row.net,
        rate,
        shockedRate,
        krwAtSpot,
        krwAtShock,
        pnl: krwAtShock - krwAtSpot,
      });
    }
    const totalPnl = byCurrency.reduce((s, c) => s + c.pnl, 0);
    return { delta, byCurrency, totalPnl };
  });
}
