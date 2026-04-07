// src/content.ts
/* Sentinel Content Script (MAIN world, document_start)
   - Ad Defense: Blocks cross-origin popups, strips invisible click-trap overlays
   - Canvas Obfuscation: Hooks HTMLCanvasElement to add noise and prevent fingerprinting
   - Honors user preferences in chrome.storage.local
   - Listens for storage changes and runtime messages
*/

// ============================================================
// AD DEFENSE — Runs immediately at document_start, before any page script.
// This must be the FIRST code in the file so that ad scripts cannot
// capture references to the original window.open before we override it.
// ============================================================

// 1. Popup Blocker — Override window.open to block cross-origin ad popups.
//    Ad scripts call window.open("https://sketchy-redirect.com") on click events.
//    By returning null for cross-origin calls, the popup never opens.
const _sentinelOriginalOpen = window.open;
try {
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: function sentinelOpenGuard(
      url?: string | URL,
      target?: string,
      features?: string,
    ): Window | null {
      // Allow blank popups (some frameworks use these for same-origin flows)
      if (!url || String(url) === "about:blank") {
        return _sentinelOriginalOpen.call(window, url, target, features);
      }
      try {
        const dest = new URL(String(url), window.location.href);
        if (dest.origin === window.location.origin) {
          // Same-origin popup — legitimate, allow it
          return _sentinelOriginalOpen.call(window, url, target, features);
        }
      } catch {
        // Malformed URL — block it
      }
      console.info(
        "🛡️ Sentinel: Blocked cross-origin popup →",
        String(url).substring(0, 100),
      );
      return null;
    },
  });
} catch {
  // If defineProperty fails, try direct assignment
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).open = function (url?: string | URL): Window | null {
    if (!url || String(url) === "about:blank")
      return _sentinelOriginalOpen.call(window, url);
    try {
      const dest = new URL(String(url), window.location.href);
      if (dest.origin === window.location.origin)
        return _sentinelOriginalOpen.call(window, url);
    } catch {
      /* block */
    }
    console.info(
      "🛡️ Sentinel: Blocked cross-origin popup →",
      String(url).substring(0, 100),
    );
    return null;
  };
}

// 2. Click-Trap Overlay Stripper — Detect and remove invisible full-screen
//    <a>, <iframe>, and <div> elements that exist solely to hijack user clicks
//    and redirect them to scam/adult sites.
function _sentinelIsClickTrap(el: HTMLElement): boolean {
  if (!el.isConnected) return false;

  const tag = el.tagName;
  if (tag !== "A" && tag !== "DIV" && tag !== "IFRAME" && tag !== "SPAN")
    return false;

  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(el);
  } catch {
    return false;
  }

  const rect = el.getBoundingClientRect();
  const vpW = window.innerWidth || document.documentElement.clientWidth;
  const vpH = window.innerHeight || document.documentElement.clientHeight;

  // Must cover a significant portion of the viewport
  if (rect.width < vpW * 0.25 || rect.height < vpH * 0.25) return false;

  // Must be positioned over other content
  const pos = style.position;
  if (pos !== "fixed" && pos !== "absolute") return false;

  // Must be invisible / transparent
  const opacity = parseFloat(style.opacity);
  const bg = style.backgroundColor;
  const isTransparent =
    opacity < 0.12 ||
    bg === "transparent" ||
    bg === "rgba(0, 0, 0, 0)" ||
    (opacity <= 0.01 && !el.textContent?.trim());

  if (!isTransparent) return false;

  // High-confidence indicators
  const z = parseInt(style.zIndex) || 0;
  if (tag === "A") return true; // Transparent full-screen link = always a trap
  if (tag === "IFRAME") return true; // Transparent full-screen iframe = always a trap
  if (z > 50) return true; // High z-index transparent overlay = trap

  return false;
}

function _sentinelStripOverlays(root: HTMLElement) {
  if (!root || !root.querySelectorAll) return;
  let removed = 0;

  // Check the root element itself
  if (root instanceof HTMLElement && _sentinelIsClickTrap(root)) {
    root.remove();
    removed++;
  } else {
    // Scan children
    const candidates = root.querySelectorAll("a, div, iframe, span");
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el instanceof HTMLElement && _sentinelIsClickTrap(el)) {
        el.remove();
        removed++;
      }
    }
  }

  if (removed > 0) {
    console.info(`🛡️ Sentinel: Stripped ${removed} click-trap overlay(s)`);
  }
}

// 3. MutationObserver — Watch for dynamically injected overlays and strip them
//    in real-time as ad scripts add them to the DOM.
let _sentinelObserverActive = false;
const _sentinelOverlayObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (let i = 0; i < mutation.addedNodes.length; i++) {
      const node = mutation.addedNodes[i];
      if (node instanceof HTMLElement) {
        // Small delay so the browser has computed styles available
        requestAnimationFrame(() => _sentinelStripOverlays(node));
      }
    }
  }
});

