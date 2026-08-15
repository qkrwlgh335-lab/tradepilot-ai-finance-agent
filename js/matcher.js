export function buildProfile(netRows, cashflows, { isSme = true } = {}) {
  return {
    isSme,
    hasExport: cashflows.some((c) => c.direction === "in"),
    hasImport: cashflows.some((c) => c.direction === "out"),
    maxNetExposure: netRows.reduce((m, r) => Math.max(m, Math.abs(r.net)), 0),
  };
}

export function matchProducts(products, profile) {
  return products.filter((p) => {
    const { when, value } = p.match;
    switch (when) {
      case "net_exposure_over": return profile.maxNetExposure >= value;
      case "is_sme": return profile.isSme === value;
      case "has_export": return profile.hasExport === value;
      case "has_import": return profile.hasImport === value;
      case "is_sme_exporter": return profile.isSme && profile.hasExport;
      default: return false;
    }
  });
}
/** @deprecated T7.3부터 런타임 상품 판정은 온톨로지 reasoner가 담당한다. T15b 승인 전 호환 테스트용으로만 보존. */
