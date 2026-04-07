/**
 * scripts/build-rules.js
 *
 * Pre-build script that downloads EasyList + EasyPrivacy filter lists,
 * extracts domain-based blocking rules, and converts them into a
 * Chrome declarativeNetRequest static ruleset JSON file.
 *
 * Zero external dependencies — uses only Node.js built-ins + native fetch.
 *
 * Output: public/rules_easylist.json
 * ID range: 100_000+  (avoids collision with all other static/dynamic rules)
 *
 * Usage:  node scripts/build-rules.js
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FILTER_LIST_URLS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
];

const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "rules_easylist.json",
);

const STARTING_ID = 100_000;

// Chrome allows up to 330 000 static rules across all rulesets.
// We already have ~500 in rules_standard + rules_aggressive.
// Cap the EasyList output to leave headroom.
const MAX_RULES = 30_000;

// All resource types we want to block (including main_frame — the fix that
// made our parental controls actually work).
const RESOURCE_TYPES = [
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
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Download a URL and return its text content.
 * Returns empty string on failure so the build never crashes.
 */
async function fetchText(url) {
  try {
    console.log(`  ↓ Downloading ${url} ...`);
    const res = await fetch(url, {
      headers: { "User-Agent": "SentinelExtension-BuildScript/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`  ⚠ HTTP ${res.status} for ${url} — skipping`);
      return "";
    }
    const text = await res.text();
    console.log(
      `  ✓ Got ${text.split("\n").length.toLocaleString()} lines from ${url}`,
    );
    return text;
  } catch (err) {
    console.warn(`  ⚠ Failed to fetch ${url}: ${err.message} — skipping`);
    return "";
  }
}

/**
 * Parse ABP filter text and extract clean domain strings from lines
 * that match the `||domain^` pattern (with optional trailing options).
 *
 * Skips:
 *  - Comments (! or [)
 *  - Exception / allow rules (@@)
 *  - Cosmetic filters (# selectors)
 *  - Complex URL-pattern filters (no || prefix)
 *  - Domains with wildcards (*)
 *  - IP addresses
 *  - Filters with element-hiding or redirect options
 */
function extractDomains(filterText) {
  const domains = new Set();

  // Matches:  ||some.domain.com^   or   ||some.domain.com^$third-party,script
  //                                      ||some.domain.com^$all
  // Group 1 captures the domain portion.
  const domainRe = /^\|\|([a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+)\^(\$.*)?$/;

  for (const raw of filterText.split("\n")) {
    const line = raw.trim();

    // Skip blanks, comments, metadata, exceptions, cosmetic filters
    if (!line) continue;
    if (line.startsWith("!")) continue;
    if (line.startsWith("[")) continue;
    if (line.startsWith("@@")) continue;
    if (line.includes("##") || line.includes("#@#") || line.includes("#?#"))
      continue;

    const match = line.match(domainRe);
    if (!match) continue;

    const domain = match[1].toLowerCase();

    // Skip wildcard domains, IP addresses, and single-label domains
    if (domain.includes("*")) continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) continue;
    if (!domain.includes(".")) continue;

    // Skip overly broad TLDs that would break the internet
    if (domain.split(".").length <= 1) continue;

    domains.add(domain);
  }

  return domains;
}

/**
 * Convert a Set of domain strings into an array of
 * chrome.declarativeNetRequest.Rule objects.
 */
function buildDNRRules(domains) {
  const sorted = [...domains].sort();
  const rules = [];
  let id = STARTING_ID;

  for (const domain of sorted) {
    if (rules.length >= MAX_RULES) break;

    rules.push({
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: [domain],
        resourceTypes: RESOURCE_TYPES,
      },
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n🛡️  Sentinel — Building EasyList + EasyPrivacy ruleset\n");

  // 1. Download filter lists
  const texts = await Promise.all(FILTER_LIST_URLS.map(fetchText));
  const combined = texts.join("\n");

  if (!combined.trim()) {
    console.warn(
      "\n⚠ No filter list data received. Writing empty ruleset so the build doesn't break.\n",
    );
    ensureDir(OUTPUT_PATH);
    writeFileSync(OUTPUT_PATH, "[]", "utf-8");
    console.log(`  → Wrote empty [] to ${OUTPUT_PATH}\n`);
    return;
  }

  // 2. Extract domains
  console.log("\n  ⚙ Parsing domain-based rules...");
  const domains = extractDomains(combined);
  console.log(
    `  ✓ Extracted ${domains.size.toLocaleString()} unique domains`,
  );

  // 3. Convert to DNR rules
  const rules = buildDNRRules(domains);
  console.log(
    `  ✓ Generated ${rules.length.toLocaleString()} DNR rules (IDs ${STARTING_ID}–${STARTING_ID + rules.length - 1})`,
  );

  // 4. Write output
  ensureDir(OUTPUT_PATH);
  writeFileSync(OUTPUT_PATH, JSON.stringify(rules, null, 2), "utf-8");

  const sizeMB = (Buffer.byteLength(JSON.stringify(rules)) / 1_048_576).toFixed(
    1,
  );
  console.log(`  → Wrote ${sizeMB} MB to ${OUTPUT_PATH}\n`);
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

main().catch((err) => {
  console.error("\n❌ build-rules.js failed:", err);
  // Write empty ruleset so vite build doesn't break
  try {
    ensureDir(OUTPUT_PATH);
    writeFileSync(OUTPUT_PATH, "[]", "utf-8");
    console.log("  → Wrote empty fallback ruleset\n");
  } catch {
    // nothing we can do
  }
  process.exit(0); // Don't fail the build — the extension works without this ruleset
});