function _sentinelStartAdDefense() {
  if (_sentinelObserverActive || !document.body) return;
  _sentinelObserverActive = true;

  // Observe all DOM mutations
  _sentinelOverlayObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Initial full-page scan
  _sentinelStripOverlays(document.body);

  // Periodic re-scan: some ad scripts use setTimeout/setInterval tricks
  // to re-inject overlays after removal. Re-scan every 2 seconds.
  setInterval(() => {
    if (document.body) _sentinelStripOverlays(document.body);
  }, 2000);

  console.info(
    "🛡️ Sentinel: Ad defense active (popup blocker + overlay stripper)",
  );
}

// Start the overlay stripper as soon as the body exists
if (document.body) {
  _sentinelStartAdDefense();
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _sentinelStartAdDefense);
} else {
  // Fallback: poll for body
  const _sentinelPoll = setInterval(() => {
    if (document.body) {
      clearInterval(_sentinelPoll);
      _sentinelStartAdDefense();
    }
  }, 10);
}

// ============================================================
// CANVAS OBFUSCATION — Fingerprint protection (toggleable)
// Iframe-resistant: hooks are applied to any window context,
// including iframe contentWindows and OffscreenCanvas.
//
// Strategy:
// - Per-page-load random seed ensures the fingerprint changes on
//   every reload but stays consistent within a single page session
//   (so fingerprinting scripts that compare multiple reads don't
//   detect the hook).
// - Distributed sub-pixel noise across the entire image rather than
//   a single visible pixel — harder to filter out.
// - Hooks toDataURL, toBlob, getImageData, measureText, and WebGL
//   parameter queries to cover all known canvas fingerprinting vectors.
// ============================================================

// Per-page-load seed: changes on every navigation/reload so the
// fingerprint is different each time, but stays stable within the
// session so multiple reads return the same value.
const _sNoiseSeed = Math.random();

// Simple seeded PRNG (mulberry32) — deterministic given a seed so
// the same canvas content + session seed = same noised output.
function _sMulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive a numeric hash from a string (canvas content key) to seed
// deterministic noise for that specific canvas.
function _sHashStr(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// Save originals from the main window so we can restore them on uninstall
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;
const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
const originalContentWindowDesc = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  "contentWindow",
);

let hooksInstalled = false;

/**
 * Inject subtle, distributed noise into raw pixel data.
 * Uses a deterministic PRNG seeded from the page-load seed + a content
 * hash so that:
 *  - The same canvas read twice in one session → identical output
 *  - Reloading the page → different seed → different fingerprint
 *  - Noise is spread across many pixels (not a single visible dot)
 */
function _sNoiseImageData(
  imageData: ImageData,
  contentKey: number,
): ImageData {
  const data = imageData.data;
  if (!data || data.length < 4) return imageData;

  const rng = _sMulberry32((_sNoiseSeed * 0xffffffff + contentKey) | 0);
  const pixelCount = data.length / 4;
  // Noise ~5% of pixels — enough to change the hash, subtle enough to be invisible
  const noiseCount = Math.max(4, Math.floor(pixelCount * 0.05));

  for (let i = 0; i < noiseCount; i++) {
    const px = Math.floor(rng() * pixelCount) * 4;
    // Only modify RGB channels (not alpha) by ±1-2 to stay invisible
    const channel = px + Math.floor(rng() * 3); // R, G, or B
    const delta = rng() > 0.5 ? 1 : -1;
    data[channel] = Math.max(0, Math.min(255, data[channel] + delta));
  }
  return imageData;
}

