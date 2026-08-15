export const A_SA_CASHFLOWS = [
  { currency: "USD", direction: "in", amount: 300000, months: 3 },
  { currency: "USD", direction: "out", amount: 100000, months: 2 },
  { currency: "EUR", direction: "out", amount: 80000, months: 4 },
];

export function computeNetExposure(cashflows) {
  const byCcy = new Map();
  for (const cf of cashflows) {
    if (!byCcy.has(cf.currency)) byCcy.set(cf.currency, { currency: cf.currency, receivable: 0, payable: 0 });
    const row = byCcy.get(cf.currency);
    if (cf.direction === "in") row.receivable += cf.amount;
    else row.payable += cf.amount;
  }
  const rows = [...byCcy.values()].map((r) => ({ ...r, net: r.receivable - r.payable }));
  rows.sort((a, b) => a.currency.localeCompare(b.currency));
  return rows;
}
