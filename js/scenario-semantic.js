// Local semantic front-end for T17.
// It may propose ONE intent type, but it never proposes a target, params, a
// scenario id, or an execution value. Every proposal returns to the existing
// deterministic target resolver, fixed-preset adapter, and trusted T17 gate.

import {
  buildScenarioIntentFromType,
  normalizeIntentText,
  parseScenarioIntent,
} from "./scenario-intent.js";
import { cosineSim } from "./rag.js";
import { normalizeText, textHash } from "./text-hash.js";

const TYPES = Object.freeze(["payment_delay", "receivable_drop", "adverse_fx"]);
const TYPE_SET = new Set(TYPES);
const DEFAULT_MIN_SCORE = 0.30;
const DEFAULT_MIN_MARGIN = 0.04;
const MAX_TEXT = 500;

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function semanticText(value) {
  return normalizeIntentText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compact(value) {
  return semanticText(value).replace(/\s+/g, "");
}

function ngrams(value, width = 2) {
  const source = compact(value);
  if (!source) return new Set();
  if (source.length <= width) return new Set([source]);
  const out = new Set();
  for (let i = 0; i <= source.length - width; i++) out.add(source.slice(i, i + width));
  return out;
}

function dice(a, b) {
  const left = ngrams(a);
  const right = ngrams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return (2 * overlap) / (left.size + right.size);
}

function tokenCoverage(query, prototype) {
  const q = [...new Set(semanticText(query).split(/\s+/).filter((token) => token.length >= 2))];
  const p = semanticText(prototype).split(/\s+/).filter(Boolean);
  if (!q.length || !p.length) return 0;
  const hits = q.filter((queryToken) =>
    p.some((prototypeToken) =>
      queryToken.includes(prototypeToken) || prototypeToken.includes(queryToken)));
  return hits.length / q.length;
}

function similarity(query, prototype) {
  return 0.72 * dice(query, prototype) + 0.28 * tokenCoverage(query, prototype);
}

function resultFromScores(scores, {
  minScore = DEFAULT_MIN_SCORE,
  minMargin = DEFAULT_MIN_MARGIN,
  mode = "keyword",
} = {}) {
  const ranked = TYPES
    .map((type) => ({ type, score: Number.isFinite(scores[type]) ? scores[type] : 0 }))
    .sort((a, b) => b.score - a.score || TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
  const best = ranked[0];
  const margin = best.score - ranked[1].score;
  const confidence = Math.max(0, Math.min(1, best.score));
  if (best.score < minScore)
    return { status: "low_confidence", type: null, confidence, margin, mode, scores, ranked };
  if (margin < minMargin)
    return { status: "ambiguous", type: null, confidence, margin, mode, scores, ranked };
  return { status: "matched", type: best.type, confidence, margin, mode, scores, ranked };
}

export function validateScenarioCorpus(corpus) {
  const errors = [];
  if (!isPlainObject(corpus)) return { ok: false, errors: ["corpus must be an object"], entries: [] };
  if (corpus.version !== "1") errors.push("version must be 1");
  if (corpus.synthetic !== true) errors.push("synthetic must be true");
  if (corpus.contains_real_customer_data !== false)
    errors.push("contains_real_customer_data must be false");
  if (corpus.generator_type !== "external_ai_assisted")
    errors.push("generator_type must be external_ai_assisted");
  if (!Array.isArray(corpus.entries)) errors.push("entries must be an array");
  const entries = Array.isArray(corpus.entries) ? corpus.entries : [];
  const ids = new Set();
  for (const [index, row] of entries.entries()) {
    if (!isPlainObject(row)) { errors.push(`entries[${index}] must be an object`); continue; }
    if (typeof row.id !== "string" || !/^[a-z]{2}-\d{3}$/.test(row.id))
      errors.push(`entries[${index}].id is invalid`);
    else if (ids.has(row.id)) errors.push(`duplicate id ${row.id}`);
    else ids.add(row.id);
    if (!TYPE_SET.has(row.intent_type)) errors.push(`entries[${index}].intent_type is invalid`);
    if (typeof row.text !== "string" || !semanticText(row.text) || row.text.length > MAX_TEXT)
      errors.push(`entries[${index}].text is invalid`);
    if ("params" in row || "scenarioId" in row || "amount" in row)
      errors.push(`entries[${index}] contains execution data`);
  }
  return { ok: errors.length === 0, errors, entries };
}

export async function scenarioCorpusHash(corpus) {
  const checked = validateScenarioCorpus(corpus);
  if (!checked.ok) return "";
  const canonical = [...checked.entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => `${row.id}\t${row.intent_type}\t${normalizeText(row.text)}`)
    .join("\n");
  return textHash(canonical);
}

export function classifyKeywordIntent(text, corpus, options = {}) {
  const checked = validateScenarioCorpus(corpus);
  if (!checked.ok || typeof text !== "string" || !semanticText(text) || text.length > MAX_TEXT)
    return resultFromScores({}, { ...options, mode: "keyword" });
  const scores = Object.fromEntries(TYPES.map((type) => [type, 0]));
  for (const row of checked.entries)
    scores[row.intent_type] = Math.max(scores[row.intent_type], similarity(text, row.text));
  return resultFromScores(scores, { ...options, mode: "keyword" });
}

export async function validateScenarioEmbeddingSnapshot(corpus, embeddings) {
  const corpusCheck = validateScenarioCorpus(corpus);
  const errors = [...corpusCheck.errors];
  if (!isPlainObject(embeddings)) return { ok: false, errors: [...errors, "embeddings must be an object"] };
  if (typeof embeddings.model !== "string" || !embeddings.model.trim()) errors.push("model is invalid");
  if (!Number.isInteger(embeddings.dimension) || embeddings.dimension <= 0) errors.push("dimension is invalid");
  if (embeddings.normalized_text_hash !== await scenarioCorpusHash(corpus))
    errors.push("normalized_text_hash is stale");
  if (!Array.isArray(embeddings.vector_keys)) errors.push("vector_keys must be an array");
  if (!isPlainObject(embeddings.vectors)) errors.push("vectors must be an object");
  const expected = corpusCheck.entries.map((row) => row.id).sort();
  const keys = isPlainObject(embeddings.vectors) ? Object.keys(embeddings.vectors).sort() : [];
  const declared = Array.isArray(embeddings.vector_keys) ? [...embeddings.vector_keys].sort() : [];
  if (JSON.stringify(expected) !== JSON.stringify(keys)) errors.push("vector key set does not match corpus");
  if (JSON.stringify(expected) !== JSON.stringify(declared)) errors.push("vector_keys do not match corpus");
  for (const row of corpusCheck.entries) {
    const stamped = embeddings.vectors?.[row.id];
    if (!isPlainObject(stamped)) { errors.push(`${row.id} vector is missing`); continue; }
    if (stamped.intent_type !== row.intent_type) errors.push(`${row.id} intent_type is stale`);
    if (stamped.text_hash !== await textHash(row.text)) errors.push(`${row.id} text_hash is stale`);
    if (!Array.isArray(stamped.vector)
        || stamped.vector.length !== embeddings.dimension
        || !stamped.vector.every(Number.isFinite))
      errors.push(`${row.id} vector dimension is invalid`);
  }
  return { ok: errors.length === 0, errors };
}

export function createScenarioSemanticClassifier({
  corpus,
  embeddings = null,
  extractorFactory = null,
  minScore = DEFAULT_MIN_SCORE,
  minMargin = DEFAULT_MIN_MARGIN,
  timeoutMs = 20_000,
} = {}) {
  let modelState = "idle";
  let extractor = null;
  let snapshotCheckPromise = null;

  async function snapshotIsCurrent() {
    if (!snapshotCheckPromise)
      snapshotCheckPromise = validateScenarioEmbeddingSnapshot(corpus, embeddings);
    return (await snapshotCheckPromise).ok;
  }

  async function ensureModel() {
    if (extractor || modelState === "failed" || modelState === "stale") return extractor;
    if (!(await snapshotIsCurrent())) { modelState = "stale"; return null; }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      modelState = "failed";
      return null;
    }
    modelState = "loading";
    let timer;
    try {
      const load = (async () => {
        if (extractorFactory) return await extractorFactory(embeddings.model);
        const mod = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers");
        return await mod.pipeline("feature-extraction", embeddings.model);
      })();
      extractor = await Promise.race([
        load,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("model_timeout")), timeoutMs);
        }),
      ]);
      modelState = "ready";
      return extractor;
    } catch {
      extractor = null;
      modelState = "failed";
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    state: () => modelState,
    async classify(text) {
      const keyword = classifyKeywordIntent(text, corpus, { minScore, minMargin });
      const model = await ensureModel();
      if (!model) return keyword;
      try {
        const output = await model(`query: ${normalizeText(text)}`, { pooling: "mean", normalize: true });
        const queryVector = Array.from(output.data);
        if (queryVector.length !== embeddings.dimension || !queryVector.every(Number.isFinite))
          throw new Error("invalid_query_vector");
        const semanticScores = Object.fromEntries(TYPES.map((type) => [type, 0]));
        for (const row of corpus.entries) {
          const score = cosineSim(queryVector, embeddings.vectors[row.id].vector);
          semanticScores[row.intent_type] = Math.max(semanticScores[row.intent_type], score);
        }
        const combined = {};
        for (const type of TYPES)
          combined[type] = 0.65 * semanticScores[type] + 0.35 * (keyword.scores[type] || 0);
        return resultFromScores(combined, { minScore, minMargin, mode: "hybrid" });
      } catch {
        extractor = null;
        modelState = "failed";
        return keyword;
      }
    },
  };
}