/**
 * Apply canvas fingerprint-noise hooks to any window-like context.
 * Uses Proxy objects so that fn.toString() returns "function xyz() { [native code] }"
 * — defeating .toString() fingerprinting detection.
 *
 * For toDataURL/toBlob: clones the canvas to an offscreen copy before noising,
 * so the original canvas is never visibly corrupted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyCanvasHooks(win: any) {
  try {
    // --- Save originals for this window context BEFORE any hooks ---
    const _origGetCtx = win.HTMLCanvasElement
      ? win.HTMLCanvasElement.prototype.getContext
      : null;
    const _origToDataURL = win.HTMLCanvasElement
      ? win.HTMLCanvasElement.prototype.toDataURL
      : null;
    const _origToBlob = win.HTMLCanvasElement
      ? win.HTMLCanvasElement.prototype.toBlob
      : null;
    const _origGID = win.CanvasRenderingContext2D
      ? win.CanvasRenderingContext2D.prototype.getImageData
      : null;
    const _origMeasure = win.CanvasRenderingContext2D
      ? win.CanvasRenderingContext2D.prototype.measureText
      : null;

    // --- getContext: Proxy that injects willReadFrequently for 2D ---
    if (win.HTMLCanvasElement && _origGetCtx) {
      win.HTMLCanvasElement.prototype.getContext = new Proxy(_origGetCtx, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apply(target: any, thisArg: any, args: any[]) {
          if (args[0] === "2d") {
            args[1] = args[1] || {};
            args[1].willReadFrequently = true;
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    }

    // --- toDataURL: Proxy that clones canvas, noises the clone, reads from clone ---
    if (win.HTMLCanvasElement && _origToDataURL && _origGID) {
      win.HTMLCanvasElement.prototype.toDataURL = new Proxy(_origToDataURL, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apply(target: any, thisArg: any, args: any[]) {
          try {
            const clone = win.document.createElement("canvas");
            clone.width = thisArg.width;
            clone.height = thisArg.height;
            const ctx = _origGetCtx.call(clone, "2d", {
              willReadFrequently: true,
            });
            if (ctx) {
              ctx.drawImage(thisArg, 0, 0);
              // Use un-hooked getImageData to avoid double-noising
              const imgData = _origGID.call(
                ctx,
                0,
                0,
                clone.width,
                clone.height,
              );
              const contentKey = _sHashStr(
                Reflect.apply(target, thisArg, ["image/png"]),
              );
              _sNoiseImageData(imgData, contentKey);
              ctx.putImageData(imgData, 0, 0);
              // Return data URL from the noised clone, not the original
              return Reflect.apply(target, clone, args);
            }
          } catch {
            /* ignore — some contexts (webgl) don't support 2d */
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    }

    // --- toBlob: Proxy with same clone strategy ---
    if (win.HTMLCanvasElement && _origToBlob && _origGID) {
      win.HTMLCanvasElement.prototype.toBlob = new Proxy(_origToBlob, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apply(target: any, thisArg: any, args: any[]) {
          try {
            const clone = win.document.createElement("canvas");
            clone.width = thisArg.width;
            clone.height = thisArg.height;
            const ctx = _origGetCtx.call(clone, "2d", {
              willReadFrequently: true,
            });
            if (ctx) {
              ctx.drawImage(thisArg, 0, 0);
              const imgData = _origGID.call(
                ctx,
                0,
                0,
                clone.width,
                clone.height,
              );
              const contentKey = _sHashStr(
                Reflect.apply(_origToDataURL, thisArg, ["image/png"]),
              );
              _sNoiseImageData(imgData, contentKey);
              ctx.putImageData(imgData, 0, 0);
              // Call toBlob on the noised clone
              return Reflect.apply(target, clone, args);
            }
          } catch {
            /* ignore */
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    }

    // --- getImageData: Proxy with distributed noise ---
    if (win.CanvasRenderingContext2D && _origGID) {
      win.CanvasRenderingContext2D.prototype.getImageData = new Proxy(
        _origGID,
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          apply(target: any, thisArg: any, args: any[]) {
            const imageData = Reflect.apply(target, thisArg, args) as ImageData;
            if (imageData && imageData.data && imageData.data.length > 0) {
              const contentKey =
                (args[0] || 0) * 7 +
                (args[1] || 0) * 13 +
                (args[2] || 0) * 17 +
                (args[3] || 0) * 23 +
                _sNoiseSeed * 0xffff;
              _sNoiseImageData(imageData, contentKey);
            }
            return imageData;
          },
        },
      );
    }

    // --- measureText: Proxy with subtle jitter on text metrics ---
    if (win.CanvasRenderingContext2D && _origMeasure) {
      win.CanvasRenderingContext2D.prototype.measureText = new Proxy(
        _origMeasure,
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          apply(target: any, thisArg: any, args: any[]) {
            const metrics = Reflect.apply(target, thisArg, args) as TextMetrics;
            const text = args[0] || "";
            const rng = _sMulberry32(
              (_sNoiseSeed * 0xffffffff + _sHashStr(String(text))) | 0,
            );
            const jitter = (rng() - 0.5) * 0.2;

            // TextMetrics is read-only — wrap with a Proxy to jitter values
            return new Proxy(metrics as object, {
              get(t, prop) {
                const val = Reflect.get(t, prop);
                if (typeof val === "number") return val + jitter;
                if (typeof val === "function") return val.bind(t);
                return val;
              },
            });
          },
        },
      );
    }

    // --- WebGL fingerprint obfuscation (Proxy-based) ---
    _sApplyWebGLHooks(win);

    // --- OffscreenCanvas: Proxy hooks for convertToBlob and getImageData ---
    if (win.OffscreenCanvas) {
      const _origConvertToBlob = win.OffscreenCanvas.prototype.convertToBlob;
      if (_origConvertToBlob) {
        win.OffscreenCanvas.prototype.convertToBlob = new Proxy(
          _origConvertToBlob,
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            apply(target: any, thisArg: any, args: any[]) {
              try {
                const ctx = thisArg.getContext("2d");
                if (ctx) {
                  const w = thisArg.width || 1;
                  const h = thisArg.height || 1;
                  const imgData = ctx.getImageData(0, 0, w, h);
                  const contentKey = (_sNoiseSeed * 0xffff + w * h) | 0;
                  _sNoiseImageData(imgData, contentKey);
                  ctx.putImageData(imgData, 0, 0);
                }
              } catch {
                /* ignore */
              }
              return Reflect.apply(target, thisArg, args);
            },
          },
        );
      }

      if (win.OffscreenCanvasRenderingContext2D) {
        const _origOscGID =
          win.OffscreenCanvasRenderingContext2D.prototype.getImageData;
        if (_origOscGID) {
          win.OffscreenCanvasRenderingContext2D.prototype.getImageData =
            new Proxy(_origOscGID, {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              apply(target: any, thisArg: any, args: any[]) {
                const imageData = Reflect.apply(target, thisArg, args) as ImageData;
                if (imageData && imageData.data && imageData.data.length > 0) {
                  const contentKey =
                    (args[0] || 0) * 7 +
                    (args[1] || 0) * 13 +
                    (args[2] || 0) * 17 +
                    (args[3] || 0) * 23 +
                    _sNoiseSeed * 0xffff;
                  _sNoiseImageData(imageData, contentKey);
                }
                return imageData;
              },
            });
        }
      }
    }
  } catch {
    // Silently fail — cross-origin iframes will throw; that's expected.
  }
}

