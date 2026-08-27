// ============================================================
// 입찰일지 자동화 시스템 - 나라장터(G2B) 입찰공고 검색 프록시 서버
//
// 안전보건관리계획서 시스템의 nara-bid-proxy와 완전히 같은 원칙을 따른다:
//  - 서비스키는 .env에만 두고 브라우저에는 절대 노출하지 않는다.
//  - data.go.kr을 브라우저가 직접 호출하면 CORS에 막히므로 이 서버가 대신 호출한다.
//  - 실제로 "공고명·업종·지역·가격" 등으로 필터링해주는 오퍼레이션은
//    getBidPblancListInfoCnstwkPPSSrch("나라장터검색조건에 의한 공사조회")이며,
//    한 번에 조회 가능한 기간이 약 15일로 제한되어 있어 긴 기간은 15일 단위로
//    나눠 조회한 뒤 합친다. (안전보건관리계획서 프록시에서 검증된 방식과 동일)
//
// ⚠️ 주의: 이 API의 응답 필드 중 기초금액/개찰일시/투찰마감일시/업종제한 필드명은
// data.go.kr 공식문서 페이지가 자동 접근을 차단하고 있어 100% 검증하지 못했다.
// 여러 후보 필드명을 함께 매핑해두었고, 각 결과 항목에 raw(원본 응답) 필드를 포함시켜
// 화면에서 "원본 데이터 보기"로 실제 키를 바로 확인할 수 있게 했다. 특정 칸이 계속
// 비어 보이면 그 raw 데이터를 확인해 정확한 필드명으로 교체하면 된다.
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8788;
const SERVICE_KEY = process.env.NARA_SERVICE_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!SERVICE_KEY) {
  console.error("[FATAL] .env 파일에 NARA_SERVICE_KEY가 설정되어 있지 않습니다.");
  console.error("        .env.example을 복사해 .env를 만들고 발급받은 서비스키를 넣어주세요.");
  process.exit(1);
}

app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true }));

// ---------------- 공통 유틸 (안전보건관리계획서 프록시와 동일한 방식) ----------------

function buildUrl(baseUrl, params) {
  // 서비스키는 이미 인코딩된 상태로 발급되므로 URLSearchParams로 다시 감싸면
  // 이중 인코딩되어 인증에 실패한다. 서비스키만 직접 붙이고 나머지만 인코딩한다.
  const usp = new URLSearchParams(params);
  return `${baseUrl}?serviceKey=${SERVICE_KEY}&${usp.toString()}`;
}

function parseNaraResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    const header = json?.response?.header;
    const body = json?.response?.body;
    if (header && header.resultCode !== "00") {
      return { ok: false, message: header.resultMsg || "나라장터 API 오류" };
    }
    let items = body?.items || [];
    if (items && !Array.isArray(items)) items = [items];
    return { ok: true, items, totalCount: body?.totalCount || items.length };
  }
  const authMsg = trimmed.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1];
  const errMsg = trimmed.match(/<errMsg>(.*?)<\/errMsg>/)?.[1];
  const resultMsg = trimmed.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1];
  return {
    ok: false,
    message: authMsg || errMsg || resultMsg || "나라장터 API가 XML 오류 응답을 반환했습니다.",
    raw: trimmed.slice(0, 500),
  };
}

function fmt(date) {
  const p = n => String(n).padStart(2, "0");
  return (
    date.getFullYear().toString() +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    p(date.getHours()) +
    p(date.getMinutes())
  );
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "bidlog-proxy", time: new Date().toISOString() });
});

/**
 * GET /api/bidlog
 * 쿼리 파라미터:
 *   dateType    reg(입력일/게시일) | open(개찰일) | close(투찰마감일)  [기본 reg]
 *   startDate, endDate   YYYY-MM-DD (필수)
 *   industries  콤마 구분 업종명, 최대 3개, OR 조건 (예: 토목공사업,전기공사업)
 *   region      콤마 구분 지역명, OR 조건 (예: 경상남도,부산광역시)
 *   excludeInHouse  "1"이면 지역제한에 "관내"가 포함된 공고 제외
 *   priceType   presmptPrce(추정가격) | bssamt(기초금액) [기본 presmptPrce]
 *   priceMin, priceMax   원 단위 숫자
 *   excludeKeyword  콤마 구분 제외 키워드 (공고명 기준)
 *   sort        reg | open  [기본 reg, 최신순]
 *   numOfRows   결과 개수 상한 [기본 300]
 */
