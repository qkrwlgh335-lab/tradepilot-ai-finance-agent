// 유동성 완충 입력 검증. 잘못된 값이 확인 화면에 "사용자가 확정한 값"으로 표시되면 안 되므로
// 확인 화면 진입 전에 막는다. 엔진(errors.js)의 fail-closed 검증은 이중 방어로 그대로 둔다.
export function validateLiquidity(raw = {}) {
  const errors = [];
  const normalized = {};
  const fields = [
    ["openingBalanceKrw", "기초 현금잔고"],
    ["creditLineKrw", "사용 가능 신용한도"],
  ];
  for (const [key, label] of fields) {
    const src = raw[key];
    const text = src === undefined || src === null ? "" : String(src).trim();
    if (text === "") { normalized[key] = 0; continue; } // 빈 칸 = 입력하지 않음
    const v = Number(text);
    if (!Number.isFinite(v)) errors.push(`${label}: 숫자로 입력하세요.`);
    else if (v < 0) errors.push(`${label}: 0 이상으로 입력하세요.`);
    else normalized[key] = v;
  }
  if (errors.length) return { ok: false, errors, normalized: { openingBalanceKrw: 0, creditLineKrw: 0 } };
  return { ok: true, errors, normalized };
}

// 기존 헤지 입력 검증(순수함수). 미완성 행을 조용히 버리거나 빈 만기를 0으로 바꾸지 않는다.
// mode: "unknown" = 모름(질문) / "none" = 사용자가 '없음' 버튼을 누름 / "list" = 행 입력
// 반환 value: undefined(모름) | [](없음 확정) | 정규화된 배열
export function validateExistingHedges({ mode = "unknown", rows = [] } = {}) {
  if (mode === "unknown") return { ok: true, value: undefined, errors: [] };
  if (mode === "none") return { ok: true, value: [], errors: [] };

  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push({ row: null, field: null, message: "기존 헤지를 최소 1건 입력하거나 '없음'으로 확정하세요." });
    return { ok: false, value: null, errors };
  }

  const value = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    const currency = String(r.currency ?? "").trim();
    const amountText = String(r.amount ?? "").trim();
    const maturityText = String(r.maturityMonths ?? "").trim();
    const instrumentType = String(r.instrumentType ?? "").trim();

    if (!currency) errors.push({ row: n, field: "currency", message: `${n}행: 헤지 통화를 선택하세요.` });

    let amount = NaN;
    if (amountText === "") errors.push({ row: n, field: "amount", message: `${n}행: 헤지 금액을 입력하세요.` });
    else {
      amount = Number(amountText);
      if (!Number.isFinite(amount) || amount <= 0)
        errors.push({ row: n, field: "amount", message: `${n}행: 헤지 금액을 0보다 큰 숫자로 입력하세요.` });
    }

    let maturityMonths = NaN;
    if (maturityText === "") errors.push({ row: n, field: "maturityMonths", message: `${n}행: 헤지 만기(개월)를 입력하세요. 비워두면 0으로 처리하지 않습니다.` });
    else {
      maturityMonths = Number(maturityText);
      if (!Number.isFinite(maturityMonths) || maturityMonths < 0)
        errors.push({ row: n, field: "maturityMonths", message: `${n}행: 헤지 만기(개월)를 0 이상 숫자로 입력하세요.` });
    }

    if (currency && Number.isFinite(amount) && amount > 0 && Number.isFinite(maturityMonths) && maturityMonths >= 0) {
      const item = { currency, amount, maturityMonths };
      if (instrumentType) item.instrumentType = instrumentType;
      value.push(item);
    }
  });

  return errors.length ? { ok: false, value: null, errors } : { ok: true, value, errors: [] };
}

// Pure input validation/normalization for user-entered cashflow rows.
// A row: { country, currency, direction: "in"|"out", amount, months }
export function validateCashflows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, errors: ["거래를 최소 1건 입력하세요."], normalized: [] };
  }
  const errors = [];
  const normalized = [];
  rows.forEach((row, i) => {
    const n = i + 1;
    const country = String(row.country || "").trim();
    const currency = String(row.currency || "").trim();
    const direction = row.direction;
    const amount = Number(row.amount);
    const months = Number(row.months);
    const dirOk = direction === "in" || direction === "out";
    const amountOk = Number.isFinite(amount) && amount > 0;
    const monthsOk = Number.isFinite(months) && months >= 0;

    if (!country) errors.push(`${n}행: 거래국을 선택하세요.`);
    if (!currency) errors.push(`${n}행: 통화를 선택하세요.`);
    if (!dirOk) errors.push(`${n}행: 수취/지급을 선택하세요.`);
    if (!amountOk) errors.push(`${n}행: 금액을 0보다 큰 숫자로 입력하세요.`);
    if (!monthsOk) errors.push(`${n}행: 시점(개월)을 0 이상 숫자로 입력하세요.`);

    if (country && currency && dirOk && amountOk && monthsOk) {
      // tradeType은 여기서 하드 검증하지 않는다(누락은 buildProfile이 질문으로 표면화).
      // 다만 값은 반드시 통과시켜 온톨로지 프로파일이 수출/수입을 집계할 수 있게 한다.
      const n = { country, currency, direction, amount, months };
      if (row.tradeType !== undefined) n.tradeType = row.tradeType;
      if (row.transaction_id !== undefined) n.transaction_id = row.transaction_id;
      normalized.push(n);
    }
  });
  return { ok: errors.length === 0, errors, normalized };
}