/**
 * WebGL fingerprint obfuscation: Proxy-based hooks that spoof renderer/vendor
 * strings and inject noise into getParameter results.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _sApplyWebGLHooks(win: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hookProto = (Proto: any) => {
    if (!Proto || !Proto.getParameter) return;

    const _origGetParam = Proto.getParameter;
    Proto.getParameter = new Proxy(_origGetParam, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apply(target: any, thisArg: any, args: any[]) {
        const result = Reflect.apply(target, thisArg, args);
        const pname = args[0];

        // UNMASKED_VENDOR_WEBGL (0x9245) / UNMASKED_RENDERER_WEBGL (0x9246)
        if (pname === 0x9245 && typeof result === "string") {
          return "Google Inc.";
        }
        if (pname === 0x9246 && typeof result === "string") {
          return "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
        }

        // Large numeric params — deterministic ±1 jitter
        if (typeof result === "number" && result > 64) {
          const rng = _sMulberry32((_sNoiseSeed * 0xffffffff + pname) | 0);
          if (rng() < 0.3) return result - 1;
        }

        return result;
      },
    });

    const _origGetExt = Proto.getExtension;
    if (_origGetExt) {
      Proto.getExtension = new Proxy(_origGetExt, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apply(target: any, thisArg: any, args: any[]) {
          return Reflect.apply(target, thisArg, args);
        },
      });
    }
  };

  try {
    if (win.WebGLRenderingContext) {
      hookProto(win.WebGLRenderingContext.prototype);
    }
    if (win.WebGL2RenderingContext) {
      hookProto(win.WebGL2RenderingContext.prototype);
    }
  } catch {
    // ignore
  }
}

/**
 * Defeat the "iframe sandbox bypass": trackers create a hidden <iframe>,
 * then pull a clean HTMLCanvasElement from iframe.contentWindow.
 * We intercept the contentWindow getter to apply our hooks before
 * the tracker can use the iframe's pristine prototypes.
 */
function installIframeDefense() {
  if (!originalContentWindowDesc || !originalContentWindowDesc.get) return;

  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    get() {
      const win = originalContentWindowDesc.get!.call(this);
      try {
        // The property read itself can throw on cross-origin iframes,
        // so the ENTIRE access must be inside try/catch.
        if (win && !win._sentinelHooked) {
          applyCanvasHooks(win);
          win._sentinelHooked = true;
        }
      } catch {
        // Cross-origin iframes throw SecurityError on any property
        // access — ignore. They can't exfiltrate canvas data anyway.
      }
      return win;
    },
    configurable: true,
  });
}

function uninstallIframeDefense() {
  if (!originalContentWindowDesc) return;
  try {
    Object.defineProperty(
      HTMLIFrameElement.prototype,
      "contentWindow",
      originalContentWindowDesc,
    );
  } catch {
    // ignore
  }
}

// Core hook lifecycle (installs hooks on main window + iframe defense)
function installHooks() {
  if (hooksInstalled) return;

  applyCanvasHooks(window);
  installIframeDefense();

  hooksInstalled = true;
  console.log(
    "🛡️ Sentinel: Canvas obfuscation installed (main + iframe + OffscreenCanvas)",
  );
}

