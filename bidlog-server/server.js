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
import { XMLParser } from "fast-xml-parser";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8788;
const SERVICE_KEY = process.env.NARA_SERVICE_KEY;
const D2B_SERVICE_KEY = process.env.D2B_SERVICE_KEY; // 국방조달본부(D2B) — 없으면 /api/d2b는 오류 응답
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
 *   numOfRows   결과 개수 상한 [기본 2000]
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
      includeKeyword = "",
      sort = "reg",
      numOfRows = "2000",
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
    const MAX_PAGES_PER_CHUNK = 10; // 15일 구간당 최대 999*10=9990건까지 안전하게 페이징

    for (const [cBegin, cEnd] of chunks) {
      let pageNo = 1;
      let totalCount = 0;
      while (true) {
        const params = {
          type: "json",
          numOfRows: "999",
          pageNo: String(pageNo),
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
          if (parsed.ok) {
            items = items.concat(parsed.items);
            totalCount = parsed.totalCount || items.length;
          } else {
            lastError = parsed.message;
            break;
          }
        } catch (e) {
          lastError = e.message;
          break;
        }
        // 이번 15일 구간에서 아직 못 받아온 건이 남아있고, 안전 상한 안이면 다음 페이지도 요청.
        // (예: 전국+전업종처럼 필터가 넓어 15일 안에 999건을 넘는 경우를 대비)
        const fetchedSoFarInThisChunk = pageNo * 999;
        if (totalCount > fetchedSoFarInThisChunk && pageNo < MAX_PAGES_PER_CHUNK) {
          pageNo++;
        } else {
          break;
        }
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
        출처: "나라장터(G2B)",
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
    if (includeKeyword) {
      // 콤마로 여러 단어를 넣으면 OR 조건 — 그 중 하나라도 공고명에 포함되면 남긴다.
      const list = includeKeyword.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      if (list.length) {
        mapped = mapped.filter(it => list.some(kw => it.공고명.toLowerCase().includes(kw)));
      }
    }

    if (dateType === "close") {
      mapped = mapped.filter(it => {
        if (!it.투찰마감일시) return false;
        const d = it.투찰마감일시.slice(0, 10);
        return d >= startDate && d <= endDate;
      });
    }

    // 정렬: 게시일순은 최신 게시글이 위로(내림차순), 개찰일순은 개찰일시가
    // 대부분 "미래" 날짜이므로 오늘과 가장 가까운(임박한) 공고가 위로 오도록
    // 오름차순으로 정렬한다. (실무상 임박한 개찰부터 챙겨야 하기 때문)
    const sortField = sort === "open" ? "개찰일시" : "게시일";
    const sortDir = sort === "open" ? 1 : -1;
    mapped.sort((a, b) => sortDir * (a[sortField] || "").localeCompare(b[sortField] || ""));

    const seen = new Set();
    mapped = mapped.filter(it => {
      if (seen.has(it.공고번호)) return false;
      seen.add(it.공고번호);
      return true;
    });

    // 같은 bidNtceNo(공고번호, 차수 제외) 안에 "취소공고" 차수가 하나라도 있으면
    // 그 공고번호에 속한 모든 차수(원공고 포함)를 전부 취소된 것으로 표시한다.
    // (나라장터는 취소를 별도 차수의 "취소공고"로 추가 게시하는 방식이라,
    //  원공고 자체의 ntceKindNm은 "취소공고"로 안 바뀌기 때문)
    // numOfRows로 자르기 전에 계산해야 취소차수가 잘려나가도 원공고에 반영된다.
    const cancelledBaseNos = new Set(
      mapped.filter(it => it.취소여부).map(it => it.raw?.bidNtceNo).filter(Boolean)
    );
    if (cancelledBaseNos.size) {
      mapped = mapped.map(it =>
        !it.취소여부 && cancelledBaseNos.has(it.raw?.bidNtceNo)
          ? { ...it, 취소여부: true }
          : it
      );
    }

    mapped = mapped.slice(0, parseInt(numOfRows, 10) || 2000);
    mapped = mapped.map(({ _업종정규화, ...rest }) => rest); // 내부용 필드 제거

    res.json({ ok: true, count: mapped.length, items: mapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "프록시 서버 내부 오류: " + err.message });
  }
});

// ============================================================
// 국방조달본부(D2B) 시설 경쟁입찰공고 — /api/d2b
//
// 나라장터(G2B)와 다른 점:
//  - 응답이 XML만 지원된다 (JSON 없음) → fast-xml-parser로 파싱
//  - 이 오퍼레이션(getFcltyCmpetBidPblancList)에는 업종(면허)/지역/추정가격
//    필드가 아예 없다. 검색조건 화면의 업종·지역·가격 필터는 이 데이터에는
//    적용되지 않고, 날짜 범위·제외 키워드만 공통으로 적용된다.
//  - 개찰일자(opengDateBegin/End) 또는 공고일자(anmtDateBegin/End) 기준으로만
//    조회 가능하다. 투찰마감일 기준 조회 옵션은 없다.
//  - 취소 여부는 pblancSe(공고구분명)가 "취소공고"인지로 판단한다
//    (나라장터의 ntceKindNm과 같은 역할).
// ============================================================

