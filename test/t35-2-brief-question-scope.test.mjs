import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildBrief, questionsForRecommendation } from "../js/brief.js";

const recommendation = {
  pending: [
    {
      product_id: "trade_loan",
      name: "무역금융 대출",
      questions: ["최근 1년 수출실적(USD)을 입력해 주세요."],
    },
    {
      product_id: "trade_loan",
      name: "무역금융 대출",
      questions: ["최근 1년 수출실적(USD)을 입력해 주세요."],
    },
  ],
  questions: [
    "최근 1년 수출실적(USD)을 입력해 주세요.",
    "policy_fund: 확인된 공식 출처와 목적 연결 근거를 갖춘 상품이 없습니다.",
  ],
};

test("T35.2 pending questions retain their product owner and de-duplicate", () => {
  assert.deepEqual(questionsForRecommendation(recommendation), [
    {
      product_id: "trade_loan",
      productName: "무역금융 대출",
      question: "최근 1년 수출실적(USD)을 입력해 주세요.",
    },
    "policy_fund: 확인된 공식 출처와 목적 연결 근거를 갖춘 상품이 없습니다.",
  ]);
});

test("T35.2 brief labels a pending question with the product it belongs to", () => {
  const { html } = buildBrief({
    questions: questionsForRecommendation(recommendation),
    now: new Date("2026-08-02T09:30:00"),
  });
  assert.match(html, /<strong>무역금융 대출 검토 시:<\/strong> 최근 1년 수출실적\(USD\)을 입력해 주세요\./);
  assert.match(html, /policy_fund: 확인된 공식 출처/);
});

test("T35.2 structured questions escape product names and question text", () => {
  const { html } = buildBrief({
    questions: [{ product_id: "x", productName: "<상품>", question: "<확인>" }],
    now: new Date("2026-08-02T09:30:00"),
  });
  assert.match(html, /&lt;상품&gt; 검토 시/);
  assert.match(html, /&lt;확인&gt;/);
  assert.doesNotMatch(html, /<상품>|<확인>/);
});

test("T35.2 UI derives brief questions from recommendation ownership", async () => {
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /questions:\s*brief\.questionsForRecommendation\(recommendation\)/);
  assert.doesNotMatch(ui, /questions:\s*\[\.\.\.new Set\(recommendation\.questions/);
});
