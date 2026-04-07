// src/cosmetic.ts
// Sentinel Cosmetic Filter — ISOLATED world content script
// Injects CSS to hide ad containers, popups, overlays, cookie banners,
// and scam elements. Also applies scriptlet-style neutralizations.
// Runs at document_start so ads are hidden before they paint.

// ============================================================
// 1. CSS COSMETIC FILTERS
// Comprehensive selectors from EasyList cosmetic filters, anti-adblock
// lists, and common ad network patterns.
// ============================================================

const COSMETIC_CSS = `
/* === Generic ad containers === */
[id^="google_ads"],
[id^="div-gpt-ad"],
[id*="google_ads"],
[class*="google-ad"],
[id^="ad-"],
[id^="ad_"],
[class^="ad-"],
[class^="ad_"],
[id*="-ad-"],
[class*="-ad-"],
[id*="_ad_"],
[class*="_ad_"],
[class*="adsbygoogle"],
ins.adsbygoogle,
[data-ad],
[data-ad-slot],
[data-ad-client],
[data-google-query-id],
[id*="AdSlot"],
[class*="AdSlot"],
[id*="adslot"],
[class*="adslot"],
[class*="ad-slot"],
[class*="ad-unit"],
[class*="ad-wrap"],
[class*="ad-container"],
[class*="ad-banner"],
[class*="ad-block"],
[class*="ad-placement"],
[class*="ad-leaderboard"],
[class*="ad-sidebar"],
[class*="advert-"],
[class*="advert_"],
[class*="advertisement"],
[class*="advertising"],
[id*="advertisement"],
[id*="advertising"],
div[class*="sponsor"],
div[id*="sponsor"],
[class*="sponsored-"],
[class*="sponsored_"],

/* === Popup / overlay / interstitial ads === */
[class*="popup-ad"],
[class*="popupAd"],
[class*="pop-up-ad"],
[class*="overlay-ad"],
[class*="interstitial"],
[class*="modal-ad"],
[id*="popup-ad"],
[id*="popupAd"],
[id*="interstitial"],
div[class*="lightbox-ad"],

/* === Floating / sticky ads === */
[class*="sticky-ad"],
[class*="stickyAd"],
[class*="sticky_ad"],
[class*="floating-ad"],
[class*="floatingAd"],
[class*="fixed-ad"],
[id*="sticky-ad"],
[id*="stickyAd"],
[id*="floating-ad"],

/* === Ad networks & tracking iframes === */
iframe[src*="doubleclick.net"],
iframe[src*="googlesyndication.com"],
iframe[src*="googleadservices.com"],
iframe[src*="amazon-adsystem.com"],
iframe[src*="adnxs.com"],
iframe[src*="adsafeprotected.com"],
iframe[src*="rubiconproject.com"],
iframe[src*="pubmatic.com"],
iframe[src*="openx.net"],
iframe[src*="criteo."],
iframe[src*="taboola.com"],
iframe[src*="outbrain.com"],
iframe[src*="mgid.com"],
iframe[src*="propellerads.com"],
iframe[src*="popads.net"],
iframe[src*="popcash.net"],
iframe[src*="juicyads.com"],
iframe[src*="exoclick.com"],
iframe[src*="trafficjunky.com"],
iframe[src*="revenuehits.com"],
iframe[src*="hilltopads.net"],
iframe[src*="clickadu.com"],

/* === Cookie consent / GDPR banners === */
[id*="cookie-banner"],
[id*="cookieBanner"],
[id*="cookie-consent"],
[id*="cookieConsent"],
[id*="cookie-notice"],
[id*="cookieNotice"],
[class*="cookie-banner"],
[class*="cookieBanner"],
[class*="cookie-consent"],
[class*="cookieConsent"],
[class*="cookie-notice"],
[class*="cookieNotice"],
[class*="cookie-popup"],
[class*="cookie-wall"],
[class*="gdpr-banner"],
[class*="gdpr-consent"],
[id*="gdpr"],
[class*="consent-banner"],
[class*="consent-modal"],
[id*="consent-banner"],
[id*="consent-modal"],
#CybotCookiebotDialog,
#onetrust-consent-sdk,
.cc-window,
.cc-banner,

/* === Newsletter / signup popups === */
[class*="newsletter-popup"],
[class*="newsletter-modal"],
[class*="signup-popup"],
[class*="signup-modal"],
[class*="subscribe-popup"],
[class*="subscribe-modal"],
[class*="email-popup"],
[class*="email-modal"],

/* === Social share floating bars === */
[class*="social-share-bar"],
[class*="share-floating"],
[class*="social-sticky"],

/* === Anti-adblock walls === */
[class*="anti-adblock"],
[class*="adblock-detect"],
[class*="adblock-notice"],
[class*="adblock-overlay"],
[class*="adb-overlay"],
[id*="anti-adblock"],
[id*="adblock-detect"],
[id*="adblock-notice"],

/* === Scam / push notification prompts === */
[class*="push-notification"],
[class*="push-prompt"],
[class*="notification-prompt"],
[class*="web-push"],
[id*="push-notification"],
[id*="push-prompt"],

/* === Common ad network specific === */
.taboola-above,
.taboola-below,
[id^="taboola-"],
[class*="taboola"],
[id^="outbrain_"],
[class*="outbrain"],
[class*="OUTBRAIN"],
.ob-widget,
.ob-smartfeed-wrapper,
[class*="mgid"],
[id*="mgid"],
#mgid-container,
[class*="revcontent"],
[id*="revcontent"],
[class*="zergnet"],
[id*="zergnet"],
[class*="content-ad"],
[id*="content-ad"],
.adthrive-ad,
[class*="adthrive"],
[class*="mediavine"],
.mv-ad-box,

/* === Manga / streaming site specific === */
[class*="c-ads"],
[id*="c-ads"],
[class*="chapter-ad"],
[id*="ad-chapter"],
.reading-ad,
[class*="read-ad"],
[class*="player-ad"],
[class*="video-ad"],
[class*="preroll"],

/* === Force hide with specificity boost === */
[id^="google_ads"] { display: none !important; visibility: hidden !important; height: 0 !important; overflow: hidden !important; }
ins.adsbygoogle { display: none !important; height: 0 !important; }
`;