const D2B_ENDPOINT = "https://apis.data.go.kr/1690000/BidPblancInfoService/getFcltyCmpetBidPblancList";
const d2bXmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function d2bDate(yyyymmdd) {
  const s = String(yyyymmdd || "");
  if (s.length < 8) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
function d2bDateTime(yyyymmddhhmm) {
  const s = String(yyyymmddhhmm || "");
  if (s.length < 12) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:00`;
}

app.get("/api/d2b", async (req, res) => {
  try {
    if (!D2B_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: ".env에 D2B_SERVICE_KEY가 설정되어 있지 않습니다." });
    }
    const {
      dateType = "open", // open=개찰일 기준, 그 외=공고일 기준 (D2B는 이 두 가지만 지원)
      startDate,
      endDate,
      excludeKeyword = "",
      includeKeyword = "",
      sort = "reg",
      numOfRows = "500",
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate, endDate가 필요합니다." });
    }

    const s = startDate.replace(/-/g, "");
    const e = endDate.replace(/-/g, "");

    let items = [];
    let lastError = null;
    let pageNo = 1;
    let totalCount = 0;
    const MAX_PAGES = 10;

    while (true) {
      const dateParams =
        dateType === "open"
          ? { opengDateBegin: s, opengDateEnd: e }
          : { anmtDateBegin: s, anmtDateEnd: e };
      const usp = new URLSearchParams({ pageNo: String(pageNo), numOfRows: "999", ...dateParams });
      const url = `${D2B_ENDPOINT}?serviceKey=${D2B_SERVICE_KEY}&${usp.toString()}`;

      let text;
      try {
        const upstream = await fetch(url);
        text = await upstream.text();
      } catch (e) {
        lastError = e.message;
        break;
      }

      let parsed;
      try {
        parsed = d2bXmlParser.parse(text);
      } catch (e) {
        lastError = "D2B 응답 XML 파싱 실패: " + e.message;
        break;
      }

      const header = parsed?.response?.header;
      if (header && header.resultCode !== "00") {
        lastError = header.resultMsg || "D2B API 오류";
        break;
      }

      const body = parsed?.response?.body;
      let pageItems = body?.items?.item || [];
      if (pageItems && !Array.isArray(pageItems)) pageItems = [pageItems];
      items = items.concat(pageItems);
      totalCount = parseInt(body?.totalCount, 10) || items.length;

      if (items.length >= totalCount || pageNo >= MAX_PAGES) break;
      pageNo++;
    }

    if (items.length === 0 && lastError) {
      return res.status(502).json({ ok: false, error: lastError });
    }

    let mapped = items.map(it => {
      const odr = String(it.pblancOdr || "0").padStart(3, "0");
      return {
        게시일: d2bDate(it.pblancDate),
        개찰일시: d2bDateTime(it.opengDt),
        공고명: it.cntrwkNm || "",
        공고번호: `${it.pblancNo || ""}-${odr}`,
        발주기관: it.ornt || "",
        추정가격: null, // 이 오퍼레이션에는 추정가격 필드가 없음
        기초금액: it.baseAmnt ? Number(it.baseAmnt) : null,
        참가마감일시: d2bDateTime(it.bidPartcptRegistClosDt),
        투찰마감일시: d2bDateTime(it.biddocPresentnClosDt),
        업종제한: it.busiDivs || "정보없음", // 면허 단위 업종이 아니라 물품/용역/공사 구분임
        지역제한: "", // 이 오퍼레이션에는 지역 필드가 없음
        공고종류: it.pblancSe || "",
        취소여부: it.pblancSe === "취소공고",
        출처: "국방조달본부(D2B)",
        raw: it,
      };
    });

    if (excludeKeyword) {
      const list = excludeKeyword.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
      if (list.length) mapped = mapped.filter(it => !list.some(kw => it.공고명.toLowerCase().includes(kw)));
    }
    if (includeKeyword) {
      const list = includeKeyword.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
      if (list.length) mapped = mapped.filter(it => list.some(kw => it.공고명.toLowerCase().includes(kw)));
    }

    // 취소 그룹핑: 같은 pblancNo(차수 제외) 안에 취소공고가 있으면 그룹 전체를 취소로 표시
    const cancelledBaseNos = new Set(
      mapped.filter(it => it.취소여부).map(it => it.raw?.pblancNo).filter(Boolean)
    );
    if (cancelledBaseNos.size) {
      mapped = mapped.map(it =>
        !it.취소여부 && cancelledBaseNos.has(it.raw?.pblancNo) ? { ...it, 취소여부: true } : it
      );
    }

    const sortField = sort === "open" ? "개찰일시" : "게시일";
    const sortDir = sort === "open" ? 1 : -1;
    mapped.sort((a, b) => sortDir * (a[sortField] || "").localeCompare(b[sortField] || ""));

    mapped = mapped.slice(0, parseInt(numOfRows, 10) || 500);

    res.json({ ok: true, count: mapped.length, items: mapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "D2B 프록시 서버 내부 오류: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[bidlog-proxy] 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`  헬스체크 : GET /health`);
  console.log(`  입찰조회 : GET /api/bidlog?startDate=2026-07-01&endDate=2026-07-31`);
});