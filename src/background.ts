/// <reference types="chrome" />
/**
 * src/background.ts
 *
 * Typed Manifest V3 service worker for Sentinel.
 * - Uses @types/chrome for typed Chrome APIs (no `any` or global declares)
 * - Manages dynamic declarativeNetRequest rules (blocklist)
 * - Listens for UI messages and storage changes
 *
 * Notes:
 * - Keep logic async and minimal to fit MV3 service worker constraints.
 */

type SentinelState = {
  trustScore: number;
  isSecureConnection: boolean;
  networkFilterEnabled: boolean;
  blockedDomains: string[];
};

type UIMessage =
  | { type: "toggleNetworkFilter"; enabled: boolean }
  | { type: "setBlockedDomains"; domains: string[] }
  | { type: "getState" }
  | { type: "clearRules" }
  | { type: "setAgeTier"; tier: string }
  | { type: "setFilterMode"; standard: boolean; aggressive: boolean };

const STORAGE_KEY_NETWORK = "networkFilterEnabled";
const STORAGE_KEY_BLOCKED = "blockedDomains";

const DEFAULT_BLOCKED_DOMAINS = [
  "ads.example.com",
  "tracker.example.com",
  "malware.test",
] as const;

// Reasonable safety limit for dynamic rules to avoid hitting browser caps during development
const MAX_DYNAMIC_RULES = 5000;

const STORAGE_KEY_AGE_TIER = "parentalAgeTier";
const STORAGE_KEY_TIERED_DNS = "tieredDnsEnabled";

const CHILD_BLOCK_LIST: string[] = [
  // Gambling
  "stake.com",
  "draftkings.com",
  "fanduel.com",
  "bet365.com",
  "pokerstars.com",
  "casino.com",
  "bovada.lv",
  "888casino.com",
  "betway.com",
  "williamhill.com",
  // Adult content
  "pornhub.com",
  "xvideos.com",
  "xhamster.com",
  "onlyfans.com",
  "chaturbate.com",
  "xnxx.com",
  "redtube.com",
  "youporn.com",
  "spankbang.com",
  "stripchat.com",
  "livejasmin.com",
  "cam4.com",
  "bongacams.com",
  "myfreecams.com",
  "nhentai.net",
  "hanime.tv",
  "rule34.xxx",
  "e-hentai.org",
  "hentaihaven.xxx",
  // Adult ad networks & popup redirect pipes
  "trafficjunky.com",
  "exoclick.com",
  "juicyads.com",
  "clickadu.com",
  "propellerads.com",
  "popads.net",
  "popcash.net",
  "adsterra.com",
  "hilltopads.net",
  "a-ads.com",
  "pushground.com",
  "evadav.com",
  "trafficstars.com",
  "tsyndicate.com",
  "revcontent.com",
  "mgid.com",
  // Social Media
  "twitter.com",
  "x.com",
  "reddit.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "snapchat.com",
  "discord.com",
  "twitch.tv",
];

const TEEN_BLOCK_LIST: string[] = [
  // Adult content
  "pornhub.com",
  "xvideos.com",
  "xhamster.com",
  "onlyfans.com",
  "chaturbate.com",
  "xnxx.com",
  "redtube.com",
  "youporn.com",
  "spankbang.com",
  "stripchat.com",
  "livejasmin.com",
  "cam4.com",
  "bongacams.com",
  "myfreecams.com",
  "nhentai.net",
  "hanime.tv",
  "rule34.xxx",
  "e-hentai.org",
  "hentaihaven.xxx",
  // Adult ad networks & popup redirect pipes
  "trafficjunky.com",
  "exoclick.com",
  "juicyads.com",
  "clickadu.com",
  "propellerads.com",
  "popads.net",
  "popcash.net",
  "adsterra.com",
  "hilltopads.net",
  "a-ads.com",
  "pushground.com",
  "evadav.com",
  "trafficstars.com",
  "tsyndicate.com",
  // Malware / phishing
  "malware.test",
  "phishing-site.test",
  "fakelogin.test",
  "scam-downloads.test",
  // Gambling
  "stake.com",
  "draftkings.com",
  "fanduel.com",
  "bet365.com",
  "pokerstars.com",
];

// Resource types eligible for blocking
/* RESOURCE_TYPES removed — dynamic rules use requestDomains only (keeps DNR rules simple and compatible). */

/**
 * Promisified chrome.storage.local.get that returns a typed result.
 *
 * Note: we cast `keys` to `any` when calling into `chrome.storage.local.get`
 * because the overloads in @types/chrome are strict and at runtime we may pass
 * a string, array, or object; casting here preserves strong typing for call
 * sites while keeping the runtime invocation safe.
 */
