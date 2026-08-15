import { createSourceRegistry } from "./sources.js";
import { normalizeText } from "./text-hash.js";

export const EVIDENCE_MIN_SCORE = 0.62;

export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

export function cosineTopK(queryVec, vectors, k = 5) {
  return Object.entries(vectors)
    .map(([id, v]) => ({ id, score: cosineSim(queryVec, v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const tokens = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function keywordScore(query, text) {
  // Korean attaches particles to stems without a separator ("환율을" vs "환율"),
  // so exact token equality misses. Count a doc token as a hit when it contains a
  // query token or vice-versa (substring, either direction).
  const q = [...new Set(tokens(query))];
  const t = tokens(text);
  let hits = 0;
  for (const w of t) if (q.some((qw) => w.includes(qw) || qw.includes(w))) hits++;
  return hits / (t.length + 1);
}

export function keywordTopK(query, chunks, k = 5) {
  return chunks
    .map((c) => ({ id: c.chunk_id, score: keywordScore(query, c.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function queryCoverage(query, text) {
  const queryTokens = [...new Set(tokens(query))];
  const textTokens = tokens(text);
  if (queryTokens.length === 0 || textTokens.length === 0) return 0;
  const hits = queryTokens.filter((queryToken) =>
    textTokens.some((textToken) => textToken.includes(queryToken) || queryToken.includes(textToken)));
  return hits.length / queryTokens.length;
}

function embeddingSnapshotIsCurrent(chunks, embeddings) {
  if (!embeddings || typeof embeddings !== "object") return false;
  if (typeof embeddings.model !== "string" || !Number.isInteger(embeddings.dimension) || embeddings.dimension <= 0) return false;
  if (!embeddings.vectors || typeof embeddings.vectors !== "object" || Array.isArray(embeddings.vectors)) return false;
  const chunkIds = chunks.map((chunk) => chunk.chunk_id).sort();
  const vectorIds = Object.keys(embeddings.vectors).sort();
  if (JSON.stringify(chunkIds) !== JSON.stringify(vectorIds)) return false;
  return chunks.every((chunk) => {
    const stamped = embeddings.vectors[chunk.chunk_id];
    return stamped
      && stamped.text_hash === chunk.text_hash
      && Array.isArray(stamped.vector)
      && stamped.vector.length === embeddings.dimension
      && stamped.vector.every(Number.isFinite);
  });
}

// Browser orchestrator. Ontology decides; this module can only retrieve evidence
// inside the already-selected candidate and requested-rule scope.
export function createRag({ docs, embeddings, sources = [], extractorFactory = null }) {
  const chunkIndex = {};
  for (const p of docs?.products || [])
    for (const c of p.chunks || [])
      chunkIndex[c.chunk_id] = { ...c, product: p };
  const allChunks = Object.values(chunkIndex);
  const vectorSnapshotCurrent = embeddingSnapshotIsCurrent(allChunks, embeddings);
  const sourceList = Array.isArray(sources) ? sources : (Array.isArray(sources?.sources) ? sources.sources : []);
  const registry = createSourceRegistry(sourceList);
  let st = "idle";
  let extractor = null;

  function allowedChunks(product_id, requestedRuleIds) {
    const requested = new Set(requestedRuleIds);
    return allChunks.filter((chunk) => {
      if (chunk.product_id !== product_id || chunk.product.product_id !== product_id || chunk.evidence_class !== "public_synthetic") return false;
      if (!Array.isArray(chunk.supported_rule_ids) || !chunk.supported_rule_ids.some((id) => requested.has(id))) return false;
      if (typeof chunk.source_id !== "string" || !registry.isActive(chunk.source_id)) return false;
      const source = registry.get(chunk.source_id);
      return source?.source_kind === "product_terms" && source.product_id === product_id;
    });
  }

  function hydrateEvidence(ranked, requestedRuleIds, mode, minScore) {
    const requested = new Set(requestedRuleIds);
    const evidence = [];
    for (const { chunk, score } of ranked) {
      if (!Number.isFinite(score) || score < minScore) continue;
      const source = registry.get(chunk.source_id);
      for (const rule_id of chunk.supported_rule_ids.filter((id) => requested.has(id))) {
        evidence.push({
          chunk_id: chunk.chunk_id,
          product_id: chunk.product.product_id,
          rule_id,
          matchedText: chunk.text,
          source,
          score,
          mode,
        });
      }
    }
    return evidence.length ? evidence : null;
  }

  async function ensureModel() {
    if (extractor || st === "failed" || !vectorSnapshotCurrent) {
      if (!vectorSnapshotCurrent) st = "stale";
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { st = "failed"; return; }
    st = "loading";
    let timer;
    try {
      const load = (async () => {
        if (extractorFactory) return await extractorFactory(embeddings.model);
        const mod = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers");
        return await mod.pipeline("feature-extraction", embeddings.model);
      })();
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), 20000); });
      extractor = await Promise.race([load, timeout]);
      st = "ready";
    } catch { st = "failed"; extractor = null; }
    finally { clearTimeout(timer); }
  }

  return {
    state: () => st,
    async evidenceForCandidate({
      product_id,
      rule_ids,
      query,
      minScore = EVIDENCE_MIN_SCORE,
      k = 5,
    }) {
      if (typeof product_id !== "string" || !Array.isArray(rule_ids) || rule_ids.length === 0) return null;
      if (typeof query !== "string" || query.trim() === "" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) return null;
      const scopedChunks = allowedChunks(product_id, rule_ids);
      if (scopedChunks.length === 0) return null;

      await ensureModel();
      if (extractor) {
        try {
          const out = await extractor(`query: ${normalizeText(query)}`, { pooling: "mean", normalize: true });
          const ranked = scopedChunks
            .map((chunk) => ({
              chunk,
              score: cosineSim(Array.from(out.data), embeddings.vectors[chunk.chunk_id].vector),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
          return hydrateEvidence(ranked, rule_ids, "semantic", minScore);
        } catch { st = "failed"; extractor = null; }
      }

      const ranked = scopedChunks
        .map((chunk) => ({ chunk, score: queryCoverage(query, chunk.text) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
      return hydrateEvidence(ranked, rule_ids, "keyword", minScore);
    },
  };
}