app.get("/api/bidlog", async (req, res) => {
  try {
    const {
      dateType = "reg",
      startDate,
      endDate,
      industries = "",
      region = "",
      excludeInHouse = "0",
      strictIndustry = "0", // "1"이면 업종 정보없음 공고를 필터에서 제외(엄격 모드)
      priceType = "presmptPrce",
      priceMin = "",
      priceMax = "",
      excludeKeyword = "",
      sort = "reg",
      numOfRows = "300",
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate, endDate가 필요합니다." });
    }

    const begin = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T23:59:59");

    // inqryDiv: 1=공고게시일시 기준, 2=개찰일시 기준.
    // "투찰마감일시" 기준 조회는 이 오퍼레이션에 별도 옵션이 없어, 게시일시 기준으로
    // 그보다 앞선 기간까지 넉넉히 가져온 뒤 실제 마감일시(bidClseDt)로 다시 걸러
    // 내는 방식으로 근사한다. (마감일은 보통 게시일로부터 며칠~몇 주 뒤이므로)
    const inqryDiv = dateType === "open" ? "2" : "1";
    const fetchBegin =
      dateType === "close" ? new Date(begin.getTime() - 45 * 24 * 60 * 60 * 1000) : begin;

    const CHUNK_DAYS = 15;
    const chunks = [];
    let chunkEnd = new Date(end);
    while (chunkEnd > fetchBegin) {
      const chunkBegin = new Date(
        Math.max(fetchBegin.getTime(), chunkEnd.getTime() - CHUNK_DAYS * 24 * 60 * 60 * 1000)
      );
      chunks.push([chunkBegin, chunkEnd]);
      chunkEnd = new Date(chunkBegin.getTime() - 60 * 1000);
    }

    let items = [];
    let lastError = null;

    for (const [cBegin, cEnd] of chunks) {
      const params = {
        type: "json",
        numOfRows: "999",
        pageNo: "1",
        inqryDiv,
        inqryBgnDt: fmt(cBegin),
        inqryEndDt: fmt(cEnd),
      };
      const url = buildUrl(
        "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwkPPSSrch",
        params
      );
      try {
        const upstream = await fetch(url);
        const text = await upstream.text();
        const parsed = parseNaraResponse(text);
        if (parsed.ok) items = items.concat(parsed.items);
        else lastError = parsed.message;
      } catch (e) {
        lastError = e.message;
      }
    }

    if (items.length === 0 && lastError) {
      return res.status(502).json({ ok: false, error: lastError });
    }

    // 실제 업종 정보는 mainCnsttyNm(주공종명) + subsiCnsttyNm1~9(부공종명, 최대 9개)에 담겨
    // 있었다("건축공사업", "토목공사업" 등 정식 면허명 그대로). 공고명 제목 키워드 매칭은
    // 부정확해서(제목에 업종이 안 드러나는 공고가 더 많았음) 폐기하고 이 필드를 쓴다.
    // 다만 소액수의계약 등 일부 공고는 이 필드 자체가 비어 있어 "정보없음"으로 표시한다.
    function normalizeIndstryty(s){ return (s||"").replace(/[ㆍ·\s]/g, ""); }

    let mapped = items.map(it => {
      const subs = Array.from({length:9}, (_,i)=> it["subsiCnsttyNm"+(i+1)]).filter(Boolean);
      const cnsttyList = [it.mainCnsttyNm, ...subs].filter(Boolean);
      return {
        게시일: it.bidNtceDt || it.bidBeginDt || it.rlDt || it.regDt || "",
        개찰일시: it.opengDt || it.opengDate || "",
        공고명: it.bidNtceNm || "",
        공고번호: (it.bidNtceNo || "") + (it.bidNtceOrd ? "-" + it.bidNtceOrd : ""),
        // ntceKindNm(공고종류명)이 "취소공고"이면 실제로 취소된 건이다.
        // (raw 데이터로 검증됨: 취소된 차수는 ntceKindNm="취소공고", 그 외에는
        //  "일반공고"/"정정공고"/"재공고" 등의 값을 갖는다.)
        공고종류: it.ntceKindNm || "",
        취소여부: it.ntceKindNm === "취소공고",
        발주기관: it.ntceInsttNm || it.dminsttNm || "",
        추정가격: it.presmptPrce ? Number(it.presmptPrce) : null,
        기초금액: it.bdgtAmt ? Number(it.bdgtAmt) : null,
        참가마감일시: it.prtcptEndDt || it.bidClseDt || "",
        투찰마감일시: it.bidClseDt || "",
        업종제한: cnsttyList.length ? cnsttyList.join(", ") : "정보없음",
        _업종정규화: normalizeIndstryty(cnsttyList.join(",")),
        지역제한: it.cnstrtsiteRgnNm || "",
        raw: it,
      };
    });

    // 업종 (OR): 실제 면허명 필드를 정규화(가운뎃점 제거)한 뒤 부분일치로 판단한다.
    // ⚠️ 소액수의계약 등 상당수 공고는 mainCnsttyNm 자체가 비어 있는데, 실제로는
    // 특정 업종이 필요한 경우가 많다(이 API 오퍼레이션의 데이터 한계로 보임). 그래서
    // 기본값은 "정보없음 공고도 일단 포함"(기회를 놓치지 않는 쪽)이며, strictIndustry=1일
    // 때만 업종이 확인된 공고만 남기는 엄격 모드로 동작한다.
    if (industries) {
      const list = industries.split(",").map(s => normalizeIndstryty(s.trim())).filter(Boolean);
      if (list.length) {
        mapped = mapped.filter(it => {
          if (it.업종제한 === "정보없음") return strictIndustry !== "1";
          return list.some(kw => it._업종정규화.includes(kw));
        });
      }
    }
    if (region) {
      const list = region.split(",").map(s => s.trim()).filter(Boolean);
      if (list.length) mapped = mapped.filter(it => list.some(kw => it.지역제한.includes(kw)));
    }
    if (excludeInHouse === "1") {
      mapped = mapped.filter(it => !it.지역제한.includes("관내"));
    }

    const priceField = priceType === "bssamt" ? "기초금액" : "추정가격";
    if (priceMin) {
      const min = Number(priceMin);
      mapped = mapped.filter(it => it[priceField] != null && it[priceField] >= min);
    }
    if (priceMax) {
      const max = Number(priceMax);
      mapped = mapped.filter(it => it[priceField] != null && it[priceField] <= max);
    }

    if (excludeKeyword) {
      const list = excludeKeyword.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      if (list.length) {
        mapped = mapped.filter(it => !list.some(kw => it.공고명.toLowerCase().includes(kw)));
      }
    }

    if (dateType === "close") {
      mapped = mapped.filter(it => {
        if (!it.투찰마감일시) return false;
        const d = it.투찰마감일시.slice(0, 10);
        return d >= startDate && d <= endDate;
      });
    }

    const sortField = sort === "open" ? "개찰일시" : "게시일";
    mapped.sort((a, b) => (b[sortField] || "").localeCompare(a[sortField] || ""));

    const seen = new Set();
    mapped = mapped.filter(it => {
      if (seen.has(it.공고번호)) return false;
      seen.add(it.공고번호);
      return true;
    });

    mapped = mapped.slice(0, parseInt(numOfRows, 10) || 300);
    mapped = mapped.map(({ _업종정규화, ...rest }) => rest); // 내부용 필드 제거

    res.json({ ok: true, count: mapped.length, items: mapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "프록시 서버 내부 오류: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[bidlog-proxy] 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`  헬스체크 : GET /health`);
  console.log(`  입찰조회 : GET /api/bidlog?startDate=2026-07-01&endDate=2026-07-31`);
});