async function storageGet<T = Record<string, unknown>>(
  keys?: string | string[] | Record<string, unknown> | null,
): Promise<T> {
  const items = await chrome.storage.local.get(
    keys as string | string[] | null,
  );
  return items as T;
}

/**
 * Promisified chrome.storage.local.set
 */
async function storageSet(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(items);
}

/**
 * Promisified chrome.declarativeNetRequest.updateDynamicRules
 */
function updateDynamicRules(params: {
  removeRuleIds?: number[];
  addRules?: chrome.declarativeNetRequest.Rule[];
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      // Use the object form expected by chrome.declarativeNetRequest.updateDynamicRules
      chrome.declarativeNetRequest.updateDynamicRules(params, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Build an array of declarativeNetRequest.Rule objects from a list of domains.
 * Uses `requestDomains` which is efficient and avoids broad urlFilters where possible.
 */
function buildRulesFromDomains(
  domains: string[],
  startingId = 10000,
): chrome.declarativeNetRequest.Rule[] {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let id = startingId;

  for (const raw of domains) {
    if (!raw || rules.length >= MAX_DYNAMIC_RULES) break;

    const domain = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/?#]/)[0];
    if (!domain || domain.length > 255) continue;

    const rule: chrome.declarativeNetRequest.Rule = {
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: [domain],
        resourceTypes: [
          "main_frame",
          "sub_frame",
          "stylesheet",
          "script",
          "image",
          "font",
          "object",
          "xmlhttprequest",
          "ping",
          "media",
          "websocket",
          "other",
        ],
      },
    };
    rules.push(rule);
  }
  return rules;
}

/**
 * Applies user-custom blocking rules in lane 10000–15000 using blank-slate removal.
 * The entire lane is purged unconditionally before new rules are added.
 */
async function applyBlockingRules(domains: string[]): Promise<void> {
  try {
    // Blank-slate: purge the entire user-custom lane (10000–15000)
    const removeIds: number[] = [];
    for (let i = 10000; i <= 15000; i++) removeIds.push(i);

    const addRules = buildRulesFromDomains(domains, 10000);
    await updateDynamicRules({ removeRuleIds: removeIds, addRules });
    console.info(
      `Sentinel: Applied ${addRules.length} user blocking rules (lane 10000).`,
    );
  } catch (err) {
    console.error("Sentinel: Failed to apply blocking rules:", err);
  }
}

/**
 * Remove all dynamic rules from both user-custom and parental lanes using blank-slate removal.
 */
async function clearAllBlockingRules(): Promise<void> {
  try {
    // Blank-slate: purge both user-custom lane and parental lane
    const removeIds: number[] = [];
    for (let i = 10000; i <= 15000; i++) removeIds.push(i);
    for (let i = 20000; i <= 25000; i++) removeIds.push(i);
    for (let i = 30000; i <= 30010; i++) removeIds.push(i);

    await updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
    console.info(
      "Sentinel: Cleared all dynamic rules (lanes 10000 + 20000 + 30000).",
    );
  } catch (err) {
    console.error("Sentinel: Failed to clear dynamic rules:", err);
  }
}

/**
 * Apply parental age-tier blocking rules in lane 20000–25000.
 * Uses blank-slate removal: the entire parental lane is purged before adding new rules.
 * This operates independently of user-custom rules (lane 10000).
 */
async function applyAgeTierRules(tier: string): Promise<void> {
  try {
    const stored = await storageGet<Record<string, unknown>>([
      STORAGE_KEY_TIERED_DNS,
    ]);
    const tieredEnabled = stored[STORAGE_KEY_TIERED_DNS] !== false;

    // Blank-slate: always purge the entire parental lane (20000–25000)
    const removeIds: number[] = [];
    for (let i = 20000; i <= 25000; i++) removeIds.push(i);

    if (!tieredEnabled || tier === "adult") {
      // No parental rules needed — just clear the lane
      await updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
      console.info("Sentinel: Parental tier lane cleared (adult or disabled).");
      await applySafeSearchRules(tier);
      return;
    }

    let tierDomains: string[] = [];
    if (tier === "child") {
      tierDomains = [...CHILD_BLOCK_LIST];
    } else if (tier === "teen") {
      tierDomains = [...TEEN_BLOCK_LIST];
    }

    // Build rules in the parental lane (20000+)
    const addRules = buildRulesFromDomains(tierDomains, 20000);
    await updateDynamicRules({ removeRuleIds: removeIds, addRules });
    console.info(
      `Sentinel: Applied age tier "${tier}" with ${addRules.length} parental rules (lane 20000).`,
    );
    // Also apply/clear SafeSearch enforcement for this tier
    await applySafeSearchRules(tier);
  } catch (err) {
    console.error("Sentinel: Failed to apply age tier rules:", err);
  }
}

/**
 * Build SafeSearch redirect rules for search engines.
 * Uses queryTransform to force safe-search parameters on Google, Bing, and DuckDuckGo.
 * Lane: 30000–30010.
 */
function buildSafeSearchRules(): chrome.declarativeNetRequest.Rule[] {
  return [
    {
      id: 30001,
      priority: 2,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: "safe", value: "active" }],
            },
          },
        },
      },
      condition: {
        urlFilter: "||google.com/search",
        resourceTypes: ["main_frame"],
      },
    },
    {
      id: 30002,
      priority: 2,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: "adlt", value: "strict" }],
            },
          },
        },
      },
      condition: {
        urlFilter: "||bing.com/search",
        resourceTypes: ["main_frame"],
      },
    },
    {
      id: 30003,
      priority: 2,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: "kp", value: "1" }],
            },
          },
        },
      },
      condition: {
        urlFilter: "||duckduckgo.com/",
        resourceTypes: ["main_frame"],
      },
    },
  ];
}

