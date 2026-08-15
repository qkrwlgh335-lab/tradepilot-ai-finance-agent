// T17-final — fixed-preset adapter.
// The natural-language parser produces only intent (type) + target. Execution magnitudes come
// SOLELY from the fixed presets defined once in scenario-plan.js (EXECUTABLE). This adapter injects
// those params so the parser never derives a number from the user's words.

import { EXECUTABLE } from "./scenario-plan.js";

// Human-facing preset magnitude label, derived from the single source (no duplicated literals).
export function presetLabelFor(type) {
  const spec = EXECUTABLE[type];
  if (!spec) return "";
  return spec.param === "pct" ? `${Math.round(spec.value * 100)}%` : `${spec.value}개월`;
}

export function presetScenarioIdFor(type) {
  return EXECUTABLE[type]?.scenarioId ?? null;
}

// Turn a parser ScenarioIntent (steps carry type + target, NO params) into a gate-ready
// ScenarioPlan whose params are the fixed presets. The result is still validated by validatePlan.
export function buildPresetPlan(intent) {
  const src = intent && typeof intent === "object" ? intent : {};
  const steps = (Array.isArray(src.steps) ? src.steps : []).map((step) => {
    const spec = EXECUTABLE[step?.type];
    const params = spec ? { [spec.param]: spec.value } : {};
    return { type: step?.type, target: step?.target ?? {}, params };
  });
  return {
    version: "1",
    steps,
    missingFacts: Array.isArray(src.missingFacts) ? src.missingFacts : [],
    unsupportedSegments: Array.isArray(src.unsupportedSegments) ? src.unsupportedSegments : [],
    confidence: typeof src.confidence === "number" ? src.confidence : 0,
  };
}
