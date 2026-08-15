// Deterministic, rule-based Korean diagnosis generated from the computed analysis.
// No LLM — this is honest, reproducible advice text (the AI key path is optional/upgradeable).
import { formatKRW } from "./scenario.js";

export function diagnose(analysis) {
  const { netRows = [], scenarios = [], countries = [], products = [], buckets = [] } = analysis;
  const lines = [];

  if (netRows.length) {
    const main = netRows.reduce((a, b) => (Math.abs(b.net) > Math.abs(a.net) ? b : a));
    const dir = main.net >= 0 ? "수취" : "지급";
    lines.push(
      `가장 크게 관리해야 할 통화는 ${main.currency}입니다 — 순노출 ${dir} ${Math.abs(main.net).toLocaleString()} ${main.currency}.`
    );
    // 상계는 같은 통화·같은 만기 안에서만 일어난다. 만기가 다른 현금흐름을 자연헤지로 부르면
    // 실제로는 남아 있는 만기별 노출과 유동성 필요를 숨기게 된다(브리지금융은 모델링하지 않음).
    for (const r of netRows) {
      const bs = buckets.filter((b) => b.currency === r.currency);
      if (!bs.length) continue;
      const perMaturity = bs
        .map((b) => `${b.months}개월 ${b.netAtMaturity >= 0 ? "수취" : "지급"} ${Math.abs(b.netAtMaturity).toLocaleString()}`)
        .join(" / ");
      const head =
        `${r.currency}: 통화 총 순노출 ${r.net >= 0 ? "+" : "−"}${Math.abs(r.net).toLocaleString()}, ` +
        `만기별 관리대상 ${perMaturity}.`;
      lines.push(
        bs.length > 1
          ? `${head} 동일 통화·동일 만기의 수취·지급만 해당 버킷에서 상계되므로, 만기가 다른 이 현금흐름은 완전한 자연헤지가 아닙니다. ` +
              `브리지금융은 모델링하지 않았으므로 만기별로 헤지·유동성을 관리해야 합니다.`
          : `${head} 동일 통화·동일 만기의 수취·지급만 해당 버킷에서 상계됩니다.`
      );
    }
  }

  if (scenarios.length) {
    const worst = scenarios.reduce((a, b) => (b.totalPnl < a.totalPnl ? b : a));
    if (worst.totalPnl < 0) {
      lines.push(
        `환율이 불리하게 ${Math.round(worst.delta * 100)}% 움직이면 원화 기준 약 ${formatKRW(worst.totalPnl)}의 ` +
          `손실 영향이 예상됩니다. 순노출에 대한 방어(헤지)를 검토하세요.`
      );
    } else {
      lines.push("현재 순노출 구조에서는 환율 변동에 따른 손실 위험이 상대적으로 제한적입니다.");
    }
  }

  if (countries.length) {
    const measured = countries.filter((country) =>
      Number.isFinite(country.exposureKrw) && Number.isFinite(country.exposureShare));
    if (measured.length) {
      const largest = measured.reduce((a, b) => b.exposureKrw > a.exposureKrw ? b : a);
      lines.push(`거래 명목 원화환산 비중이 가장 큰 거래국은 ${largest.name}(${(largest.exposureShare * 100).toFixed(1)}%)입니다. `
        + "이는 거래 집중도 참고값이며 국가위험등급이나 미래예측이 아닙니다.");
      const facts = [];
      if (largest.gdpGrowth) facts.push(`GDP 성장률 ${largest.gdpGrowth.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% (${largest.gdpGrowth.year})`);
      if (largest.inflation) facts.push(`소비자물가 상승률 ${largest.inflation.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% (${largest.inflation.year})`);
      if (facts.length) lines.push(`${largest.name}의 최신 World Bank 관측값: ${facts.join(" · ")}. 지표별 공표연도는 다를 수 있습니다.`);
    }
    const unknown = countries.filter((country) =>
      country.officialDataStatus !== "cached" || (!country.gdpGrowth && !country.inflation));
    if (unknown.length) lines.push(`공식 거시지표가 확인되지 않은 거래국: ${unknown.map((country) => country.name).join(", ")}. `
      + "미확인을 낮은 위험으로 간주하지 않으며 실제 거래 전 별도 국가·신용위험 확인이 필요합니다.");
  }

  if (products.length) {
    const names = products.slice(0, 2).map((p) => p.name).join(", ");
    lines.push(`다음 행동: ${names} 등을 금융기관 담당자와 함께 검토해보세요.`);
  }

  lines.push(
    "※ 본 진단은 입력값과 예시 데이터를 규칙에 따라 계산·요약한 참고 정보이며, 투자·금융상품 권유가 아닙니다. " +
      "실제 거래 전 금융기관 담당자 상담과 심사가 필요합니다."
  );

  return lines.join("\n\n");
}