function uninstallHooks() {
  if (!hooksInstalled) return;

  try {
    // Restore main window originals
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
    CanvasRenderingContext2D.prototype.getImageData = originalGetImageData;
    CanvasRenderingContext2D.prototype.measureText = originalMeasureText;
    uninstallIframeDefense();
    hooksInstalled = false;
    console.log("🛡️ Sentinel: Canvas obfuscation hooks removed.");
  } catch (e) {
    console.warn("Sentinel: Failed to fully restore canvas hooks", e);
  }
}

function applySetting(enabled: boolean) {
  if (enabled) {
    installHooks();
  } else {
    uninstallHooks();
  }
}

// CRITICAL: Install hooks SYNCHRONOUSLY at document_start, before any page
// script can capture clean references to canvas APIs. The default is enabled.
// We then check storage asynchronously and only UNINSTALL if the user has
// explicitly disabled the feature. This eliminates the race condition where
// fingerprinting scripts run before the async storage callback.
installHooks();

try {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    // Check if user has explicitly disabled — if so, uninstall
    chrome.storage.local.get(
      ["canvasObfuscation"],
      (items: { [key: string]: unknown }) => {
        if (
          items &&
          typeof items.canvasObfuscation !== "undefined" &&
          !items.canvasObfuscation
        ) {
          uninstallHooks();
        }
        // If undefined, persist the default so future loads are consistent
        if (typeof items.canvasObfuscation === "undefined") {
          try {
            chrome.storage.local.set({ canvasObfuscation: true });
          } catch {
            /* ignore storage set errors in rare contexts */
          }
        }
      },
    );

    // Listen for storage changes (other parts of the extension may toggle this)
    chrome.storage.onChanged.addListener(
      (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string,
      ) => {
        if (areaName !== "local") return;
        if (changes.canvasObfuscation) {
          const newVal = changes.canvasObfuscation.newValue;
          applySetting(Boolean(newVal));
        }
      },
    );
  }
} catch {
  // Hooks are already installed — nothing to do on error
}

// ============================================================
// GEOLOCATION SPOOFING — Feeds fake coordinates to sites (toggleable)
// Uses Proxy objects so navigator.geolocation.getCurrentPosition.toString()
// returns "[native code]", making the hook undetectable.
// A per-session random offset is applied to a base location so the
// spoofed position looks realistic but is never the user's real one.
// ============================================================

const _origGetCurrentPosition =
  navigator.geolocation.getCurrentPosition;
const _origWatchPosition = navigator.geolocation.watchPosition;

let _geoHooksInstalled = false;

// Per-session spoofed location: base coords with random offset (±0.05°, ~5km)
const _sGeoLat = 40.7128 + (Math.random() - 0.5) * 0.1;
const _sGeoLng = -74.006 + (Math.random() - 0.5) * 0.1;

function _sBuildFakePosition(): GeolocationPosition {
  const timestamp = Date.now();
  const coords = {
    latitude: _sGeoLat,
    longitude: _sGeoLng,
    accuracy: 50 + Math.random() * 50,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    toJSON() {
      return {
        latitude: this.latitude,
        longitude: this.longitude,
        accuracy: this.accuracy,
        altitude: this.altitude,
        altitudeAccuracy: this.altitudeAccuracy,
        heading: this.heading,
        speed: this.speed,
      };
    },
  };
  return {
    coords,
    timestamp,
    toJSON() {
      return { coords: coords.toJSON(), timestamp };
    },
  } as GeolocationPosition;
}

function installGeoHooks() {
  if (_geoHooksInstalled) return;

  navigator.geolocation.getCurrentPosition = new Proxy(
    _origGetCurrentPosition,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apply(_target: any, _thisArg: any, args: any[]) {
        const successCb = args[0];
        if (typeof successCb === "function") {
          setTimeout(() => successCb(_sBuildFakePosition()), 50);
        }
      },
    },
  );

  navigator.geolocation.watchPosition = new Proxy(_origWatchPosition, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply(_target: any, _thisArg: any, args: any[]) {
      const successCb = args[0];
      const id = setInterval(() => {
        if (typeof successCb === "function") {
          successCb(_sBuildFakePosition());
        }
      }, 3000);
      // Return the interval ID as the watch ID so clearWatch works
      return id;
    },
  });

  _geoHooksInstalled = true;
  console.log("🛡️ Sentinel: Location spoofing installed");
}

function uninstallGeoHooks() {
  if (!_geoHooksInstalled) return;
  try {
    navigator.geolocation.getCurrentPosition = _origGetCurrentPosition;
    navigator.geolocation.watchPosition = _origWatchPosition;
    _geoHooksInstalled = false;
    console.log("🛡️ Sentinel: Location spoofing removed");
  } catch (e) {
    console.warn("Sentinel: Failed to restore geolocation hooks", e);
  }
}

