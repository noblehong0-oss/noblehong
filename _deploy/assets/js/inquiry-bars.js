/* 노블홍 간편상담 바 (사이드바 B-1 + 하단 가로바 A-3) 공통 제출 핸들러
 * 9개 페이지에서 로드됨. 각 페이지 body 말미에 <script src="assets/js/inquiry-bars.js"></script> 추가.
 * 서버 엔드포인트:
 *   - /api/consultation/quick  — 사이드바 (이름 + 연락처)
 *   - /api/consultation/bar    — 하단 가로바 (이름 + 연락처 + 성별/혼인/연도 + 개인정보동의)
 */
(function () {
  "use strict";

  // 봇 감지용 로드 시각
  if (!window._barsLoadTs) window._barsLoadTs = Date.now();

  // ─── 공용 성공 모달 유틸 (뷰포트 중앙 고정) ──────────────
  function injectModalCSS() {
    if (document.getElementById("nh-success-modal-css")) return;
    var s = document.createElement("style");
    s.id = "nh-success-modal-css";
    s.textContent = [
      ".nh-success-overlay{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;",
      "background:rgba(15,20,32,0.6);backdrop-filter:blur(4px);animation:nhFadeIn 0.2s ease-out}",
      "@keyframes nhFadeIn{from{opacity:0}to{opacity:1}}",
      "@keyframes nhPop{from{transform:scale(0.9);opacity:0}to{transform:scale(1);opacity:1}}",
      ".nh-success-card{background:#fff;border-radius:16px;padding:40px 36px;max-width:440px;width:calc(100% - 48px);",
      "box-shadow:0 24px 80px rgba(0,0,0,0.25);text-align:center;animation:nhPop 0.25s ease-out}",
      ".nh-success-icon{width:64px;height:64px;border-radius:50%;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;",
      "background:linear-gradient(135deg,#4caf7a,#2a8856);color:#fff;font-size:32px;font-weight:700}",
      ".nh-success-title{font-size:22px;font-weight:700;color:#1a1410;margin:0 0 10px;letter-spacing:-0.5px}",
      ".nh-success-body{font-size:15px;color:#5c5040;line-height:1.7;margin:0 0 8px}",
      ".nh-success-body b{color:#2a1d0a}",
      ".nh-success-sub{font-size:12px;color:#8a7e60;margin:14px 0 0}",
      ".nh-success-btn{margin-top:24px;padding:12px 36px;background:#2a1d0a;color:#e7c07b;border:none;border-radius:8px;",
      "font-size:14px;font-weight:600;letter-spacing:0.5px;cursor:pointer}",
      ".nh-success-btn:hover{background:#3a2b18}",
      ".nh-error-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1000000;",
      "background:#b84040;color:#fff;padding:14px 20px;border-radius:10px;font-size:14px;max-width:480px;",
      "box-shadow:0 8px 24px rgba(184,64,64,0.4);animation:nhFadeIn 0.2s}",
    ].join("");
    document.head.appendChild(s);
  }

  window.showNobleSuccessModal = function (opts) {
    opts = opts || {};
    injectModalCSS();
    var existing = document.querySelector(".nh-success-overlay");
    if (existing) existing.remove();
    var overlay = document.createElement("div");
    overlay.className = "nh-success-overlay";
    overlay.innerHTML =
      '<div class="nh-success-card" role="dialog" aria-modal="true">' +
      '<div class="nh-success-icon">✓</div>' +
      '<h2 class="nh-success-title">' +
      (opts.title || "접수가 완료되었습니다") +
      "</h2>" +
      '<p class="nh-success-body">' +
      (opts.body || "담당 커플매니저가 <b>24시간 이내</b> 연락드리겠습니다.") +
      "</p>" +
      '<p class="nh-success-sub">접수번호 확인이나 긴급 문의는 <b>1800-8194</b></p>' +
      '<button class="nh-success-btn" type="button">확인</button>' +
      "</div>";
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    var closeBtn = overlay.querySelector(".nh-success-btn");
    function close() {
      overlay.remove();
      document.body.style.overflow = "";
    }
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    setTimeout(function () {
      closeBtn.focus();
    }, 100);
  };

  window.showNobleErrorToast = function (msg) {
    injectModalCSS();
    var old = document.querySelector(".nh-error-toast");
    if (old) old.remove();
    var t = document.createElement("div");
    t.className = "nh-error-toast";
    t.textContent =
      msg || "접수에 문제가 있었습니다. 1800-8194로 문의해주세요.";
    document.body.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, 6000);
  };

  var PHONE_RE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;

  function normalizePhone(s) {
    return String(s || "").replace(/\s+/g, "");
  }

  function setStatus(btn, text, disabled) {
    if (!btn) return;
    if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
    btn.textContent = text;
    btn.disabled = !!disabled;
  }

  function restoreStatus(btn) {
    if (!btn) return;
    btn.textContent = btn.dataset.origLabel || btn.textContent;
    btn.disabled = false;
  }

  function showInlineMessage(host, text, type) {
    var old = host.querySelector(".bar-inline-msg");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "bar-inline-msg bar-inline-msg--" + (type || "info");
    el.style.cssText =
      "margin-top:8px;padding:8px 12px;border-radius:6px;font-size:12px;line-height:1.5;" +
      (type === "error"
        ? "background:rgba(180,40,40,0.12);color:#ffb0b0;border:1px solid rgba(180,40,40,0.4);"
        : "background:rgba(40,140,80,0.18);color:#b8e6c5;border:1px solid rgba(40,140,80,0.5);");
    el.textContent = text;
    host.appendChild(el);
    if (type !== "error") {
      setTimeout(function () {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 6000);
    }
  }

  async function postJSON(url, data) {
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    var json = {};
    try {
      json = await res.json();
    } catch (e) {}
    return { ok: res.ok, status: res.status, json: json };
  }

  // ─── 사이드바 (간편상담 2필드) ─────────────────────────────
  function wireSideBar() {
    var sib = document.querySelector(".side-inquiry-bar");
    if (!sib) return;
    var btn = sib.querySelector(".sib-submit");
    if (!btn) return;
    var inputs = sib.querySelectorAll(".sib-input");
    if (inputs.length < 2) return;

    btn.addEventListener("click", async function (e) {
      e.preventDefault();
      var name = (inputs[0].value || "").trim();
      var phone = normalizePhone(inputs[1].value);

      if (!name) {
        showInlineMessage(sib, "이름을 입력해주세요.", "error");
        inputs[0].focus();
        return;
      }
      if (!PHONE_RE.test(phone)) {
        showInlineMessage(
          sib,
          "연락처를 정확히 입력해주세요. (예: 010-1234-5678)",
          "error",
        );
        inputs[1].focus();
        return;
      }

      // _ts는 반드시 폼 로드 시각. 아래 리셋 전에 payload를 확정해야
      // 경과 0ms가 전송되어 워커 봇가드(MIN_SUBMIT_MS)에 429로 걸리지 않는다.
      var payload = {
        name: name,
        phone: phone,
        referrer: document.referrer || "",
        _hp: "",
        _ts: window._barsLoadTs,
      };

      // 즉시 성공 모달 표시 (UX 우선) + 백그라운드 fetch
      window.showNobleSuccessModal();
      inputs[0].value = "";
      inputs[1].value = "";
      btn.textContent = "접수 완료";
      btn.disabled = true;
      window._barsLoadTs = Date.now();

      postJSON("/api/consultation/quick", payload)
        .then(function (r) {
          if (r.ok) return;
          if (r.status === 429) {
            window.showNobleErrorToast(
              "접수가 몰려 일시 지연됩니다. 1800-8194로 연락 바랍니다.",
            );
          } else {
            window.showNobleErrorToast(
              r.json && r.json.error === "Invalid fields"
                ? "입력값을 확인해주세요. 1800-8194로 문의해주세요."
                : "접수 처리 중 오류. 1800-8194로 문의해주세요.",
            );
          }
        })
        .catch(function () {
          window.showNobleErrorToast(
            "네트워크 오류로 접수가 전달되지 않았습니다. 1800-8194로 문의해주세요.",
          );
        })
        .finally(function () {
          setTimeout(function () {
            restoreStatus(btn);
          }, 4000);
        });
    });
  }

  // ─── 하단 가로바 (이름+전화+성별+혼인+연도+동의) ───────────
  function wireBottomBar() {
    var bib = document.querySelector(".bottom-inquiry-bar");
    if (!bib) return;
    var btn = bib.querySelector(".bib-submit");
    if (!btn) return;
    var nameEl = bib.querySelector(".w-name");
    var phoneEl = bib.querySelector(".w-phone");
    var genderEl = bib.querySelector(".w-gender");
    var maritalEl = bib.querySelector(".w-marital");
    var yearEl = bib.querySelector(".w-year");
    var consents = bib.querySelectorAll(".bib-check input[type=checkbox]");
    // 첫 번째 체크박스 = 개인정보(필수), 두 번째 = 마케팅(선택)
    var agreePrivacyEl = consents[0] || null;
    var agreeMarketingEl = consents[1] || null;

    btn.addEventListener("click", async function (e) {
      e.preventDefault();
      var name = ((nameEl && nameEl.value) || "").trim();
      var phone = normalizePhone(phoneEl && phoneEl.value);
      var gender = (genderEl && genderEl.value) || "";
      var marriage = (maritalEl && maritalEl.value) || "";
      var birthYear = (yearEl && yearEl.value) || "";
      var agreePrivacy = !!(agreePrivacyEl && agreePrivacyEl.checked);
      var agreeMarketing = !!(agreeMarketingEl && agreeMarketingEl.checked);

      if (!name) {
        showInlineMessage(bib, "이름을 입력해주세요.", "error");
        nameEl && nameEl.focus();
        return;
      }
      if (!PHONE_RE.test(phone)) {
        showInlineMessage(
          bib,
          "연락처를 정확히 입력해주세요. (예: 010-1234-5678)",
          "error",
        );
        phoneEl && phoneEl.focus();
        return;
      }
      if (!agreePrivacy) {
        showInlineMessage(
          bib,
          "개인정보 수집·이용 동의(필수)에 체크해주세요.",
          "error",
        );
        return;
      }

      var payload = {
        name: name,
        phone: phone,
        gender: gender,
        marriage: marriage,
        birthYear: birthYear,
        agreePrivacy: agreePrivacy,
        agreeMarketing: agreeMarketing,
        referrer: document.referrer || "",
        _hp: "",
        _ts: window._barsLoadTs,
      };

      // 즉시 성공 모달 표시 (UX 우선) + 백그라운드 fetch
      window.showNobleSuccessModal();
      if (nameEl) nameEl.value = "";
      if (phoneEl) phoneEl.value = "";
      if (genderEl) genderEl.value = "";
      if (maritalEl) maritalEl.value = "";
      if (yearEl) yearEl.value = "";
      if (agreePrivacyEl) agreePrivacyEl.checked = false;
      if (agreeMarketingEl) agreeMarketingEl.checked = false;
      btn.textContent = "접수 완료";
      btn.disabled = true;
      window._barsLoadTs = Date.now();

      postJSON("/api/consultation/bar", payload)
        .then(function (r) {
          if (r.ok) return;
          if (r.status === 429) {
            window.showNobleErrorToast(
              "접수가 몰려 일시 지연됩니다. 1800-8194로 연락 바랍니다.",
            );
          } else {
            window.showNobleErrorToast(
              r.json && r.json.error === "Invalid fields"
                ? "입력값을 확인해주세요. 1800-8194로 문의해주세요."
                : "접수 처리 중 오류. 1800-8194로 문의해주세요.",
            );
          }
        })
        .catch(function () {
          window.showNobleErrorToast(
            "네트워크 오류로 접수가 전달되지 않았습니다. 1800-8194로 문의해주세요.",
          );
        })
        .finally(function () {
          setTimeout(function () {
            restoreStatus(btn);
          }, 4000);
        });
    });
  }

  function init() {
    wireSideBar();
    wireBottomBar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