/**
 * Apply or clear SafeSearch enforcement rules in lane 30000–30010.
 * Enabled for child and teen tiers; cleared for adult tier or when tiered DNS is off.
 */
async function applySafeSearchRules(tier: string): Promise<void> {
  try {
    const stored = await storageGet<Record<string, unknown>>([
      STORAGE_KEY_TIERED_DNS,
    ]);
    const tieredEnabled = stored[STORAGE_KEY_TIERED_DNS] !== false;

    // Always purge the SafeSearch lane first
    const removeIds: number[] = [];
    for (let i = 30000; i <= 30010; i++) removeIds.push(i);

    if (tieredEnabled && (tier === "child" || tier === "teen")) {
      const addRules = buildSafeSearchRules();
      await updateDynamicRules({ removeRuleIds: removeIds, addRules });
      console.info(
        `Sentinel: SafeSearch enforcement enabled for tier "${tier}".`,
      );
    } else {
      await updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
      console.info("Sentinel: SafeSearch enforcement cleared.");
    }
  } catch (err) {
    console.error("Sentinel: Failed to apply SafeSearch rules:", err);
  }
}

type LogEntry = { url: string; timestamp: number };
const STORAGE_KEY_LOGS = "blockedLogs";

if (
  typeof chrome !== "undefined" &&
  chrome.declarativeNetRequest &&
  chrome.declarativeNetRequest.onRuleMatchedDebug
) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const url = info.request.url;
    if (url) {
      void logBlockedRequest(url);
    }
  });
}

async function logBlockedRequest(url: string): Promise<void> {
  try {
    const items = await storageGet<Record<string, unknown>>([STORAGE_KEY_LOGS]);
    const logs = (
      Array.isArray(items[STORAGE_KEY_LOGS]) ? items[STORAGE_KEY_LOGS] : []
    ) as LogEntry[];
    logs.unshift({ url, timestamp: Date.now() });
    if (logs.length > 50) {
      logs.length = 50;
    }
    await storageSet({ [STORAGE_KEY_LOGS]: logs });
  } catch (err) {
    console.error("Sentinel: Failed to log request", err);
  }
}

/**
 * Reads the AI-generated trust score from cache for the active tab.
 * Returns score: -1 when no AI scan has completed yet (signals "scanning" to the UI).
 */
async function calculateTrustScore(): Promise<{
  score: number;
  isSecure: boolean;
}> {
  let url = "";
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0 && tabs[0].url) {
      url = tabs[0].url;
    }
  } catch (err) {
    console.error("Sentinel: Failed to query active tab", err);
  }

  const isSecure = !url.startsWith("http://");

  // Internal pages get a perfect score without AI
  if (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://")
  ) {
    return { score: 100, isSecure: true };
  }

  // Read the AI cache for this hostname
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { score: -1, isSecure };
  }

  const cacheKey = "ai_cache_" + hostname;
  const items = await storageGet<Record<string, unknown>>([cacheKey]);
  const cached = items[cacheKey] as
    | { report?: string; timestamp?: number }
    | undefined;

  if (!cached || !cached.report) {
    // No scan result yet — UI should show "Scanning..."
    return { score: -1, isSecure };
  }

  // Parse [SCORE: X] from the cached AI report
  const match = cached.report.match(/\[SCORE:\s*(\d+)\]/i);
  if (match) {
    const score = Math.max(0, Math.min(100, parseInt(match[1], 10)));
    return { score, isSecure };
  }

  // Report exists but no parseable score — show as yellow/unknown
  return { score: 50, isSecure };
}