function applyGeoSetting(enabled: boolean) {
  if (enabled) {
    installGeoHooks();
  } else {
    uninstallGeoHooks();
  }
}

// Install synchronously (default: enabled), then check storage
installGeoHooks();

try {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(
      ["locationSpoofing"],
      (items: { [key: string]: unknown }) => {
        if (
          items &&
          typeof items.locationSpoofing !== "undefined" &&
          !items.locationSpoofing
        ) {
          uninstallGeoHooks();
        }
        if (typeof items.locationSpoofing === "undefined") {
          try {
            chrome.storage.local.set({ locationSpoofing: true });
          } catch {
            /* ignore */
          }
        }
      },
    );

    chrome.storage.onChanged.addListener(
      (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string,
      ) => {
        if (areaName !== "local") return;
        if (changes.locationSpoofing) {
          applyGeoSetting(Boolean(changes.locationSpoofing.newValue));
        }
      },
    );
  }
} catch {
  // Hooks already installed — nothing to do
}

// ============================================================
// AUTO-SCAN — AI-driven page threat analysis on every page load.
// Runs after DOMContentLoaded, scrapes the page, calls Gemini Nano,
// caches the result under `ai_cache_<hostname>`, and injects a
// floating toast showing the verdict.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _sResolveLanguageModel(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = navigator as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (typeof chrome !== "undefined" ? chrome : {}) as any;

  if (
    w.ai &&
    w.ai.languageModel &&
    typeof w.ai.languageModel.capabilities === "function"
  )
    return w.ai.languageModel;
  if (
    n.ai &&
    n.ai.languageModel &&
    typeof n.ai.languageModel.capabilities === "function"
  )
    return n.ai.languageModel;
  if (
    c.aiOriginTrial &&
    c.aiOriginTrial.languageModel &&
    typeof c.aiOriginTrial.languageModel.capabilities === "function"
  )
    return c.aiOriginTrial.languageModel;
  if (w.LanguageModel && typeof w.LanguageModel.create === "function") {
    return {
      capabilities: async () => {
        if (typeof w.LanguageModel.availability === "function") {
          const status = await w.LanguageModel.availability();
          return { available: status === "unavailable" ? "no" : status };
        }
        return { available: "readily" };
      },
      create: () => w.LanguageModel.create(),
    };
  }
  if (w.ai && typeof w.ai.canCreateTextSession === "function") {
    return {
      capabilities: async () => ({
        available: await w.ai.canCreateTextSession(),
      }),
      create: async () => {
        const session = await w.ai.createTextSession();
        return {
          prompt: async (t: string) => await session.prompt(t),
          destroy: () => {
            if (typeof session.destroy === "function") session.destroy();
          },
        };
      },
    };
  }
  return null;
}

function _sBuildScanPrompt(blockedDomains: string): string {
  const pageTitle = document.title || "Unknown";
  const pageUrl = window.location.href || "Unknown";
  const rawText = (document.body?.innerText || "").replace(/\s+/g, " ");
  // Keep page content short so Gemini Nano has enough tokens for a full response
  const topText = rawText.substring(0, 400);
  const bottomText = rawText.substring(Math.max(0, rawText.length - 400));
  const buttons = Array.from(
    document.querySelectorAll(
      'button, a, [role="button"], [class*="btn"], [class*="popup"], [class*="overlay"], [class*="modal"]',
    ),
  )
    .map((b) => (b as HTMLElement).innerText || "")
    .join(" | ")
    .replace(/\s+/g, " ")
    .substring(0, 250);
  const iframeCount = document.querySelectorAll("iframe").length;
  const isHttp = window.location.protocol === "http:";

  return `Security auditor. Be very concise.

PAGE: ${isHttp ? "HTTP" : "HTTPS"} | "${pageTitle}" | ${pageUrl}
Iframes: ${iframeCount} | Blocked: ${blockedDomains || "None"}
Text: ${topText}
Bottom: ${bottomText}
Buttons: ${buttons}

RESPOND IN EXACTLY THIS FORMAT:
[SCORE: X] [RED] or [YELLOW] or [GREEN]
One sentence summary. Maximum 20 words.

Example correct response:
[SCORE: 92] [GREEN]
This is a legitimate, well-known website with no threats detected.

SCORING: 90-100 safe, 70-89 normal, 40-69 suspicious, 0-39 dangerous.
RED: scareware phrases ("virus detected","PC at risk","click allow","threats found"), HTTP+financial, phishing, 5+ iframes.
YELLOW: HTTP non-financial, 3+ trackers, mildly misleading.
GREEN: clean, no threats.`;
}

function _sNormalizeHostname(raw: string): string {
  return raw.toLowerCase().replace(/^www\./, "");
}

