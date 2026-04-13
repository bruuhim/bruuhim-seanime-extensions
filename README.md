<div align="center">
  <h1>Bruuhim's Seanime Extensions</h1>
  <p>A collection of extensions and manga providers for Seanime.</p>

  <a href="https://github.com/5rahim/seanime">
    <img src="https://img.shields.io/badge/Powered%20by-Seanime-blue?style=for-the-badge&logo=github" alt="Powered by Seanime">
  </a>
  <img src="https://img.shields.io/badge/Language-Arabic/English-green?style=for-the-badge" alt="Language">
</div>

<hr />

## Table of Contents

- [Torrent Providers](#torrent-providers)
- [Manga Providers](#manga-providers)
- [Featured Extensions](#featured-extensions)
- [Installation Guide](#installation-guide)
- [Technical Details](#technical-details)

<hr />

## Torrent Providers

| Provider                  | Description                            | Installation Manifest (URL)                                                                                              |
| :------------------------ | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| **nekoBT**                | Public nekoBT torrent provider.        | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/anime-torrent-providers/nekobt/nekobt.json`     |

### nekoBT Highlights
- **Media ID Discovery**: Uses nekoBT's internal `recommended_media` and `similar_media` signals to find the correct media ID when literal text search yields no torrents.
- **Search Recovery**: Automatically pivots to a `media_id`-driven search if the initial query returns empty but suggests a media match.
- **Smart Fallback**: Utilizes layered strategies including title cleanup, synonym retry, and episode formatting variants.

<br />

## Manga Providers

These providers feature AJAX fallbacks and Cloudflare bypass logic.

| Provider                  | Description                            | Installation Manifest (URL)                                                                                              |
| :------------------------ | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| **3asq (Arabic)**         | Arabic manga from 3asq.org             | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/manga-providers/3asq/3asq.json`               |
| **AzoraMoon (Arabic)**    | Arabic manga from azoramoon.com        | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/manga-providers/azoramoon/azoramoon.json`     |
| **OlympusStaff (Arabic)** | Arabic manga from olympustaff.com      | `https://raw.githubusercontent.com/bruuhim/bruuhim-seanime-extensions/main/manga-providers/olympustaff/olympustaff.json` |

<br />

## Featured Extensions

### [Open-in-Seanime](https://github.com/bruuhim/Open-in-Seanime)

Adds a link to media on MyAnimeList and AniList.

<div align="center">
  <img src="assets/preview-mal.png" width="400" alt="Open in Seanime MAL">
  <img src="assets/preview-anilist.png" width="400" alt="Open in Seanime AniList">
</div>

### [MAL-Button-Seanime](https://github.com/bruuhim/MAL-Button-Seanime)

Adds a "Watch on Seanime" button into the MyAnimeList sidebar.

<p align="center">
  <img src="assets/screenshot-after.png" width="800" alt="MAL Button Preview">
</p>

<br />

## Installation Guide

1. Copy the manifest URL for the provider you want.
2. Open your Seanime dashboard.
3. Navigate to **Settings** > **Extensions**.
4. In the **External Manifest URL** field, paste the link.
5. Click **Install**.

<br />

## Testing

1. **Seanime Playground**: Load the manifest and test `search()` with titles like "STEEL BALL RUN".
2. **Logs**: Check console for `nekoBT: Found media recommendation ID` or `nekoBT: Media ID search returned` to verify the recovery path.
3. **Smart Search**: Verify that episode and batch toggles correctly affect the ranked results.

## Technical Details

- **Media Recommendation Flow**: The provider treats initial text queries as discovery steps. If no torrents are found but `recommended_media` is returned, it performs a follow-up search using the discovered `media_id`.
- **Waterfall Search**: Tries exact title, cleaned title, synonyms, and episode variants sequentially.
- **Dynamic Ranking**: Results are ranked by seeders, with weight bonuses for resolution and episode matching.
- **Dual-Method Chapter Extraction**: (Manga) Combines Static Site Rendering (SSR) and AJAX calls.
- **Dynamic Header Spoofing**: Built-in User-Agent rotation and Referer management.

---

<div align="center">
  Made for the Seanime Community.
</div>