// Inject the cosmetic CSS as early as possible
function injectCosmeticCSS() {
  const style = document.createElement("style");
  style.id = "_sentinel_cosmetic";
  style.textContent =
    "/* Sentinel Cosmetic Filters */\n" +
    COSMETIC_CSS.split("\n")
      .filter((line) => {
        const t = line.trim();
        // Lines that already have {} are full rules — keep as-is
        if (t.includes("{")) return true;
        // Skip empty lines and comments
        if (!t || t.startsWith("/*") || t.startsWith("*")) return false;
        return true;
      })
      .map((line) => {
        const t = line.trim();
        // If it's already a full CSS rule, keep it
        if (t.includes("{")) return t;
        // Otherwise it's a selector — add the hide rule
        // Remove trailing comma if present
        const selector = t.replace(/,$/, "");
        if (!selector) return "";
        return selector + " { display: none !important; }";
      })
      .filter(Boolean)
      .join("\n");

  // Insert into <head> if available, otherwise <html>
  const target = document.head || document.documentElement;
  if (target) {
    target.insertBefore(style, target.firstChild);
  }
}

// ============================================================
// 2. SCRIPTLET NEUTRALIZATIONS
// Disable common anti-adblock and popup scripts by stubbing
// their APIs in the page context.
// ============================================================