function needsSemanticFallback(intent) {
  return intent.steps.length === 0
    && intent.unsupportedSegments.length === 1
    && intent.unsupportedSegments[0]?.reasonCode === "intent_unmatched";
}

export async function interpretScenarioIntent(text, context = {}, classifier = null) {
  const deterministic = parseScenarioIntent(text, context);
  if (!needsSemanticFallback(deterministic) || !classifier || typeof classifier.classify !== "function")
    return { intent: deterministic, mode: "rules", classification: null };

  let classification;
  try {
    classification = await classifier.classify(text);
  } catch {
    classification = { status: "low_confidence", type: null, confidence: 0, mode: "keyword" };
  }
  if (classification?.status === "matched" && TYPE_SET.has(classification.type)) {
    const intent = buildScenarioIntentFromType(
      classification.type,
      text,
      context,
      classification.confidence,
    );
    return { intent, mode: classification.mode || "keyword", classification };
  }

  const confidence = Number.isFinite(classification?.confidence)
    ? Math.max(0, Math.min(1, classification.confidence))
    : 0;
  const intent = {
    version: "1",
    steps: [],
    magnitudeSource: "fixed_preset",
    missingFacts: [{
      field: "scenario_type",
      question: "입금 지연, 매출·수취액 감소, 불리한 환율 중 어느 상황인지 더 구체적으로 알려주세요.",
    }],
    unsupportedSegments: [],
    confidence,
  };
  return { intent, mode: classification?.mode || "keyword", classification };
}
