<div align="center">
  <h1>Bruuhim's Seanime Extensions</h1>
  <p>A collection of extensions and manga providers for Seanime.</p>

  <a href="https://github.com/5rahim/seanime">
    <img src="https://img.shields.io/badge/Powered%20by-Seanime-blue?style=for-the-badge&logo=github" alt="Powered by Seanime">
  </a>
  <img src="https://img.shields.io/badge/Version-1.0.0-gold?style=for-the-badge" alt="Version">
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
- **Media Recommendation Recovery**: Leverages nekoBT search metadata to find media IDs when text queries yield no direct results.
- **Search Waterfall**: Sequentially attempts primary queries, media recommendation pivots, and alternative title variants.
- **Robust Ranking**: Orders results based on seeders, resolution proximity, and episode matching.

<br />

## Manga Providers

Manga providers utilizing AJAX fallbacks and Cloudflare bypass logic.

| Provider                  | Description                            | Installation Manifest (URL)                                                                                              |
| :------------------------ | :------------------------------------- | :------------------------------------------------ :--------------------------------------------------------------------- |
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

Adds a "Watch on Seanime" button to the MyAnimeList sidebar.

<p align="center">
  <img src="assets/screenshot-after.png" width="800" alt="MAL Button Preview">
</p>

<br />

## Installation Guide

1. Copy the manifest URL for the desired provider.
2. Open the Seanime dashboard.
3. Navigate to **Settings** > **Extensions**.
4. Paste the URL into the **External Manifest URL** field.
5. Click **Install**.

<br />

## Testing

1. **Seanime Playground**: Load the manifest and test `search()` or `smartSearch()`.
2. **Fallback Verification**: Test with titles such as `STEEL BALL RUN` to verify media ID recommendation recovery.
3. **Smart Search**: Verify that batch and episode number filters are correctly applied to results.

## Technical Details

- **Media Discovery**: Treatment of initial queries as discovery steps. If results are absent but `recommended_media` is present, the provider pivots to a `media_id` search.
- **Waterfall Search**: Primary query -> Media ID Recovery -> Alt Titles -> Episode Variants -> Broad Fallback.
- **Type Safety**: Results are processed through a strictly-typed mapping pipeline to prevent runtime errors.

---

<div align="center">
  Made for the Seanime Community.
</div>