function _sGetHostnameKey(): string {
  try {
    return "ai_cache_" + _sNormalizeHostname(window.location.hostname);
  } catch {
    return "ai_cache_unknown";
  }
}

// --- Toast UI ---
let _sToastEl: HTMLDivElement | null = null;

/**
 * Build the toast container (once) and update its content.
 * Uses DOM construction only — no innerHTML — to comply with
 * strict Trusted Types CSP policies.
 */
function _sShowToast(title: string, subtitle: string, color: string) {
  if (!document.body) return;

  if (!_sToastEl) {
    _sToastEl = document.createElement("div");
    _sToastEl.id = "_sentinel_toast";
    _sToastEl.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:999999;" +
      "width:320px;height:auto;max-height:80vh;overflow-y:auto;" +
      "font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;" +
      "line-height:1.45;border-radius:10px;padding:14px 40px 18px 16px;color:#e2e8f0;" +
      "box-shadow:0 4px 24px rgba(0,0,0,0.5);" +
      "transition:opacity 0.3s ease;" +
      "opacity:0;";

    // Close button
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText =
      "position:absolute;top:8px;right:10px;cursor:pointer;color:#94a3b8;" +
      "font-size:15px;line-height:1;z-index:1;";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      if (_sToastEl) {
        _sToastEl.style.opacity = "0";
        setTimeout(() => _sToastEl?.remove(), 300);
        _sToastEl = null;
      }
    };
    _sToastEl.appendChild(closeBtn);

    // Title line (bold)
    const titleEl = document.createElement("div");
    titleEl.id = "_sentinel_toast_title";
    titleEl.style.cssText = "font-weight:bold;margin-bottom:4px;";
    _sToastEl.appendChild(titleEl);

    // Subtitle / summary line
    const subEl = document.createElement("div");
    subEl.id = "_sentinel_toast_sub";
    subEl.style.cssText = "opacity:0.9;";
    _sToastEl.appendChild(subEl);

    document.body.appendChild(_sToastEl);
    requestAnimationFrame(() => {
      if (_sToastEl) _sToastEl.style.opacity = "1";
    });
  }

  _sToastEl.style.background = color;
  _sToastEl.style.border = "1px solid " + color;

  const titleEl = _sToastEl.querySelector("#_sentinel_toast_title");
  const subEl = _sToastEl.querySelector("#_sentinel_toast_sub");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = subtitle;
}

