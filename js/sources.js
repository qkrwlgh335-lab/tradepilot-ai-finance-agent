// 공개용 근거 레지스트리. 포트폴리오 공개본에서는 실제 기관 상품조건 대신
// 이 저장소의 합성 규칙 사양에 연결된 출처만 활성화한다.
// 잘못된 항목은 throw로 앱을 중단하지 않고 해당 항목만 inactive 처리한다(fail-closed).
// canonical: product_id는 접두사 없음("fwd"), source_id는 "src:" 접두사. 둘을 혼용하지 않는다.

const REQUIRED_STRING_FIELDS = ["source_id", "product_id", "institution", "document_title", "url", "source_kind", "verification_status", "verified_on", "page_or_section"];
const SOURCE_ID_RE = /^src:[a-z0-9][a-z0-9:_-]*$/;
const PRODUCT_ID_RE = /^[a-z][a-z0-9_]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_KINDS = new Set(["product_terms", "market_data"]);
const VERIFICATION_STATUSES = new Set(["verified", "unverified"]);

const PUBLIC_DEMO_SPEC_HOST = "github.com";
const PUBLIC_DEMO_SPEC_PATH = "/qkrwlgh335-lab/tradepilot-ai-finance-agent/blob/main/docs/PUBLIC_DEMO_RULES.md";

// 합성 상품조건은 이 공개 저장소의 고정 문서만 근거로 허용한다.
// 임의 GitHub 문서나 외부 블로그가 verified로 주입되어도 활성화되지 않는다.
function isTrustedProductTermsUrl(url) {
  return url.hostname === PUBLIC_DEMO_SPEC_HOST && url.pathname === PUBLIC_DEMO_SPEC_PATH;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

// 실제 달력에 존재하는 ISO 날짜인지 검증(2026-02-30 같은 값 거부).
function isRealIsoDate(v) {
  if (!isNonEmptyString(v) || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 형식·값 제약을 모두 만족해야 well-formed. 하나라도 어긋나면 그 항목은 inactive.
function isWellFormed(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  for (const f of REQUIRED_STRING_FIELDS) if (!isNonEmptyString(s[f])) return false;
  if (!SOURCE_ID_RE.test(s.source_id)) return false;
  if (!PRODUCT_ID_RE.test(s.product_id)) return false;               // prod: 도 여기서 걸림
  if (!SOURCE_KINDS.has(s.source_kind)) return false;
  if (!VERIFICATION_STATUSES.has(s.verification_status)) return false;
  if (!isRealIsoDate(s.verified_on)) return false;
  if (!Array.isArray(s.supported_fields) || s.supported_fields.length === 0) return false;
  if (!s.supported_fields.every(isNonEmptyString)) return false;
  if (new Set(s.supported_fields).size !== s.supported_fields.length) return false;   // 중복 금지
  return true;
}

export function createSourceRegistry(input = []) {
  // 입력을 즉시 deep clone해 내부 snapshot으로 보관 — 이후 원본 변경이 registry에 영향 없음.
  const list = (Array.isArray(input) ? input : []).map((s) => {
    try { return structuredClone(s); } catch { return null; }
  });

  // source_id 중복은 마지막 값으로 조용히 덮어쓰지 않고, 해당 id 전체를 비활성 처리한다.
  const counts = new Map();
  for (const s of list) {
    const id = s && typeof s.source_id === "string" ? s.source_id : undefined;
    if (id !== undefined) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const byId = new Map();
  const collidingIds = new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
  for (const s of list) {
    const id = s && typeof s.source_id === "string" ? s.source_id : undefined;
    if (id === undefined) continue;
    byId.set(id, s);   // 참조는 두되, 중복 id는 아래 isActive에서 차단
  }

  function isActive(source_id) {
    if (typeof source_id !== "string") return false;
    if (collidingIds.has(source_id)) return false;      // 중복 id는 비활성
    const s = byId.get(source_id);
    if (!isWellFormed(s)) return false;
    if (s.verification_status !== "verified") return false;
    let url;
    try { url = new URL(s.url); } catch { return false; }
    if (url.protocol !== "https:") return false;
    if (!isTrustedProductTermsUrl(url)) return false;
    return true;
  }

  // 반환값은 깊은 복사 — 호출자가 바꿔도 내부 registry는 불변.
  // 중복 source_id는 마지막 항목을 조용히 반환하지 않고 null 로 막는다(fail-closed).
  function get(source_id) {
    if (typeof source_id !== "string" || collidingIds.has(source_id)) return null;
    const s = byId.get(source_id);
    return s ? structuredClone(s) : null;
  }

  // 조건이 모두 참일 때만 true: 활성 + 상품조건 근거(product_terms) + 같은 product_id + 해당 field 지원.
  // market_data 는 상품 조건의 근거가 될 수 없다(시장데이터 지원은 별도 API로 분리, 이번 범위 밖).
  function canSupport(source_id, product_id, field) {
    if (!isActive(source_id)) return false;
    const s = byId.get(source_id);
    return s.source_kind === "product_terms" && s.product_id === product_id && s.supported_fields.includes(field);
  }

  return {
    isActive,
    get,
    canSupport,
    activeIds: () => [...byId.keys()].filter(isActive),
    // 중복 id는 외부로 새어나가지 않게 all()에서도 제외.
    all: () => [...byId.entries()].filter(([id]) => !collidingIds.has(id)).map(([, s]) => structuredClone(s)),
  };
}
