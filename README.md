<div align="center">
  <h1>🚀 Bruuhim's Seanime Extensions</h1>
  <p>A collection of high-quality extensions and manga providers for the <b>Seanime</b> universe.</p>

  <a href="https://github.com/5rahim/seanime">
    <img src="https://img.shields.io/badge/Powered%20by-Seanime-blue?style=for-the-badge&logo=github" alt="Powered by Seanime">
  </a>
  <img src="https://img.shields.io/badge/Version-1.1.0-gold?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Language-Arabic/English-green?style=for-the-badge" alt="Language">
</div>

<hr />

## 📖 Table of Contents

- [Torrent Providers](#-torrent-providers)
- [Manga Providers](#-manga-providers)
- [Featured Extensions](#-featured-extensions)
- [Installation Guide](#-installation-guide)
- [Technical Details](#-technical-details)

<hr />

## ⚡ Torrent Providers

| Provider                  | Description                            | Installation Manifest (URL)                                                                                              |
| :------------------------ | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| **nekoBT (Public)**       | Robust, no-auth nekoBT provider.      | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/anime-torrent-providers/nekobt/nekobt.json`     |

### nekoBT Highlights
- **Zero Setup**: No API key or account required. Works out of the box.
- **Smart Fallback**: Layered search strategies (Exact -> Alt Titles -> Broad) to minimize empty results.
- **Reliable Extraction**: Advanced client-side filtering for episode matching.

<br />

## 🔌 Manga Providers

These providers are optimized for stability, featuring AJAX fallbacks and Cloudflare bypass logic.

| Provider                  | Description                            | Installation Manifest (URL)                                                                                              |
| :------------------------ | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| **3asq (Arabic)**         | Premium Arabic manga from 3asq.org     | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/manga-providers/3asq/3asq.json`               |
| **AzoraMoon (Arabic)**    | Fast Arabic manga from azoramoon.com   | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/manga-providers/azoramoon/azoramoon.json`     |
| **OlympusStaff (Arabic)** | Extensive library from olympustaff.com | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/manga-providers/olympustaff/olympustaff.json` |

<br />

## 🧩 Featured Extensions

### [Open-in-Seanime](https://github.com/bruuhim/Open-in-Seanime)

Bridge your anime discovery with your local server. Adds a clean link to media on MyAnimeList and AniList.

<div align="center">
  <img src="assets/preview-mal.png" width="400" alt="Open in Seanime MAL">
  <img src="assets/preview-anilist.png" width="400" alt="Open in Seanime AniList">
</div>

### [MAL-Button-Seanime](https://github.com/bruuhim/MAL-Button-Seanime)

Seamlessly adds a native-feeling "Watch on Seanime" button directly into the MyAnimeList sidebar.

<p align="center">
  <img src="assets/screenshot-after.png" width="800" alt="MAL Button Preview">
</p>

<br />

## 🛠 Installation Guide

1. **Copy** the manifest URL for the provider you want.
2. Open your **Seanime** dashboard.
3. Navigate to **Settings** > **Extensions**.
4. In the **External Manifest URL** field, paste the link.
5. Click **Install**.

<br />

## ⚙️ Configuration

- **nekoBT**: No configuration required. 
- **Manga Providers**: Generally no configuration required unless specified.

## ⚙️ Technical Details

- **Multi-Strategy Waterfall**: (Torrent) Tries up to 10+ query variants per smart search to ensure matches.
- **Dual-Method Chapter Extraction**: (Manga) Combines Static Site Rendering (SSR) and AJAX calls for 99% reliability.
- **Dynamic Header Spoofing**: Built-in User-Agent rotation and Referer management.

---

<div align="center">
  Made with ❤️ for the Seanime Community.
</div>