/**
 * Initialize persisted state and ensure DNR rules reflect saved preferences.
 */
async function initialize(): Promise<void> {
  try {
    const stored = await storageGet<Record<string, unknown>>([
      STORAGE_KEY_NETWORK,
      STORAGE_KEY_BLOCKED,
    ]);

    const networkEnabled =
      typeof stored[STORAGE_KEY_NETWORK] === "boolean"
        ? (stored[STORAGE_KEY_NETWORK] as boolean)
        : true;
    const blocked =
      Array.isArray(stored[STORAGE_KEY_BLOCKED]) &&
      (stored[STORAGE_KEY_BLOCKED] as string[]).length > 0
        ? (stored[STORAGE_KEY_BLOCKED] as string[])
        : Array.from(DEFAULT_BLOCKED_DOMAINS);

    // Persist defaults if nothing set
    await storageSet({
      [STORAGE_KEY_NETWORK]: networkEnabled,
      [STORAGE_KEY_BLOCKED]: blocked,
    });

    if (networkEnabled) {
      // Apply user-custom rules in lane 10000
      await applyBlockingRules(blocked);
      // Apply parental rules in lane 20000 (applyAgeTierRules handles its own enable/tier check)
      const tierData = await storageGet<Record<string, unknown>>([
        STORAGE_KEY_AGE_TIER,
      ]);
      const tier = (tierData[STORAGE_KEY_AGE_TIER] as string) || "adult";
      await applyAgeTierRules(tier);
    } else {
      await clearAllBlockingRules();
    }

    console.info("Sentinel: Background initialized.", {
      networkEnabled,
      blockedCount: blocked.length,
    });
  } catch (err) {
    console.error("Sentinel: Initialization failed:", err);
  }
}

/**
 * Runtime message handler for UI -> background commands.
 */
chrome.runtime.onMessage.addListener(
  (
    message: UIMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    (async () => {
      try {
        switch (message.type) {
          case "toggleNetworkFilter": {
            await storageSet({ [STORAGE_KEY_NETWORK]: message.enabled });
            if (message.enabled) {
              const items = await storageGet<Record<string, unknown>>([
                STORAGE_KEY_BLOCKED,
              ]);
              const domains = Array.isArray(items[STORAGE_KEY_BLOCKED])
                ? (items[STORAGE_KEY_BLOCKED] as string[])
                : Array.from(DEFAULT_BLOCKED_DOMAINS);
              await applyBlockingRules(domains);
            } else {
              await clearAllBlockingRules();
            }
            sendResponse({ success: true });
            break;
          }

          case "setBlockedDomains": {
            const domains = Array.isArray(message.domains)
              ? message.domains.slice(0, MAX_DYNAMIC_RULES)
              : [];
            await storageSet({ [STORAGE_KEY_BLOCKED]: domains });
            const items = await storageGet<Record<string, unknown>>([
              STORAGE_KEY_NETWORK,
            ]);
            const enabled = items[STORAGE_KEY_NETWORK] !== false;
            if (enabled) {
              await applyBlockingRules(domains);
            }
            sendResponse({ success: true, count: domains.length });
            break;
          }

          case "getState": {
            const items = await storageGet<Record<string, unknown>>([
              STORAGE_KEY_NETWORK,
              STORAGE_KEY_BLOCKED,
            ]);

            const { score, isSecure } = await calculateTrustScore();

            const state: SentinelState = {
              networkFilterEnabled: items[STORAGE_KEY_NETWORK] !== false,
              blockedDomains:
                Array.isArray(items[STORAGE_KEY_BLOCKED]) &&
                (items[STORAGE_KEY_BLOCKED] as string[]).length > 0
                  ? (items[STORAGE_KEY_BLOCKED] as string[])
                  : Array.from(DEFAULT_BLOCKED_DOMAINS),
              trustScore: score,
              isSecureConnection: isSecure,
            };
            sendResponse({ success: true, state });
            break;
          }

          case "clearRules": {
            await clearAllBlockingRules();
            sendResponse({ success: true });
            break;
          }

          case "setAgeTier": {
            const tier = message.tier || "adult";
            await storageSet({ [STORAGE_KEY_AGE_TIER]: tier });
            const networkItems = await storageGet<Record<string, unknown>>([
              STORAGE_KEY_NETWORK,
            ]);
            const netEnabled = networkItems[STORAGE_KEY_NETWORK] !== false;
            if (netEnabled) {
              await applyAgeTierRules(tier);
            }
            sendResponse({ success: true, tier });
            break;
          }

          case "setFilterMode": {
            const enableIds: string[] = [];
            const disableIds: string[] = [];

            if (message.standard) {
              enableIds.push("ruleset_standard");
            } else {
              disableIds.push("ruleset_standard");
            }

            if (message.aggressive) {
              enableIds.push("ruleset_aggressive");
              enableIds.push("ruleset_easylist");
            } else {
              disableIds.push("ruleset_aggressive");
              disableIds.push("ruleset_easylist");
            }

            await chrome.declarativeNetRequest.updateEnabledRulesets({
              enableRulesetIds: enableIds,
              disableRulesetIds: disableIds,
            });

            await storageSet({
              filterStandard: message.standard,
              filterAggressive: message.aggressive,
            });

            console.info(
              `Sentinel: Filter mode updated — standard=${message.standard}, aggressive=${message.aggressive}`,
            );
            sendResponse({ success: true });
            break;
          }

          default:
            sendResponse({ success: false, error: "Unknown message type" });
        }
      } catch (err) {
        console.error("Sentinel: Error handling message", message, err);
        sendResponse({ success: false, error: String(err) });
      }
    })();

    // Keep the message channel open for async response
    return true;
  },
);

