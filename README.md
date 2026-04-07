# 🛡️ Sentinel — Web Security & Content Filtering Extension

A privacy-focused Chrome extension (Manifest V3) that provides real-time website safety analysis, ad/tracker blocking, fingerprint protection, and parental controls — all running locally on your device.

Built as a Senior Capstone Project at the University of Toledo.

## Features

### AI Trust Score
Uses Chrome's on-device AI (Prompt API) to analyze page content and assign a safety score from 0–100. The score is displayed in both a toast notification and the popup panel, giving users a quick read on whether a site is safe, suspicious, or dangerous.

### Network Filtering
Blocks malicious domains, ad networks, and tracking scripts using Chrome's `declarativeNetRequest` API. Includes three tiers:
- **Standard** — 200+ known ad networks, trackers, and popup domains
- **Aggressive** — 500+ domains (may break some sites)
- **EasyList** — 30,000+ domains compiled from EasyList and EasyPrivacy filter lists

### Cosmetic Filtering
Injects CSS to hide ad containers, popup overlays, cookie banners, newsletter modals, and scam elements before they paint. Also includes scriptlet neutralizations for anti-adblock detection and push notification spam.

### Canvas Obfuscation
Hooks `HTMLCanvasElement` methods to inject subtle noise into canvas fingerprinting attempts, making your browser harder to uniquely identify across sites.

### Location Spoofing
Feeds fake coordinates to the Geolocation API, preventing sites from accessing your real location.

### Ad Defense
Blocks cross-origin popups by overriding `window.open`, and strips invisible click-trap overlays (transparent full-screen links, iframes, and divs) that hijack user clicks.

### Parental Controls
PIN-protected admin dashboard with tiered content filtering:
- **Child / Teen / Adult** age tiers with automatic domain blocking
- Custom domain block and allow lists
- SHA-256 hashed PIN for secure access

### Admin Dashboard
Accessible via a 4-digit PIN, the dashboard provides:
- **Dashboard** — Stats overview (total events, blocked domains, status)
- **Domains** — Add/remove blocked and whitelisted domains
- **Logs** — View blocked request history with timestamps and URLs
- **Settings** — Feature toggles, parental controls, and data export

## Tech Stack

- **Chrome Manifest V3**
- **React** + **TypeScript** for the popup UI
- **Tailwind CSS** for styling
- **Vite** for building
- **Chrome APIs** — `declarativeNetRequest`, `storage`, `scripting`, `tabs`
- **Chrome Prompt API** — On-device AI for page analysis

## Getting Started

### Prerequisites
- Node.js 18+
- Chrome 128+ (for on-device AI features)

### Install & Build

```bash
git clone https://github.com/joshuamlpereira/sentinel-extension.git
cd sentinel-extension
npm install
npm run build
```

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

### Enable On-Device AI (Optional)

The AI Trust Score requires Chrome's built-in Prompt API:
1. Go to `chrome://flags/#optimization-guide-on-device-model`
2. Set to **Enabled**
3. Go to `chrome://flags/#prompt-api-for-gemini-nano`
4. Set to **Enabled**
5. Restart Chrome

## Project Structure

```
sentinel-extension/
├── src/
│   ├── App.tsx          # Popup UI (React)
│   ├── content.ts       # Content script (MAIN world) — AI scan, ad defense, canvas hooks
│   ├── cosmetic.ts      # Content script (ISOLATED world) — CSS cosmetic filters
│   └── background.ts    # Service worker — network filtering, rule management
├── scripts/
│   └── build-rules.js   # Downloads EasyList/EasyPrivacy and compiles DNR rules
├── public/
│   ├── rules_standard.json    # 200+ ad/tracker domain rules
│   ├── rules_aggressive.json  # 500+ domain rules
│   └── rules_easylist.json    # 30,000 domains from EasyList/EasyPrivacy
└── dist/                # Built extension (load this in Chrome)
```

## Team

- **Joshua Pereira**
- **John Best**
- **Aaron Samuel**
- **Bryant Geer**
- **Nonso Nwogu**

Faculty Advisor: **Professor Weiqing Sun**

## License

This project was developed as part of ENGT 4050 — Senior Technology Capstone at the University of Toledo.
