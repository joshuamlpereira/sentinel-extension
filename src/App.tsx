import { useEffect, useState } from "react";

type ViewState = "main" | "pin-setup" | "pin-prompt" | "admin" | "ai-report";
type LogEntry = { url: string; timestamp: number };
type AdminTab = "dashboard" | "domains" | "logs" | "settings";

async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function App() {
  const [trustScore, setTrustScore] = useState(-1);
  const [isSecure, setIsSecure] = useState(true);
  const [canvasNoise, setCanvasNoise] = useState(true);
  const [locationSpoofing, setLocationSpoofing] = useState(true);
  const [autoAiScan, setAutoAiScan] = useState(true);
  const [networkFilter, setNetworkFilter] = useState(true);

  const [view, setView] = useState<ViewState>("main");
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [aiTag, setAiTag] = useState<string>("YELLOW");
  const [aiSummary, setAiSummary] = useState<string>("");

  const [adminTab, setAdminTab] = useState<AdminTab>("dashboard");
  const [blockedDomains, setBlockedDomains] = useState<string[]>([]);
  const [whitelistedDomains, setWhitelistedDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [domainError, setDomainError] = useState("");
  const [logFilter, setLogFilter] = useState("");
  const [autoBlockTrackers, setAutoBlockTrackers] = useState(true);
  const [blockMalware, setBlockMalware] = useState(true);
  const [blockAds, setBlockAds] = useState(true);
  const [ageTier, setAgeTier] = useState<"child" | "teen" | "adult">("adult");
  const [tieredDns, setTieredDns] = useState(false);
  const [filterStandard, setFilterStandard] = useState(false);
  const [filterAggressive, setFilterAggressive] = useState(false);

  const refreshState = () => {
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage(
          { type: "getState" },
          (resp: {
            success?: boolean;
            state?: {
              networkFilterEnabled?: boolean;
              trustScore?: number;
              isSecureConnection?: boolean;
              blockedDomains?: string[];
            };
          }) => {
            if (resp && resp.success && resp.state) {
              setNetworkFilter(Boolean(resp.state.networkFilterEnabled));
              if (typeof resp.state.isSecureConnection === "boolean") {
                setIsSecure(resp.state.isSecureConnection);
              }
              if (Array.isArray(resp.state.blockedDomains)) {
                setBlockedDomains(resp.state.blockedDomains);
              }
            }
          },
        );
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshState();

    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.get(
        [
          "canvasObfuscation",
          "locationSpoofing",
          "autoAiScan",
          "whitelistedDomains",
          "parentalAgeTier",
          "tieredDnsEnabled",
          "filterStandard",
          "filterAggressive",
        ],
        (items: { [key: string]: unknown }) => {
          if (items && typeof items.canvasObfuscation !== "undefined") {
            setCanvasNoise(Boolean(items.canvasObfuscation));
          } else {
            setCanvasNoise(true);
            chrome.storage.local.set({ canvasObfuscation: true });
          }
          if (items && typeof items.locationSpoofing !== "undefined") {
            setLocationSpoofing(Boolean(items.locationSpoofing));
          } else {
            setLocationSpoofing(true);
            chrome.storage.local.set({ locationSpoofing: true });
          }
          if (items && typeof items.autoAiScan !== "undefined") {
            setAutoAiScan(Boolean(items.autoAiScan));
          } else {
            setAutoAiScan(true);
            chrome.storage.local.set({ autoAiScan: true });
          }
          if (Array.isArray(items.whitelistedDomains)) {
            setWhitelistedDomains(items.whitelistedDomains as string[]);
          }
          if (typeof items.parentalAgeTier === "string") {
            setAgeTier(items.parentalAgeTier as "child" | "teen" | "adult");
          }
          if (typeof items.tieredDnsEnabled === "boolean") {
            setTieredDns(items.tieredDnsEnabled as boolean);
          }
          if (typeof items.filterStandard === "boolean") {
            setFilterStandard(items.filterStandard as boolean);
          }
          if (typeof items.filterAggressive === "boolean") {
            setFilterAggressive(items.filterAggressive as boolean);
          }
        },
      );

      const normalizeHostname = (raw: string) =>
        raw.toLowerCase().replace(/^www\./, "");

      // Cache entry shape written by content.ts — pre-parsed fields
      type AiCacheEntry = {
        report?: string;
        score?: number;
        tag?: string;
        summary?: string;
        timestamp?: number;
      };

      // Read the AI cache for a given hostname and update React state.
      // Reads the pre-parsed score directly — no regex re-parsing.
      const applyCacheToState = (cached: AiCacheEntry) => {
        setAiReport(cached.report || null);
        setAiTag(cached.tag || "YELLOW");
        setAiSummary(cached.summary || "");
        if (typeof cached.score === "number" && cached.score >= 0) {
          setTrustScore(cached.score);
        } else {
          setTrustScore(50);
        }
      };

      const readAiCache = (hostname: string) => {
        const cacheKey = "ai_cache_" + normalizeHostname(hostname);
        chrome.storage.local.get([cacheKey], (cacheItems) => {
          const cached = cacheItems[cacheKey] as AiCacheEntry | undefined;
          if (cached?.report) {
            applyCacheToState(cached);
          }
        });
      };

      // Resolve the active tab hostname, read cache, and register a
      // real-time listener. Uses TWO strategies to guarantee resolution:
      //  1. chrome.tabs.query for the hostname-specific cache key
      //  2. A wildcard storage listener that catches ANY ai_cache_ write
      let resolvedHostname = "";

      // Strategy 1: direct cache read via tab URL
      try {
        if (chrome.tabs && chrome.tabs.query) {
          chrome.tabs.query(
            { active: true, currentWindow: true },
            (tabs) => {
              if (tabs[0]?.url) {
                try {
                  resolvedHostname = normalizeHostname(
                    new URL(tabs[0].url).hostname,
                  );
                } catch {
                  /* ignore */
                }
              }
              if (resolvedHostname) {
                readAiCache(resolvedHostname);
                // Delayed retry for in-flight scans
                setTimeout(() => readAiCache(resolvedHostname), 3000);
              }
            },
          );
        }
      } catch {
        /* ignore */
      }

      // Strategy 2: listen for ANY ai_cache_ storage change.
      // This fires regardless of whether chrome.tabs.query succeeded,
      // and handles hostname mismatches by accepting any cache write.
      const storageListener = (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string,
      ) => {
        if (areaName !== "local") return;
        for (const key of Object.keys(changes)) {
          if (!key.startsWith("ai_cache_")) continue;
          if (resolvedHostname && key !== "ai_cache_" + resolvedHostname)
            continue;
          const newVal = changes[key].newValue as AiCacheEntry | undefined;
          if (newVal?.report) {
            applyCacheToState(newVal);
          }
          break;
        }
      };
      chrome.storage.onChanged.addListener(storageListener);

      return () => {
        chrome.storage.onChanged.removeListener(storageListener);
      };
    }
  }, []);

  const toggleNetworkFilter = () => {
    const next = !networkFilter;
    setNetworkFilter(next);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage(
          { type: "toggleNetworkFilter", enabled: next },
          () => {
            refreshState();
          },
        );
      }
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ networkFilterEnabled: next });
      }
    } catch {
      // ignore
    }
  };

  const toggleCanvasNoise = () => {
    const next = !canvasNoise;
    setCanvasNoise(next);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ canvasObfuscation: next }, () => {
          refreshState();
        });
      }
    } catch {
      // ignore
    }
  };

  const toggleLocationSpoofing = () => {
    const next = !locationSpoofing;
    setLocationSpoofing(next);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ locationSpoofing: next }, () => {
          refreshState();
        });
      }
    } catch {
      // ignore
    }
  };

  const toggleAutoAiScan = () => {
    const next = !autoAiScan;
    setAutoAiScan(next);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ autoAiScan: next });
      }
    } catch {
      // ignore
    }
  };

  const handleAdminClick = async () => {
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.get(
        ["adminPin"],
        (items: { [key: string]: unknown }) => {
          if (items.adminPin) {
            setView("pin-prompt");
          } else {
            setView("pin-setup");
          }
        },
      );
    } else {
      setView("pin-setup");
    }
  };

  const loadLogs = () => {
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.get(
        ["blockedLogs"],
        (items: { [key: string]: unknown }) => {
          if (Array.isArray(items.blockedLogs)) {
            setLogs(items.blockedLogs as LogEntry[]);
          }
        },
      );
    }
  };

  const handlePinSetup = async () => {
    if (pinInput.length !== 4 || isNaN(Number(pinInput))) {
      setPinError("PIN must be 4 digits");
      return;
    }
    const hashed = await hashPin(pinInput);
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.set({ adminPin: hashed });
    }
    setView("admin");
    setPinInput("");
    setPinError("");
    loadLogs();
  };

  const handlePinSubmit = async () => {
    const hashed = await hashPin(pinInput);
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.get(
        ["adminPin"],
        (items: { [key: string]: unknown }) => {
          if (items.adminPin === hashed) {
            setView("admin");
            setPinInput("");
            setPinError("");
            loadLogs();
          } else {
            setPinError("Incorrect PIN");
            setPinInput("");
          }
        },
      );
    } else {
      setView("admin");
    }
  };

  const addDomain = async (domain: string, toWhitelist: boolean = false) => {
    if (!domain || domain.trim().length === 0) {
      setDomainError("Domain cannot be empty");
      return;
    }

    const cleanDomain = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/?#]/)[0];

    if (toWhitelist) {
      if (whitelistedDomains.includes(cleanDomain)) {
        setDomainError("Domain already whitelisted");
        return;
      }
      const updated = [...whitelistedDomains, cleanDomain];
      setWhitelistedDomains(updated);
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ whitelistedDomains: updated });
      }
    } else {
      if (blockedDomains.includes(cleanDomain)) {
        setDomainError("Domain already blocked");
        return;
      }
      const updated = [...blockedDomains, cleanDomain];
      setBlockedDomains(updated);
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage({
          type: "setBlockedDomains",
          domains: updated,
        });
      }
    }
    setNewDomain("");
    setDomainError("");
  };

  const removeDomain = (domain: string, fromWhitelist: boolean = false) => {
    if (fromWhitelist) {
      const updated = whitelistedDomains.filter((d) => d !== domain);
      setWhitelistedDomains(updated);
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ whitelistedDomains: updated });
      }
    } else {
      const updated = blockedDomains.filter((d) => d !== domain);
      setBlockedDomains(updated);
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage({
          type: "setBlockedDomains",
          domains: updated,
        });
      }
    }
  };

  const clearAllLogs = () => {
    if (confirm("Are you sure you want to clear all logs?")) {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ blockedLogs: [] });
        setLogs([]);
      }
    }
  };

  const handleAgeTierChange = (tier: "child" | "teen" | "adult") => {
    setAgeTier(tier);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ parentalAgeTier: tier });
      }
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage({ type: "setAgeTier", tier });
      }
    } catch {
      // ignore
    }
  };

  const handleTieredDnsToggle = () => {
    const next = !tieredDns;
    setTieredDns(next);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ tieredDnsEnabled: next });
      }
    } catch {
      // ignore
    }
  };

  const toggleFilterStandard = () => {
    const next = !filterStandard;
    setFilterStandard(next);
    // If turning off standard, also turn off aggressive
    const nextAggressive = next ? filterAggressive : false;
    if (!next) setFilterAggressive(false);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage({
          type: "setFilterMode",
          standard: next,
          aggressive: nextAggressive,
        });
      }
    } catch {
      // ignore
    }
  };

  const toggleFilterAggressive = () => {
    const next = !filterAggressive;
    setFilterAggressive(next);
    // If turning on aggressive, also ensure standard is on
    const nextStandard = next ? true : filterStandard;
    if (next) setFilterStandard(true);
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage({
          type: "setFilterMode",
          standard: nextStandard,
          aggressive: next,
        });
      }
    } catch {
      // ignore
    }
  };

  const exportData = () => {
    const data = {
      blockedDomains,
      whitelistedDomains,
      logs,
      settings: {
        networkFilterEnabled: networkFilter,
        canvasObfuscation: canvasNoise,
        locationSpoofing,
        autoAiScan,
        autoBlockTrackers,
        blockMalware,
        blockAds,
        parentalAgeTier: ageTier,
        tieredDnsEnabled: tieredDns,
      },
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sentinel-backup-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetPin = async () => {
    if (confirm("Are you sure you want to reset your PIN?")) {
      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ adminPin: "" });
        setView("main");
      }
    }
  };

  const filteredLogs = logs.filter(
    (log) =>
      logFilter.length === 0 ||
      log.url.toLowerCase().includes(logFilter.toLowerCase()),
  );

  if (view !== "main") {
    return (
      <div className="flex flex-col h-full w-[450px] bg-slate-900 text-slate-100 font-sans">
        {view === "pin-setup" && (
          <div className="flex flex-col h-full items-center justify-center p-4 bg-gradient-to-b from-slate-800 to-slate-900">
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-8 w-full max-w-sm">
              <h1 className="text-2xl font-bold text-cyan-400 mb-6 text-center">
                Set Admin PIN
              </h1>
              <p className="text-sm text-slate-300 mb-4 text-center">
                Create a 4-digit PIN to secure your admin panel
              </p>
              <input
                type="password"
                maxLength={4}
                inputMode="numeric"
                className="w-full text-center bg-slate-700 border border-slate-600 rounded p-3 text-2xl tracking-widest outline-none focus:border-cyan-500 mb-4"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="0000"
              />
              <button
                onClick={handlePinSetup}
                className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2 px-4 rounded transition-colors mb-2"
              >
                Save PIN
              </button>
              <button
                onClick={() => {
                  setView("main");
                  setPinInput("");
                  setPinError("");
                }}
                className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 font-semibold py-2 px-4 rounded transition-colors"
              >
                Cancel
              </button>
              {pinError && (
                <p className="text-red-400 text-xs mt-3 text-center">
                  {pinError}
                </p>
              )}
            </div>
          </div>
        )}

        {view === "pin-prompt" && (
          <div className="flex flex-col h-full items-center justify-center p-4 bg-gradient-to-b from-slate-800 to-slate-900">
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-8 w-full max-w-sm">
              <h1 className="text-2xl font-bold text-cyan-400 mb-6 text-center">
                Admin Access
              </h1>
              <p className="text-sm text-slate-300 mb-4 text-center">
                Enter your 4-digit PIN to continue
              </p>
              <input
                type="password"
                maxLength={4}
                inputMode="numeric"
                className="w-full text-center bg-slate-700 border border-slate-600 rounded p-3 text-2xl tracking-widest outline-none focus:border-cyan-500 mb-4"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="0000"
              />
              <button
                onClick={handlePinSubmit}
                className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2 px-4 rounded transition-colors mb-2"
              >
                Unlock
              </button>
              <button
                onClick={() => {
                  setView("main");
                  setPinInput("");
                  setPinError("");
                }}
                className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 font-semibold py-2 px-4 rounded transition-colors"
              >
                Cancel
              </button>
              {pinError && (
                <p className="text-red-400 text-xs mt-3 text-center">
                  {pinError}
                </p>
              )}
            </div>
          </div>
        )}

        {view === "admin" && (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex justify-between items-center border-b border-slate-700 p-4 bg-slate-800">
              <h1 className="text-2xl font-bold tracking-wider text-cyan-400">
                ADMIN DASHBOARD
              </h1>
              <button
                onClick={() => {
                  setView("main");
                  setPinInput("");
                  setPinError("");
                  setAdminTab("dashboard");
                }}
                className="text-sm text-slate-400 hover:text-white transition-colors bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded"
              >
                Close
              </button>
            </div>

            {/* Tab Navigation */}
            <div className="flex gap-2 border-b border-slate-700 bg-slate-850 p-3 overflow-x-auto">
              {(["dashboard", "domains", "logs", "settings"] as AdminTab[]).map(
                (tab) => (
                  <button
                    key={tab}
                    onClick={() => setAdminTab(tab)}
                    className={`px-4 py-2 rounded text-sm font-semibold whitespace-nowrap transition-colors ${
                      adminTab === tab
                        ? "bg-cyan-600 text-white"
                        : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                    }`}
                  >
                    {tab.replace("-", " ").toUpperCase()}
                  </button>
                ),
              )}
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* Dashboard Tab */}
              {adminTab === "dashboard" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                        Total Events
                      </p>
                      <p className="text-3xl font-bold text-cyan-400">
                        {logs.length}
                      </p>
                    </div>
                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                        Blocked Domains
                      </p>
                      <p className="text-3xl font-bold text-emerald-400">
                        {blockedDomains.length}
                      </p>
                    </div>
                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                        Whitelisted
                      </p>
                      <p className="text-3xl font-bold text-yellow-400">
                        {whitelistedDomains.length}
                      </p>
                    </div>
                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                        Status
                      </p>
                      <p className="text-sm font-semibold text-emerald-400">
                        ● Active
                      </p>
                    </div>
                  </div>

                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <h3 className="text-lg font-bold text-cyan-400 mb-3">
                      Active Defenses
                    </h3>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-slate-300">
                          Network Filtering
                        </span>
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            networkFilter
                              ? "bg-emerald-500 text-white"
                              : "bg-red-500 text-white"
                          }`}
                        >
                          {networkFilter ? "ON" : "OFF"}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-slate-300">
                          Canvas Obfuscation
                        </span>
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            canvasNoise
                              ? "bg-emerald-500 text-white"
                              : "bg-red-500 text-white"
                          }`}
                        >
                          {canvasNoise ? "ON" : "OFF"}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-slate-300">
                          Location Spoofing
                        </span>
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            locationSpoofing
                              ? "bg-emerald-500 text-white"
                              : "bg-red-500 text-white"
                          }`}
                        >
                          {locationSpoofing ? "ON" : "OFF"}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-slate-300">
                          Auto-Scan (AI)
                        </span>
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            autoAiScan
                              ? "bg-emerald-500 text-white"
                              : "bg-red-500 text-white"
                          }`}
                        >
                          {autoAiScan ? "ON" : "OFF"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Domains Tab */}
              {adminTab === "domains" && (
                <div className="space-y-4">
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <h3 className="text-lg font-bold text-cyan-400 mb-3">
                      Add Domain
                    </h3>
                    <div className="flex gap-2 mb-2">
                      <input
                        type="text"
                        placeholder="example.com"
                        className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm outline-none focus:border-cyan-500"
                        value={newDomain}
                        onChange={(e) => setNewDomain(e.target.value)}
                      />
                      <button
                        onClick={() => addDomain(newDomain, false)}
                        className="bg-red-600 hover:bg-red-500 text-white font-semibold px-4 py-2 rounded text-sm transition-colors"
                      >
                        Block
                      </button>
                      <button
                        onClick={() => addDomain(newDomain, true)}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-4 py-2 rounded text-sm transition-colors"
                      >
                        Allow
                      </button>
                    </div>
                    {domainError && (
                      <p className="text-red-400 text-xs">{domainError}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-slate-800 border border-red-900 rounded-lg p-4">
                      <h4 className="text-sm font-bold text-red-400 mb-2">
                        Blocked Domains ({blockedDomains.length})
                      </h4>
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {blockedDomains.length === 0 ? (
                          <p className="text-xs text-slate-500 italic">
                            No blocked domains
                          </p>
                        ) : (
                          blockedDomains.map((domain, i) => (
                            <div
                              key={i}
                              className="flex justify-between items-center bg-slate-700 p-2 rounded text-xs"
                            >
                              <span className="text-slate-300 truncate">
                                {domain}
                              </span>
                              <button
                                onClick={() => removeDomain(domain, false)}
                                className="text-red-400 hover:text-red-300 ml-2"
                              >
                                ✕
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="bg-slate-800 border border-emerald-900 rounded-lg p-4">
                      <h4 className="text-sm font-bold text-emerald-400 mb-2">
                        Whitelisted Domains ({whitelistedDomains.length})
                      </h4>
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {whitelistedDomains.length === 0 ? (
                          <p className="text-xs text-slate-500 italic">
                            No whitelisted domains
                          </p>
                        ) : (
                          whitelistedDomains.map((domain, i) => (
                            <div
                              key={i}
                              className="flex justify-between items-center bg-slate-700 p-2 rounded text-xs"
                            >
                              <span className="text-slate-300 truncate">
                                {domain}
                              </span>
                              <button
                                onClick={() => removeDomain(domain, true)}
                                className="text-emerald-400 hover:text-emerald-300 ml-2"
                              >
                                ✕
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Logs Tab */}
              {adminTab === "logs" && (
                <div className="space-y-4">
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <div className="flex justify-between items-center mb-3">
                      <h3 className="text-lg font-bold text-cyan-400">
                        Blocked Events ({filteredLogs.length}/{logs.length})
                      </h3>
                      <button
                        onClick={clearAllLogs}
                        className="bg-red-600 hover:bg-red-500 text-white text-xs font-semibold px-3 py-1 rounded transition-colors"
                      >
                        Clear All
                      </button>
                    </div>
                    <input
                      type="text"
                      placeholder="Filter by URL..."
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm mb-3 outline-none focus:border-cyan-500"
                      value={logFilter}
                      onChange={(e) => setLogFilter(e.target.value)}
                    />
                    <div className="max-h-96 overflow-y-auto space-y-1">
                      {filteredLogs.length === 0 ? (
                        <p className="text-xs text-slate-500 italic text-center py-4">
                          No events to display
                        </p>
                      ) : (
                        filteredLogs.map((log, i) => (
                          <div
                            key={i}
                            className="bg-slate-700 p-2 rounded text-xs border-l-2 border-red-500"
                          >
                            <div className="text-slate-400">
                              {new Date(log.timestamp).toLocaleString()}
                            </div>
                            <div className="text-slate-300 break-all mt-1">
                              {log.url}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Settings Tab */}
              {adminTab === "settings" && (
                <div className="space-y-4">
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <h3 className="text-lg font-bold text-cyan-400 mb-4">
                      Feature Settings
                    </h3>
                    <div className="space-y-3">
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoBlockTrackers}
                          onChange={(e) =>
                            setAutoBlockTrackers(e.target.checked)
                          }
                          className="w-4 h-4 rounded"
                        />
                        <span className="ml-2 text-sm text-slate-300">
                          Auto-block tracking scripts
                        </span>
                      </label>
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={blockMalware}
                          onChange={(e) => setBlockMalware(e.target.checked)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="ml-2 text-sm text-slate-300">
                          Block malicious domains
                        </span>
                      </label>
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={blockAds}
                          onChange={(e) => setBlockAds(e.target.checked)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="ml-2 text-sm text-slate-300">
                          Block advertising networks
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Parental Controls */}
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <h3 className="text-lg font-bold text-cyan-400 mb-4">
                      🛡️ Parental Controls
                    </h3>

                    {/* Tiered DNS Toggle */}
                    <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-700">
                      <div>
                        <p className="text-sm font-semibold text-slate-200">
                          Enable Tiered DNS Filtering
                        </p>
                        <p className="text-xs text-slate-400">
                          Automatically blocks age-inappropriate domains
                        </p>
                      </div>
                      <button
                        onClick={handleTieredDnsToggle}
                        className={`w-12 h-6 rounded-full transition-colors relative ${
                          tieredDns ? "bg-cyan-500" : "bg-slate-600"
                        }`}
                      >
                        <span
                          className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                            tieredDns ? "left-7" : "left-1"
                          }`}
                        />
                      </button>
                    </div>

                    {/* Age Tier Selector */}
                    <p className="text-xs text-slate-400 mb-2">Age Tier</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(["child", "teen", "adult"] as const).map((tier) => (
                        <button
                          key={tier}
                          onClick={() => handleAgeTierChange(tier)}
                          className={`py-2 px-3 rounded text-sm font-semibold transition-colors ${
                            ageTier === tier
                              ? tier === "child"
                                ? "bg-blue-600 text-white"
                                : tier === "teen"
                                  ? "bg-amber-600 text-white"
                                  : "bg-slate-500 text-white"
                              : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                          }`}
                        >
                          {tier === "child"
                            ? "👶 Child"
                            : tier === "teen"
                              ? "🧑 Teen"
                              : "🧑‍💼 Adult"}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      {ageTier === "child"
                        ? "Blocks: Gambling, Adult Content, Social Media, Ad Networks & Popup Redirects. Enforces SafeSearch on Google, Bing & DuckDuckGo."
                        : ageTier === "teen"
                          ? "Blocks: Adult Content, Malware, Gambling, Ad Networks & Popup Redirects. Enforces SafeSearch on Google, Bing & DuckDuckGo."
                          : "No additional restrictions"}
                    </p>
                  </div>

                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <h3 className="text-lg font-bold text-cyan-400 mb-4">
                      Data Management
                    </h3>
                    <div className="space-y-2">
                      <button
                        onClick={exportData}
                        className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2 rounded transition-colors text-sm"
                      >
                        📥 Export Backup
                      </button>
                      <button
                        onClick={resetPin}
                        className="w-full bg-yellow-600 hover:bg-yellow-500 text-white font-semibold py-2 rounded transition-colors text-sm"
                      >
                        🔑 Reset PIN
                      </button>
                    </div>
                  </div>

                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                    <h3 className="text-lg font-bold text-cyan-400 mb-3">
                      System Info
                    </h3>
                    <div className="space-y-2 text-xs text-slate-400">
                      <div>Version: 0.6.0</div>
                      <div>Last Updated: {new Date().toLocaleDateString()}</div>
                      <div>Privacy: 100% Local - No cloud storage</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {view === "ai-report" && (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex justify-between items-center border-b border-slate-700 p-4 bg-slate-800">
              <h1 className="text-2xl font-bold tracking-wider text-cyan-400">
                AI PAGE SCANNER
              </h1>
              <button
                onClick={() => {
                  setView("main");
                }}
                className="text-sm text-slate-400 hover:text-white transition-colors bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded"
              >
                ← Back
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {aiReport &&
                (() => {
                  // Use pre-parsed fields from the cache — no re-parsing.
                  // trustScore, aiTag, aiSummary are set by applyCacheToState.
                  const isRed = aiTag === "RED";
                  const isYellow = aiTag === "YELLOW";

                  const colorClasses = isRed
                    ? "border-[#ef4444] bg-red-950/60 text-[#fca5a5]"
                    : isYellow
                      ? "border-yellow-500 bg-yellow-900/20 text-yellow-300"
                      : "border-emerald-500 bg-emerald-900/20 text-emerald-300";

                  const verdictLabel = isRed
                    ? "🚨 DANGER — DO NOT INTERACT"
                    : isYellow
                      ? "🟡 CAUTION"
                      : "🟢 SAFE";

                  return (
                    <div>
                      {trustScore >= 0 && (
                        <div className="flex justify-center mb-3">
                          <div
                            className={`flex items-center justify-center w-16 h-16 rounded-full bg-slate-900 border-4 ${
                              isRed
                                ? "border-red-500"
                                : isYellow
                                  ? "border-yellow-500"
                                  : "border-emerald-500"
                            }`}
                          >
                            <span
                              className={`text-2xl font-black ${
                                isRed
                                  ? "text-red-400"
                                  : isYellow
                                    ? "text-yellow-400"
                                    : "text-emerald-400"
                              }`}
                            >
                              {trustScore}
                            </span>
                          </div>
                        </div>
                      )}
                      <div
                        className={`mb-3 text-center font-black tracking-wide ${
                          isRed
                            ? "text-[#ef4444] text-xl animate-pulse"
                            : isYellow
                              ? "text-yellow-400 text-lg"
                              : "text-emerald-400 text-lg"
                        }`}
                      >
                        {verdictLabel}
                      </div>
                      <div
                        className={`p-5 rounded-lg text-sm leading-relaxed ${colorClasses} ${isRed ? "border-[3px]" : "border-2"}`}
                      >
                        {aiSummary || aiReport}
                      </div>
                    </div>
                  );
                })()}

              {!aiReport && (
                <div className="flex flex-col items-center justify-center h-full py-16">
                  <p className="text-sm text-slate-500 italic">
                    No AI scan data available yet. Enable Auto-Scan and visit a
                    page to see results.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-[450px] p-4 bg-slate-900 text-slate-100 font-sans">
      {/* Header section */}
      <div className="flex justify-between items-center border-b border-slate-700 pb-3 mb-4">
        <h1 className="text-xl font-bold tracking-wider text-cyan-400">
          SENTINEL
        </h1>
        <button
          onClick={handleAdminClick}
          className="bg-slate-800 hover:bg-slate-700 p-1.5 rounded text-xs font-semibold border border-slate-600 transition-colors"
        >
          Admin Lock
        </button>
      </div>

      {/* Trust Score section — driven by AI page analysis */}
      <div className="flex flex-col items-center justify-center bg-slate-800 rounded-lg p-6 mb-4 shadow-lg border border-slate-700">
        <div
          className={`relative flex items-center justify-center w-24 h-24 rounded-full bg-slate-900 border-4 ${
            trustScore < 0
              ? "border-slate-500 shadow-[0_0_15px_rgba(100,116,139,0.4)]"
              : trustScore >= 80
                ? "border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]"
                : trustScore >= 50
                  ? "border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.5)]"
                  : "border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]"
          }`}
        >
          {trustScore < 0 ? (
            <svg
              className="animate-spin h-8 w-8 text-slate-400"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          ) : (
            <span
              className={`text-3xl font-black ${
                trustScore >= 80
                  ? "text-emerald-400"
                  : trustScore >= 50
                    ? "text-yellow-400"
                    : "text-red-400"
              }`}
            >
              {trustScore}
            </span>
          )}
        </div>
        <p className="mt-3 text-sm font-medium text-slate-300">
          {trustScore < 0 ? "AI Scanning..." : "AI Trust Score"}
        </p>
        <p className="text-xs text-slate-500">
          {trustScore < 0
            ? "Analyzing page threats..."
            : isSecure
              ? "Connection is secure"
              : "Insecure connection detected"}
        </p>
      </div>

      {/* Toggles section */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1">
          Active Defenses
        </h2>

        {/* Toggle 1: Network Filtering */}
        <div className="flex justify-between items-center bg-slate-800 p-3 rounded-md border border-slate-700">
          <div>
            <p className="text-sm font-semibold">Network Filtering</p>
            <p className="text-xs text-slate-400">
              Blocks trackers, ads, and malware
            </p>
          </div>
          <button
            onClick={toggleNetworkFilter}
            className={`w-12 h-6 rounded-full transition-colors relative ${
              networkFilter ? "bg-cyan-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                networkFilter ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        {/* Toggle 2: Canvas Obfuscation */}
        <div className="flex justify-between items-center bg-slate-800 p-3 rounded-md border border-slate-700">
          <div>
            <p className="text-sm font-semibold">Canvas Obfuscation</p>
            <p className="text-xs text-slate-400">
              Injects noise to prevent fingerprinting
            </p>
          </div>
          <button
            onClick={toggleCanvasNoise}
            className={`w-12 h-6 rounded-full transition-colors relative ${
              canvasNoise ? "bg-cyan-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                canvasNoise ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        {/* Toggle 3: Location Spoofing */}
        <div className="flex justify-between items-center bg-slate-800 p-3 rounded-md border border-slate-700">
          <div>
            <p className="text-sm font-semibold">Location Spoofing</p>
            <p className="text-xs text-slate-400">
              Feeds fake coordinates to block geolocation
            </p>
          </div>
          <button
            onClick={toggleLocationSpoofing}
            className={`w-12 h-6 rounded-full transition-colors relative ${
              locationSpoofing ? "bg-cyan-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                locationSpoofing ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        {/* Toggle 4: Auto-Scan (AI) */}
        <div className="flex justify-between items-center bg-slate-800 p-3 rounded-md border border-slate-700">
          <div>
            <p className="text-sm font-semibold">Auto-Scan (AI)</p>
            <p className="text-xs text-slate-400">
              Evaluates page threat level silently
            </p>
          </div>
          <button
            onClick={toggleAutoAiScan}
            className={`w-12 h-6 rounded-full transition-colors relative ${
              autoAiScan ? "bg-cyan-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                autoAiScan ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Ad & Tracker Filtering */}
      <div className="flex flex-col gap-3 mt-4">
        <h2 className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1">
          Ad &amp; Tracker Filtering
        </h2>

        {/* Toggle: Standard Blocking */}
        <div className="flex justify-between items-center bg-slate-800 p-3 rounded-md border border-slate-700">
          <div>
            <p className="text-sm font-semibold">Standard Blocking</p>
            <p className="text-xs text-slate-400">
              Blocks 200+ ad networks, trackers &amp; popup domains
            </p>
          </div>
          <button
            onClick={toggleFilterStandard}
            className={`w-12 h-6 rounded-full transition-colors relative ${
              filterStandard ? "bg-cyan-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                filterStandard ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        {/* Toggle: Aggressive Blocking */}
        <div className="flex justify-between items-center bg-slate-800 p-3 rounded-md border border-amber-800/50">
          <div>
            <p className="text-sm font-semibold text-amber-300">
              Aggressive Blocking
            </p>
            <p className="text-xs text-slate-400">
              Blocks 500+ domains — may break some sites
            </p>
          </div>
          <button
            onClick={toggleFilterAggressive}
            className={`w-12 h-6 rounded-full transition-colors relative ${
              filterAggressive ? "bg-amber-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                filterAggressive ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>
      </div>

      {/* AI Report — shown when auto-scan has produced a result */}
      {aiReport && (
        <div className="mt-4">
          <button
            onClick={() => setView("ai-report")}
            className={`w-full font-bold py-2.5 rounded transition-colors text-sm ${
              trustScore > 0 && trustScore < 50
                ? "bg-amber-600 hover:bg-amber-500 text-white"
                : trustScore >= 0 && trustScore < 40
                  ? "bg-red-600 hover:bg-red-500 text-white"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white"
            }`}
          >
            📋 View AI Threat Report
          </button>
        </div>
      )}

      {/* Footer section */}
      <div className="mt-auto pt-4 text-center">
        <p className="text-[10px] text-slate-500">
          Sentinel v0.7.0 — Guardian Engine
        </p>
      </div>
    </div>
  );
}

export default App;