/**
 * Storage change listener — reacts when other extension parts update preferences.
 */
chrome.storage.onChanged.addListener(
  (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ) => {
    if (areaName !== "local") return;

    if (changes[STORAGE_KEY_BLOCKED]) {
      const newDomains = Array.isArray(changes[STORAGE_KEY_BLOCKED].newValue)
        ? (changes[STORAGE_KEY_BLOCKED].newValue as string[])
        : undefined;
      storageGet([STORAGE_KEY_NETWORK])
        .then((items) => {
          const enabled = items[STORAGE_KEY_NETWORK] !== false;
          if (enabled) {
            applyBlockingRules(
              newDomains && newDomains.length > 0
                ? newDomains
                : Array.from(DEFAULT_BLOCKED_DOMAINS),
            );
          }
        })
        .catch((err) =>
          console.error("Sentinel: storage.onChanged handler error:", err),
        );
    }

    if (changes[STORAGE_KEY_NETWORK]) {
      const newEnabled =
        typeof changes[STORAGE_KEY_NETWORK].newValue === "boolean"
          ? (changes[STORAGE_KEY_NETWORK].newValue as boolean)
          : undefined;
      if (newEnabled) {
        storageGet([STORAGE_KEY_BLOCKED])
          .then((items) => {
            const domains = Array.isArray(items[STORAGE_KEY_BLOCKED])
              ? (items[STORAGE_KEY_BLOCKED] as string[])
              : Array.from(DEFAULT_BLOCKED_DOMAINS);
            applyBlockingRules(domains);
          })
          .catch((err) =>
            console.error(
              "Sentinel: failed to read blocklist on network enable",
              err,
            ),
          );
      } else {
        clearAllBlockingRules();
      }
    }

    if (changes[STORAGE_KEY_TIERED_DNS] || changes[STORAGE_KEY_AGE_TIER]) {
      storageGet([
        STORAGE_KEY_AGE_TIER,
        STORAGE_KEY_TIERED_DNS,
        STORAGE_KEY_NETWORK,
      ])
        .then((items) => {
          const netEnabled = items[STORAGE_KEY_NETWORK] !== false;
          if (netEnabled) {
            const tier = (items[STORAGE_KEY_AGE_TIER] as string) || "adult";
            applyAgeTierRules(tier);
          }
        })
        .catch((err) =>
          console.error("Sentinel: age tier storage change error:", err),
        );
    }
  },
);

// Lifecycle handlers
chrome.runtime.onInstalled.addListener(
  (details: chrome.runtime.InstalledDetails) => {
    console.info("Sentinel: onInstalled", details);
    // Initialize state and rules for first install or updates.
    void initialize();
  },
);
chrome.runtime.onStartup.addListener(() => {
  console.info("Sentinel: onStartup");
  void initialize();
});

console.info("🛡️ Sentinel background service worker active.");
