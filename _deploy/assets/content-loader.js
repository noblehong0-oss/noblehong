/**
 * 노블홍 콘텐츠 로더 — D1 콘텐츠 fetch 공통 헬퍼
 * Worker: https://noblehong-api.noblehong0.workers.dev/api/content
 * 사용: <script src="/assets/content-loader.js"></script>
 *      const records = await fetchModule('press', { limit: 21 });
 */
(function () {
  const API = "https://noblehong-api.noblehong0.workers.dev";

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
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.pinned) qs.set("pinned", "true");
    if (opts.offset) qs.set("offset", String(opts.offset));
    try {
      const r = await fetch(API + "/api/content?" + qs.toString());
      const d = await r.json();
      if (!d.ok) {
        console.warn("[content-loader] " + moduleKey + " not ok", d);
        return [];
      }
      return d.records || [];
    } catch (e) {
      console.error("[content-loader] " + moduleKey + " fetch failed", e);
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
    for (const el of targets) {
      const moduleKey = el.dataset.contentModule;
      const limit = Number(el.dataset.limit) || 50;
      const renderName = el.dataset.render;
      const filterType = el.dataset.videoType; // 영상타입 필터 (옵션)
      const renderer = renderers[renderName];
      if (!renderer) continue;
      let records = await fetchModule(moduleKey, { limit });
      if (filterType) {
        records = records.filter((rec) => {
          const vt = rec.fields?.["영상타입"] || "홍유진TV";
          return vt === filterType;
        });
      }
      if (!records.length) continue;
      el.innerHTML = records.map(renderer).join("");
      applyReveal(el);
    }
  }

  // 외부 노출
  window.NobleContent = {
    fetchModule,
    applyReveal,
    renderers,
    escHtml,
    autoRender,
  };

  // DOMContentLoaded 후 자동 실행
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoRender);
  } else {
    autoRender();
  }
})();