function injectScriptletNeutralizations() {
  // We're in ISOLATED world — inject a <script> to run in MAIN world
  const code = `
(function() {
  // Neuter common popup/redirect tricks
  // Some ad scripts override these after page load
  const _origSetTimeout = window.setTimeout;
  const _origSetInterval = window.setInterval;

  // Block scripts that try to set window.location or open popups on timer
  // by monitoring for suspicious timer-based redirects
  let _redirectAttempts = 0;
  const _origLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

  // Neuter document.write (used by ad scripts to inject content)
  const _origWrite = document.write;
  const _origWriteLn = document.writeln;
  try {
    document.write = function(markup) {
      if (typeof markup === 'string' &&
          (markup.includes('ad') || markup.includes('click') ||
           markup.includes('pop') || markup.includes('track'))) {
        return; // Silently block suspicious writes
      }
      return _origWrite.call(document, markup);
    };
    document.writeln = function(markup) {
      if (typeof markup === 'string' &&
          (markup.includes('ad') || markup.includes('click') ||
           markup.includes('pop') || markup.includes('track'))) {
        return;
      }
      return _origWriteLn.call(document, markup);
    };
  } catch(e) {}

  // Block Notification permission requests (push notification spam)
  try {
    if (window.Notification && Notification.requestPermission) {
      Notification.requestPermission = function() {
        return Promise.resolve('denied');
      };
    }
  } catch(e) {}

  // Neuter common anti-adblock detection variables
  try {
    Object.defineProperty(window, 'adsbygoogle', {
      get: function() { return { loaded: true, push: function(){} }; },
      set: function() {},
      configurable: true
    });
  } catch(e) {}

  // Fake ad element to fool detection scripts that check if ads rendered
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        var bait = document.createElement('div');
        bait.className = 'pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links ad-text';
        bait.setAttribute('data-ad-slot', 'sentinel-bait');
        bait.style.cssText = 'position:absolute!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:1px!important;';
        document.body.appendChild(bait);
      });
    }
  } catch(e) {}
})();
`;

  try {
    const script = document.createElement("script");
    script.textContent = code;
    (document.head || document.documentElement).appendChild(script);
    script.remove(); // Clean up — the code has already executed
  } catch {
    // Trusted Types or CSP may block this — that's fine,
    // the CSS cosmetic filters still work independently
  }
}

// ============================================================
// 3. AGGRESSIVE ELEMENT REMOVAL
// Periodically scan for ad elements that slip past CSS hiding
// (e.g., dynamically injected after page load)
// ============================================================

function removeAdElements() {
  if (!document.body) return;

  const adSelectors = [
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="popads"]',
    'iframe[src*="popcash"]',
    'iframe[src*="propellerads"]',
    'iframe[src*="juicyads"]',
    'iframe[src*="exoclick"]',
    'iframe[src*="trafficjunky"]',
    // Full-page overlay iframes with no src (injected by ad scripts)
    'iframe:not([src])',
  ];

  for (const sel of adSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLIFrameElement;
        // Don't remove iframes that are part of the page content
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        // Remove if: no src + positioned as overlay, or from known ad domain
        if (!el.src && style.position === "fixed") {
          el.remove();
        } else if (!el.src && style.position === "absolute" && rect.width > 300 && rect.height > 200) {
          el.remove();
        } else if (el.src && (
          el.src.includes("doubleclick") ||
          el.src.includes("popads") ||
          el.src.includes("popcash") ||
          el.src.includes("propellerads") ||
          el.src.includes("juicyads") ||
          el.src.includes("exoclick")
        )) {
          el.remove();
        }
      }
    } catch {
      // ignore
    }
  }

  // Remove elements with suspicious onclick handlers
  try {
    const allLinks = document.querySelectorAll("a[onclick], div[onclick], span[onclick]");
    for (let i = 0; i < allLinks.length; i++) {
      const el = allLinks[i] as HTMLElement;
      const onclick = el.getAttribute("onclick") || "";
      if (
        onclick.includes("window.open") ||
        onclick.includes("pop") ||
        onclick.includes("redirect")
      ) {
        el.removeAttribute("onclick");
      }
    }
  } catch {
    // ignore
  }
}

// ============================================================
// 4. INITIALIZATION
// ============================================================

// Inject CSS immediately (before paint)
if (document.head || document.documentElement) {
  injectCosmeticCSS();
} else {
  // Extremely early — wait for head
  const observer = new MutationObserver(() => {
    if (document.head || document.documentElement) {
      observer.disconnect();
      injectCosmeticCSS();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

// Inject scriptlet neutralizations after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    injectScriptletNeutralizations();
    removeAdElements();
    // Re-scan periodically for dynamically injected ads
    setInterval(removeAdElements, 3000);
  });
} else {
  injectScriptletNeutralizations();
  removeAdElements();
  setInterval(removeAdElements, 3000);
}