async function autoScanPage() {
  // Skip internal pages
  const proto = window.location.protocol;
  if (proto === "chrome:" || proto === "chrome-extension:" || proto === "about:" || proto === "edge:")
    return;

  // Show scanning toast
  _sShowToast("\u{1F6E1}\uFE0F Sentinel", "Scanning page\u2026", "#1e293b");

  const languageModel = _sResolveLanguageModel();
  if (!languageModel) {
    _sShowToast(
      "\u{1F6E1}\uFE0F Sentinel",
      "AI not available on this page",
      "#1e293b",
    );
    setTimeout(() => {
      if (_sToastEl) {
        _sToastEl.style.opacity = "0";
        setTimeout(() => { _sToastEl?.remove(); _sToastEl = null; }, 300);
      }
    }, 3000);
    return;
  }

  try {
    const caps = await languageModel.capabilities();
    if (caps.available === "no") {
      _sShowToast(
        "\u{1F6E1}\uFE0F Sentinel",
        "AI capabilities disabled",
        "#1e293b",
      );
      return;
    }

    // Gather blocked domains from storage for context
    let blockedDomains = "None";
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        const items = await new Promise<{ [key: string]: unknown }>((resolve) => {
          chrome.storage.local.get(["blockedLogs"], (r) => resolve(r));
        });
        if (Array.isArray(items.blockedLogs)) {
          blockedDomains = (items.blockedLogs as { url: string }[])
            .map((l) => { try { return new URL(l.url).hostname; } catch { return l.url; } })
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(", ") || "None";
        }
      }
    } catch { /* ignore */ }

    const prompt = _sBuildScanPrompt(blockedDomains);
    const session = await languageModel.create();
    const result: string = await session.prompt(prompt);
    if (typeof session.destroy === "function") session.destroy();

    // Parse [SCORE: X] and color tag from line 1 — ONCE.
    // The AI may output [RED], [TAG: RED], [TAG:RED], or just RED.
    const scoreMatch =
      result.match(/\[SCORE:\s*(\d+)\]/i) ||
      result.match(/SCORE:\s*(\d+)/i);
    const tagMatch =
      result.match(/\[(?:TAG:\s*)?(RED|YELLOW|GREEN)\]/i) ||
      result.match(/\b(RED|YELLOW|GREEN)\b/i);

    let score = scoreMatch
      ? Math.max(0, Math.min(100, parseInt(scoreMatch[1], 10)))
      : -1;
    const tag = tagMatch ? tagMatch[1].toUpperCase() : "YELLOW";

    // If no numeric score, derive from tag so the popup isn't stuck
    if (score < 0) {
      if (tag === "RED") score = 20;
      else if (tag === "YELLOW") score = 55;
      else score = 85;
    }

    // Strip score/tag markers for display summary
    const summary = result
      .replace(/\[SCORE:\s*\d+\]/gi, "")
      .replace(/SCORE:\s*\d+/gi, "")
      .replace(/\[(?:TAG:\s*)?(RED|YELLOW|GREEN)\]/gi, "")
      .replace(/^[,\s\-:]+/, "")
      .trim()
      .substring(0, 300);

    // Cache the PARSED result — score, tag, summary, and raw report.
    // App.tsx reads score/tag directly — no re-parsing, no mismatch.
    const cacheKey = _sGetHostnameKey();
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        // Purge stale ghost key for the www./non-www. variant
        const rawHost = window.location.hostname.toLowerCase();
        const altKey = rawHost.startsWith("www.")
          ? "ai_cache_" + rawHost.replace(/^www\./, "")
          : "ai_cache_www." + rawHost;
        if (altKey !== cacheKey) {
          chrome.storage.local.remove([altKey]);
        }
        chrome.storage.local.set({
          [cacheKey]: { report: result, score, tag, summary, timestamp: Date.now() },
        });
      }
    } catch { /* ignore */ }

    // Show result in toast
    const colors: Record<string, string> = {
      RED: "#7f1d1d",
      YELLOW: "#713f12",
      GREEN: "#14532d",
    };
    const labels: Record<string, string> = {
      RED: "\u{1F6A8} DANGER",
      YELLOW: "\u{1F7E1} CAUTION",
      GREEN: "\u{1F7E2} SAFE",
    };
    const bg = colors[tag] || colors.YELLOW;
    const label = labels[tag] || labels.YELLOW;

    const titleText =
      "\u{1F6E1}\uFE0F Sentinel \u2014 " +
      label +
      (score >= 0 ? ` (${score}/100)` : "");
    _sShowToast(titleText, summary, bg);

    // Auto-dismiss green toasts after 6s
    if (tag === "GREEN") {
      setTimeout(() => {
        if (_sToastEl) {
          _sToastEl.style.opacity = "0";
          setTimeout(() => { _sToastEl?.remove(); _sToastEl = null; }, 300);
        }
      }, 6000);
    }
  } catch (err) {
    _sShowToast(
      "\u{1F6E1}\uFE0F Sentinel",
      "Scan failed \u2014 " + String(err).substring(0, 100),
      "#1e293b",
    );
  }
}

// Run auto-scan after page content loads (only if autoAiScan is enabled)
function _sScheduleAutoScan() {
  const run = () => {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["autoAiScan"], (items: { [key: string]: unknown }) => {
          // Default is enabled (true) if not explicitly set to false
          if (items && items.autoAiScan === false) return;
          autoScanPage();
        });
      } else {
        autoScanPage();
      }
    } catch {
      autoScanPage();
    }
  };
  // Small delay to let page scripts settle
  setTimeout(run, 1500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _sScheduleAutoScan);
} else {
  _sScheduleAutoScan();
}

// ============================================================
// RUNTIME MESSAGE HANDLERS
// ============================================================
try {
  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.onMessage
  ) {
    chrome.runtime.onMessage.addListener(
      (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message: any,
        _sender: chrome.runtime.MessageSender,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendResponse: (response?: any) => void,
      ) => {
        if (!message || !message.type) return;

        if (message.type === "setCanvasObfuscation") {
          applySetting(Boolean(message.enabled));
          try {
            if (chrome && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({
                canvasObfuscation: Boolean(message.enabled),
              });
            }
          } catch {
            // ignore
          }
          if (sendResponse) sendResponse({ success: true });
        }

        if (message.type === "setLocationSpoofing") {
          applyGeoSetting(Boolean(message.enabled));
          try {
            if (chrome && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({
                locationSpoofing: Boolean(message.enabled),
              });
            }
          } catch {
            // ignore
          }
          if (sendResponse) sendResponse({ success: true });
        }

        if (message.type === "rescanPage") {
          // Trigger a fresh scan — reuses the single autoScanPage path
          // so the toast and cache are always in sync.
          autoScanPage().then(() => {
            const cacheKey = _sGetHostnameKey();
            chrome.storage.local.get([cacheKey], (items) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const cached = items[cacheKey] as any;
              sendResponse({
                success: true,
                report: cached?.report || null,
              });
            });
          });
          return true; // async
        }
      },
    );
  }
} catch {
  // ignore
}
