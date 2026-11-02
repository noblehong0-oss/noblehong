/**
 * 노블홍 콘텐츠 로더 — D1 콘텐츠 fetch 공통 헬퍼
 * Worker: https://noblehong-api.noblehong0.workers.dev/api/content
 * 사용: <script src="/assets/content-loader.js"></script>
 *      const records = await fetchModule('press', { limit: 21 });
 */
(function () {
  const API = "https://noblehong-api.noblehong0.workers.dev";
  const CACHE_KEY = "noble-content-v2";
  const CACHE_TTL = 60 * 1000;
  const CACHE_ENTRIES = 20;
  const CACHE_BYTES = 1024 * 1024;
  const REQUEST_TIMEOUT = 8000;
  const MAX_CONCURRENT = 4;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  const rendered = new WeakMap();
  let active = 0;

  // Only public content is stored. Expired/oversized entries never survive a visit.
  try {
    const saved = sessionStorage.getItem(CACHE_KEY);
    if (saved && saved.length * 2 <= CACHE_BYTES) {
      const entries = JSON.parse(saved);
      if (Array.isArray(entries)) {
        entries.slice(-CACHE_ENTRIES).forEach(([key, entry]) => {
          if (entry && entry.data && entry.data.ok && Array.isArray(entry.data.records) &&
              entry.expires > Date.now() && entry.expires <= Date.now() + CACHE_TTL) {
            cache.set(key, entry);
          }
        });
      }
    }
  } catch (_) { /* Storage may be disabled; the in-memory cache still works. */ }

  function remember(key, data) {
    cache.delete(key);
    cache.set(key, { expires: Date.now() + CACHE_TTL, data });
    for (const [entryKey, entry] of cache) {
      if (entry.expires <= Date.now()) cache.delete(entryKey);
    }
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    let saved = JSON.stringify(Array.from(cache));
    while (saved.length * 2 > CACHE_BYTES && cache.size) {
      cache.delete(cache.keys().next().value);
      saved = JSON.stringify(Array.from(cache));
    }
    try { sessionStorage.setItem(CACHE_KEY, saved); } catch (_) {}
  }

  function drainQueue() {
    while (active < MAX_CONCURRENT && queue.length) {
      const run = queue.shift();
      active++;
      run().finally(() => {
        active--;
        drainQueue();
      });
    }
  }

  function requestContent(qs) {
    const key = qs.toString();
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      cache.delete(key);
      cache.set(key, hit);
      return Promise.resolve(hit.data);
    }
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 64) return Promise.reject(new Error("Content request limit reached"));
    const request = new Promise((resolve, reject) => {
      queue.push(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
          const response = await fetch(API + "/api/content?" + key, { signal: controller.signal });
          if (!response.ok) throw Object.assign(new Error("Content HTTP " + response.status), { status: response.status });
          const data = await response.json();
          if (!data.ok || !Array.isArray(data.records)) throw new Error("Invalid content response");
          remember(key, data);
          resolve(data);
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(timeout);
        }
      });
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    drainQueue();
    return request;
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(
      /[<>&"']/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  async function fetchModule(moduleKey, opts) {
    opts = opts || {};
    const qs = new URLSearchParams({ module: moduleKey });
    const limit = Number(opts.limit);
    qs.set("limit", String(Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.min(50, Math.floor(limit))) : 50));
    if (opts.pinned) qs.set("pinned", "true");
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.view === "summary") qs.set("view", "summary");
    if (opts.id) qs.set("id", String(opts.id));
    try {
      const d = await requestContent(qs);
      return d.records || [];
    } catch (e) {
      if (opts.throwOnError) throw e;
      console.warn("[content-loader] " + moduleKey + " unavailable: " + e.name);
      return [];
    }
  }

  function applyReveal(parentEl) {
    if (!parentEl || !window.gsap) return;
    const items = parentEl.querySelectorAll(".reveal");
    items.forEach((el) => {
      gsap.to(el, {
        scrollTrigger: window.ScrollTrigger && {
          trigger: el,
          start: "top 92%",
          once: true,
        },
        opacity: 1,
        y: 0,
        duration: 0.7,
        ease: "power2.out",
      });
    });
  }

  // ──────────── 페이지별 자동 렌더 함수 ────────────
  const renderers = {
    // press 카드: <div class="media-card reveal"><img class="media-card-img"...><div class="media-card-caption">...</div></div>
    pressMediaCard(rec) {
      const f = rec.fields || {};
      return (
        '<div class="media-card reveal">' +
        '<img class="media-card-img" src="' +
        escHtml(f["썸네일"] || "") +
        '" alt="' +
        escHtml(f["제목"] || "") +
        '" loading="lazy" onerror="this.style.opacity=0.3" />' +
        '<div class="media-card-caption">' +
        escHtml(f["제목"] || "") +
        "</div>" +
        "</div>"
      );
    },

    // campaign/mou 4/3 이미지 그리드 (index.html, campaign.html, about.html mou panel)
    campaign43(rec) {
      const f = rec.fields || {};
      const img = f["썸네일"] || f["사진"] || f["증빙이미지"] || "";
      const alt = f["제목"] || f["제휴사"] || "";
      return (
        '<div class="reveal" style="border-radius:8px;overflow:hidden;aspect-ratio:4/3;">' +
        '<img src="' +
        escHtml(img) +
        '" alt="' +
        escHtml(alt) +
        '" style="width:100%;height:100%;object-fit:cover;" loading="lazy">' +
        "</div>"
      );
    },

    // campaign.html .grid: card with caption
    campaignArchiveCard(rec) {
      const f = rec.fields || {};
      return (
        '<div class="card reveal">' +
        '<div class="card-img"><img src="' +
        escHtml(f["썸네일"] || "") +
        '" alt="' +
        escHtml(f["제목"] || "") +
        '" loading="lazy"></div>' +
        '<div class="card-caption">' +
        escHtml(f["제목"] || "") +
        "</div>" +
        "</div>"
      );
    },

    // about.html mou panel: card with caption
    mouCard(rec) {
      const f = rec.fields || {};
      const img = f["사진"] || "";
      const cap = f["설명"] || (f["제휴사"] || "") + " MOU 체결";
      return (
        '<div class="reveal" style="background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden;">' +
        '<div style="aspect-ratio:4/3;overflow:hidden"><img src="' +
        escHtml(img) +
        '" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy"></div>' +
        '<div style="padding:12px 14px;font-size:13px;color:var(--text-secondary);font-weight:500;">' +
        escHtml(cap) +
        "</div>" +
        "</div>"
      );
    },

    // about.html awards: award-item with year/title/desc
    awardItem(rec) {
      const f = rec.fields || {};
      return (
        '<div class="award-item reveal">' +
        '<div class="award-img-wrap"><img src="' +
        escHtml(f["증빙이미지"] || "") +
        '" alt="' +
        escHtml(f["제목"] || "") +
        '" loading="lazy"></div>' +
        '<div class="award-content">' +
        '<span class="award-year">' +
        escHtml(f["수상일"] || "") +
        "</span>" +
        '<div class="award-title">' +
        escHtml(f["제목"] || "") +
        "</div>" +
        '<div class="award-desc">' +
        escHtml(f["기관"] || "") +
        "</div>" +
        "</div>" +
        "</div>"
      );
    },

    // about.html notice: notice-item with date/title/arrow
    noticeItem(rec) {
      const f = rec.fields || {};
      return (
        '<a class="notice-item reveal" href="news_detail.html?id=' +
        escHtml(rec.id) +
        '">' +
        '<span class="notice-date">' +
        escHtml(f["게시일"] || "") +
        "</span>" +
        '<span class="notice-title">' +
        escHtml(f["제목"] || "") +
        "</span>" +
        '<span class="notice-arrow">&rsaquo;</span>' +
        "</a>"
      );
    },

    // matchinglounge.html column-card
    lovecolCard(rec) {
      const f = rec.fields || {};
      return (
        '<a href="column_detail.html?id=' +
        escHtml(rec.id) +
        '" class="column-card reveal" style="text-decoration:none;color:inherit">' +
        '<div class="column-thumb"><img src="' +
        escHtml(f["썸네일"] || "") +
        '" alt="' +
        escHtml(f["제목"] || "") +
        '" loading="lazy"><span class="ai-badge">AI생성</span></div>' +
        '<div class="column-body"><h4>' +
        escHtml(f["제목"] || "") +
        "</h4><p>" +
        escHtml(f["본문"] || "") +
        "</p></div>" +
        "</a>"
      );
    },

    // matchinglounge.html news-board-list (notice 압축형)
    newsBoardItem(rec) {
      const f = rec.fields || {};
      return (
        '<a class="news-board-item" href="news_detail.html?id=' +
        escHtml(rec.id) +
        '">' +
        '<span class="news-board-date">' +
        escHtml(f["게시일"] || "") +
        "</span>" +
        '<span class="news-board-title">' +
        escHtml(f["제목"] || "") +
        "</span>" +
        "</a>"
      );
    },

    // matchinglounge.html blog-list (#feed)
    blogFeedItem(rec) {
      const f = rec.fields || {};
      return (
        '<a href="' +
        escHtml(f["게시글링크"] || "https://blog.naver.com/noblehong") +
        '" target="_blank" class="news-blog-item">' +
        '<div class="news-blog-thumb"' +
        (f["표지이미지"]
          ? ' style="background-image:url(' +
            escHtml(f["표지이미지"]) +
            ');background-size:cover;background-position:center"'
          : "") +
        "></div>" +
        '<div class="news-blog-info">' +
        "<h5>" +
        escHtml(f["제목"] || "") +
        "</h5>" +
        "<span>" +
        escHtml(f["게시일"] || "") +
        "</span>" +
        "</div></a>"
      );
    },

    // matchinglounge.html insta-grid (#feed)
    instaGridItem(rec) {
      const f = rec.fields || {};
      const img = f["표지이미지"] || "";
      return (
        '<a href="' +
        escHtml(
          f["게시글링크"] || "https://www.instagram.com/noblehong_official/",
        ) +
        '" target="_blank" class="news-insta-item"' +
        (img
          ? ' style="background-image:url(' +
            escHtml(img) +
            ');background-size:cover;background-position:center"'
          : "") +
        "></a>"
      );
    },

    // youtube card (matchinglounge.html #youtube — 가로 16:9)
    youtubeCard(rec) {
      const f = rec.fields || {};
      const url = f["YouTubeURL"] || "";
      const m = url.match(
        /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]+)/,
      );
      const vid = m ? m[1] : "";
      const thumb =
        f["썸네일"] ||
        (vid ? "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg" : "");
      const fb = vid ? "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg" : "";
      return (
        '<a class="yt-card reveal" href="' +
        escHtml(url) +
        '" target="_blank" rel="noopener">' +
        '<div class="yt-thumb-wrap"><img src="' +
        escHtml(thumb) +
        '" ' +
        (fb
          ? "onerror=\"this.onerror=null;this.src='" + escHtml(fb) + "'\""
          : "") +
        ' alt="' +
        escHtml(f["제목"] || "") +
        '" loading="lazy" class="yt-thumb"></div>' +
        '<div class="yt-title">' +
        escHtml(f["제목"] || "") +
        "</div>" +
        "</a>"
      );
    },

    // shorts card (matchinglounge.html "짧게 보는 결혼이야기" — 세로 9:16)
    // 재생 불가(삭제/비공개) 영상은 자동 제거 — YouTube placeholder(120×90) 검증
    shortsCard(rec) {
      const f = rec.fields || {};
      const url = f["YouTubeURL"] || "";
      const m = url.match(
        /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]+)/,
      );
      const vid = m ? m[1] : "";
      const thumb =
        f["썸네일"] ||
        (vid ? "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg" : "");
      const fb = vid ? "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg" : "";
      // onload: naturalWidth<200이면 placeholder(120×90) → 카드 제거
      // onerror: hqdefault 404 → mqdefault fallback
      const onloadCheck =
        "if(this.naturalWidth>0&&this.naturalWidth<200){var c=this.closest('.shorts-card');if(c)c.remove();}";
      return (
        '<a class="shorts-card reveal" href="' +
        escHtml(url) +
        '" target="_blank" rel="noopener">' +
        '<div class="shorts-thumb"><img src="' +
        escHtml(thumb) +
        '" ' +
        (fb
          ? "onerror=\"this.onerror=null;this.src='" + escHtml(fb) + "'\" "
          : "") +
        'onload="' +
        onloadCheck +
        '" alt="' +
        escHtml(f["제목"] || "") +
        '" loading="lazy">' +
        '<div class="shorts-badge">Shorts</div>' +
        '<div class="shorts-play"><svg viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>' +
        "</div>" +
        "</a>"
      );
    },
  };

  // ──────────── 일괄 자동 렌더 ────────────
  // 페이지 안의 [data-content-module] 컨테이너 자동 처리
  async function autoRender() {
    const targets = document.querySelectorAll("[data-content-module]");
    return Promise.all(Array.from(targets, (el) => {
      if (rendered.has(el)) return rendered.get(el);
      const moduleKey = el.dataset.contentModule;
      const limit = Number(el.dataset.limit) || 50;
      const renderName = el.dataset.render;
      const filterType = el.dataset.videoType; // 영상타입 필터 (옵션)
      const renderer = renderers[renderName];
      if (!renderer) return;
      const task = (async () => {
        let records = await fetchModule(moduleKey, {
          limit,
          view: renderName === "lovecolCard" ? undefined : "summary",
        });
        if (filterType) {
          records = records.filter((rec) => {
            const vt = rec.fields?.["영상타입"] || "홍유진TV";
            return vt === filterType;
          });
        }
        if (!records.length) {
          rendered.delete(el);
          return;
        }
        el.innerHTML = records.map(renderer).join("");
        applyReveal(el);
      })();
      rendered.set(el, task);
      return task;
    }));
  }

  // 외부 노출
  let finishInitialRender;
  const ready = new Promise((resolve) => { finishInitialRender = resolve; });
  window.NobleContent = {
    fetchModule,
    applyReveal,
    renderers,
    escHtml,
    autoRender,
    ready,
  };

  // DOMContentLoaded 후 자동 실행
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => autoRender().then(finishInitialRender, finishInitialRender), { once: true });
  } else {
    autoRender().then(finishInitialRender, finishInitialRender);
  }
})();
