/* visualViewport adjust — 인앱 브라우저(네이버 등) chrome이 viewport 일부를 가릴 때
   mobile-bottom-nav / bib-trigger-mobile을 동적으로 위로 이동 */
(function () {
  if (!window.visualViewport) return;
  function getEls() {
    return [
      document.querySelector(".mobile-bottom-nav"),
      document.querySelector(".bib-trigger-mobile"),
    ].filter(Boolean);
  }
  function adjust() {
    var offset = Math.max(0, window.innerHeight - window.visualViewport.height);
    // 인앱 브라우저 전화상담 바(.inapp-call-bar)가 표시되면 그 높이만큼 추가 offset
    var inapp = document.querySelector(".inapp-call-bar.visible");
    if (inapp) offset += inapp.offsetHeight;
    var t = offset > 0 ? "translateY(-" + offset + "px)" : "";
    getEls().forEach(function (el) {
      el.style.transform = t;
    });
  }
  window.visualViewport.addEventListener("resize", adjust);
  window.visualViewport.addEventListener("scroll", adjust);
  // inapp-call-bar visible 토글 감지
  function watchInapp() {
    var inapp = document.querySelector(".inapp-call-bar");
    if (!inapp) return;
    new MutationObserver(adjust).observe(inapp, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      adjust();
      watchInapp();
    });
  } else {
    adjust();
    watchInapp();
  }
})();
