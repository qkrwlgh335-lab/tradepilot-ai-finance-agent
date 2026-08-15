import {
  createMarketDataMeta,
  validateMarketSourceCatalog,
} from "./market-data.js";

const EVALUATION_PATH = "generated/evaluation-report.json";

const isSafeEvaluationPath = (value) =>
  typeof value === "string"
  && /^(?:data|eval|js|scripts)\/[a-zA-Z0-9._/-]+$/.test(value)
  && !value.includes("..")
  && !value.includes("\\");

function evaluationManifestIsValid(sourceFiles) {
  return Array.isArray(sourceFiles)
    && sourceFiles.length > 0
    && sourceFiles.every(isSafeEvaluationPath)
    && new Set(sourceFiles).size === sourceFiles.length
    && JSON.stringify(sourceFiles) === JSON.stringify([...sourceFiles].sort());
}

export async function computeEvaluationSourceDigest(sourceFiles, fetchImpl = fetch) {
  if (!evaluationManifestIsValid(sourceFiles)
      || typeof fetchImpl !== "function"
      || !globalThis.crypto?.subtle)
    throw new Error("invalid evaluation source manifest");

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = await Promise.all(sourceFiles.map(async (relativePath) => {
    const response = await fetchImpl(relativePath);
    if (!response?.ok || typeof response.arrayBuffer !== "function")
      throw new Error(`failed to load evaluation source: ${relativePath}`);
    const raw = new Uint8Array(await response.arrayBuffer());
    // Match the Node runner: UTF-8 text with CRLF normalized to LF.
    const body = encoder.encode(decoder.decode(raw).replace(/\r\n/g, "\n"));
    const prefix = encoder.encode(`${relativePath}\0`);
    const chunk = new Uint8Array(prefix.length + body.length + 1);
    chunk.set(prefix, 0);
    chunk.set(body, prefix.length);
    return chunk;
  }));
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", joined));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createSnapshotSource(fetchImpl = fetch) {
  const cache = {};
  const loadPath = async (file) => {
    if (!cache[file]) {
      cache[file] = (async () => {
        const res = await fetchImpl(file);
        if (!res.ok) throw new Error(`failed to load ${file}`);
        return res.json();
      })().catch((error) => {
        delete cache[file];
        throw error;
      });
    }
    return cache[file];
  };
  const load = async (file) => {
    return loadPath(`data/${file}`);
  };
  return {
    getFxRates: () => load("fx.json"),
    getCountryCatalog: () => load("country-catalog.json"),
    getCountryIndicators: async () => {
      try { return await load("country-indicators.json"); }
      catch { return { schema_version: "0", status: "unavailable", countries: {} }; }
    },
    getBilateralTrade: async () => {
      try { return await load("bilateral-trade.json"); }
      catch { return { schema_version: "0", status: "unavailable", countries: {} }; }
    },
    getProducts: async () => (await load("products.json")).products,
    getSamples: async () => (await load("samples.json")).samples,
    getFxVol: () => load("fx-vol.json"),
    getProductDocs: () => load("product-docs.json"),
    getProductEmbeddings: () => load("product-embeddings.json"),
    getOntologySchema: () => load("ontology-schema.json"),
    getKnowledgeGraph: () => load("knowledge-graph.json"),
    getEligibilityRules: () => load("eligibility-rules.json"),
    getSourceRegistry: async () => (await load("source-registry.json")).sources,
    getScenarioIntents: () => load("scenario-intents.json"),
    getScenarioIntentCorpus: () => load("scenario-intent-corpus.json"),
    getScenarioIntentEmbeddings: () => load("scenario-intent-embeddings.json"),
    getMarketDataMeta: async () => {
      const [fx, volatility] = await Promise.all([
        load("fx.json"),
        load("fx-vol.json"),
      ]);
      let catalog;
      try {
        catalog = await load("market-sources.json");
      } catch {
        return createMarketDataMeta({
          sources: [],
          fx,
          volatility,
        });
      }
      const validation = validateMarketSourceCatalog(catalog);
      if (!validation.ok) {
        return createMarketDataMeta({
          sources: [],
          fx,
          volatility,
        });
      }
      return createMarketDataMeta({
        sources: catalog.sources,
        fx,
        volatility,
      });
    },
    getEvaluationReport: async () => {
      let report;
      try {
        report = await loadPath(EVALUATION_PATH);
      } catch {
        return {
          status: "missing",
          report: null,
          current_source_digest: null,
        };
      }
      if (!report || report.schema_version !== "1"
          || !/^[a-f0-9]{64}$/.test(report.source_digest || "")
          || !evaluationManifestIsValid(report.source_files)) {
        return {
          status: "invalid",
          report: null,
          current_source_digest: null,
        };
      }
      try {
        const currentSourceDigest = await computeEvaluationSourceDigest(
          report.source_files,
          fetchImpl,
        );
        return {
          status: currentSourceDigest === report.source_digest ? "current" : "stale",
          report,
          current_source_digest: currentSourceDigest,
        };
      } catch {
        return {
          status: "stale",
          report,
          current_source_digest: null,
        };
      }
    },
  };
}
