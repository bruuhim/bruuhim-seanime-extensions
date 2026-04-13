/// <reference path="../../typing/anime-torrent-provider.d.ts" />
/// <reference path="../../typing/core.d.ts" />

interface NekoBTTorrent {
    id: string
    uploaded_at: string
    title: string
    infohash: string
    magnet: string
    private_magnet: string | null
    media_id: string
    description?: string | null
    filesize: string
    category?: number
    level: number
    otl: boolean
    hardsub: boolean
    mtl: boolean
    audio_lang: string
    sub_lang: string
    fsub_lang: string
    video_codec: number
    video_type: number
    seeders: string
    leechers: string
    completed: string
    groups: NekoBTGroup[]
    batch: boolean
    imported: string | null
    nyaa_upload_time: string | null
    deleted?: null
    hidden?: boolean
    waiting_approve?: boolean
    comment_count?: string
    anonymous?: boolean
    upgraded?: null
    auto_title?: string
    uploader?: {
        id: string
        display_name: string
        username: string
        pfp_hash: string | null
    } | null
}

interface NekoBTGroup {
    id: string
    display_name: string
    name: string
    uploading_group: boolean
}

interface NekoBTSearchResponse {
    error: boolean
    message?: string
    data?: {
        results: NekoBTTorrent[]
        more?: boolean
        recommended_media?: unknown
        similar_media?: unknown[]
        infohash_match?: string | null
    }
}

class Provider {

    private defaultApiUrl = "https://nekobt.to/api/v1"

    public getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
        }
    }

    public async getLatest(): Promise<AnimeTorrent[]> {
        try {
            console.log("nekoBT: Fetching latest torrents")
            const apiKey = $getUserPreference("apiKey") || ""
            if (!apiKey) {
                console.error("nekoBT: API key is missing. Please set your API key in extension settings.")
                return []
            }

            const baseUrl = this.getApiUrl()
            const url = `${baseUrl}/torrents/search?sort_by=latest&limit=50`
            const torrents = await this.fetchTorrents(url)
            return torrents.map(t => this.toAnimeTorrent(t))
        } catch (error) {
            console.error("nekoBT: Error fetching latest: " + (error as Error).message)
            return []
        }
    }

    public async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            console.log(`nekoBT: Searching for "${opts.query}"`)
            const apiKey = $getUserPreference("apiKey") || ""
            if (!apiKey) {
                console.error("nekoBT: API key is missing. Please set your API key in extension settings.")
                return []
            }

            const query = this.sanitizeTitle(opts.query)
            const baseUrl = this.getApiUrl()
            const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50`
            const torrents = await this.fetchTorrents(url)
            return torrents.map(t => this.toAnimeTorrent(t))
        } catch (error) {
            console.error("nekoBT: Error in search: " + (error as Error).message)
            return []
        }
    }

    public async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const apiKey = $getUserPreference("apiKey") || ""
            if (!apiKey) {
                console.error("nekoBT: API key is missing. Please set your API key in extension settings.")
                return []
            }

            if (opts.batch) {
                console.log("nekoBT: Smart searching for batches...")
                return this.smartSearchBatch(opts)
            }

            console.log(`nekoBT: Smart searching for episode ${opts.episodeNumber}...`)
            return this.smartSearchEpisode(opts)
        } catch (error) {
            console.error("nekoBT: Error in smart search: " + (error as Error).message)
            return []
        }
    }

    public async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    public async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    //+ --------------------------------------------------------------------------------------------------
    // Smart search helpers
    //+ --------------------------------------------------------------------------------------------------

    private async smartSearchBatch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const baseUrl = this.getApiUrl()
        const titles = this.getAllTitles(opts.media)
        const baseQuery = this.buildBaseQuery(titles, opts.resolution)

        const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(baseQuery)}&batch=true&sort_by=best&limit=50`

        console.log(`nekoBT: Batch search query: "${baseQuery}"`)

        const torrents = await this.fetchTorrents(url)
        return torrents.map(t => {
            const at = this.toAnimeTorrent(t)
            at.isBatch = true
            at.confirmed = false
            return at
        })
    }

    private async smartSearchEpisode(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const baseUrl = this.getApiUrl()
        const titles = this.getAllTitles(opts.media)
        let baseQuery = this.buildBaseQuery(titles, opts.resolution)

        // Append episode number hint so nekoBT's semantic search can narrow results
        if (opts.episodeNumber && opts.episodeNumber > 0) {
            const epPadded = String(opts.episodeNumber).padStart(2, "0")
            baseQuery += ` ${epPadded}`
        }

        // Append custom user query if provided
        if (opts.query) {
            baseQuery = this.sanitizeTitle(opts.query)
            if (opts.resolution) {
                baseQuery += ` ${opts.resolution}`
            }
            if (opts.episodeNumber && opts.episodeNumber > 0) {
                const epPadded = String(opts.episodeNumber).padStart(2, "0")
                baseQuery += ` ${epPadded}`
            }
        }

        console.log(`nekoBT: Episode search query: "${baseQuery}"`)

        const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(baseQuery)}&sort_by=best&limit=50`
        const torrents = await this.fetchTorrents(url)

        let results = torrents.map(t => this.toAnimeTorrent(t))

        // Client-side filter: keep only results that likely match the episode number
        if (opts.episodeNumber && opts.episodeNumber > 0) {
            const epStr = String(opts.episodeNumber)
            const epPadded = String(opts.episodeNumber).padStart(2, "0")
            const filtered = results.filter(t => {
                if (t.isBatch) return false
                const name = t.name.toLowerCase()
                // Match patterns like E01, EP01, - 01, _01, [01]
                const patterns = [
                    new RegExp(`\\bE0*${epStr}\\b`, "i"),
                    new RegExp(`\\bEP0*${epStr}\\b`, "i"),
                    new RegExp(`[-_\\[\\s]0*${epPadded}[\\]\\s_\\-v]`, "i"),
                    new RegExp(`[-_\\[\\s]0*${epStr}[\\]\\s_\\-v]`, "i"),
                ]
                return patterns.some(p => p.test(name))
            })
            // Only apply filter if we got some matches — otherwise fall back to raw results
            if (filtered.length > 0) {
                results = filtered
            }
        }

        return results
    }

    //+ --------------------------------------------------------------------------------------------------
    // Core fetch
    //+ --------------------------------------------------------------------------------------------------

    private async fetchTorrents(url: string): Promise<NekoBTTorrent[]> {
        console.log(`nekoBT: Fetching from ${url}`)

        const res = await fetch(url, {
            headers: this.getHeaders(),
        })

        if (!res.ok) {
            throw new Error(`nekoBT: HTTP ${res.status} ${res.statusText}`)
        }

        const json = await res.json() as NekoBTSearchResponse

        if (json.error) {
            throw new Error(`nekoBT: API error — ${json.message || "unknown error"}`)
        }

        return json.data?.results ?? []
    }

    //+ --------------------------------------------------------------------------------------------------
    // Mapping
    //+ --------------------------------------------------------------------------------------------------

    private toAnimeTorrent(t: NekoBTTorrent): AnimeTorrent {
        // uploaded_at is a Unix timestamp in milliseconds (as a string)
        const date = new Date(parseInt(t.uploaded_at, 10)).toISOString()

        const seeders = parseInt(t.seeders, 10) || 0
        const leechers = parseInt(t.leechers, 10) || 0
        const downloadCount = parseInt(t.completed, 10) || 0
        const size = parseInt(t.filesize, 10) || 0

        const releaseGroup = t.groups && t.groups.length > 0
            ? t.groups[0].display_name
            : ""

        return {
            name: t.title,
            date: date,
            size: size,
            formattedSize: "",
            seeders: seeders,
            leechers: leechers,
            downloadCount: downloadCount,
            link: `https://nekobt.to/torrents/${t.id}`,
            downloadUrl: undefined,
            magnetLink: t.magnet || undefined,
            infoHash: t.infohash || undefined,
            resolution: "",
            isBatch: t.batch,
            episodeNumber: -1,
            releaseGroup: releaseGroup,
            isBestRelease: false,
            confirmed: false,
        }
    }

    //+ --------------------------------------------------------------------------------------------------
    // Utilities
    //+ --------------------------------------------------------------------------------------------------

    private getHeaders(): Record<string, string> {
        const apiKey = $getUserPreference("apiKey") || ""
        return apiKey ? { "Cookie": `ssid=${apiKey}` } : {}
    }

    private getApiUrl(): string {
        let url = $getUserPreference("apiUrl") || this.defaultApiUrl
        return url.endsWith("/") ? url.slice(0, -1) : url
    }

    private sanitizeTitle(title: string): string {
        // Trim whitespace
        title = title.trim()

        // Normalize season suffixes to a simpler form the search engine can use
        // e.g. "2nd Season" → "Season 2", "Part 2" → preserved
        title = title.replace(/(\d+)(?:st|nd|rd|th)\s+season/gi, "Season $1")

        // Remove characters that commonly confuse search: colons, commas, apostrophes, quotes
        title = title.replace(/['"]/g, "")       // Remove quotes/apostrophes
        title = title.replace(/:/g, " ")          // Replace colons with space
        title = title.replace(/,/g, " ")          // Replace commas with space
        title = title.replace(/[!?]/g, "")        // Remove ! ?
        title = title.replace(/[^\w\s\-\.]/g, " ")// Remove remaining special chars

        // Collapse multiple spaces
        title = title.replace(/\s+/g, " ").trim()

        return title
    }

    private getAllTitles(media: AnimeSmartSearchOptions["media"]): string[] {
        return [
            media.romajiTitle,
            media.englishTitle,
            ...(media.synonyms || []),
        ].filter(Boolean) as string[]
    }

    private buildBaseQuery(titles: string[], resolution?: string): string {
        // Use the shortest clean title as the primary query to maximize recall
        const sanitized = titles
            .map(t => this.sanitizeTitle(t))
            .filter(t => t.length > 0)

        // Prefer the shortest non-trivial title (gives broadest results)
        const primary = sanitized.reduce((shortest, curr) =>
            curr.length < shortest.length && curr.length >= 3 ? curr : shortest,
            sanitized[0] || ""
        )

        let query = primary

        if (resolution) {
            query += ` ${resolution}`
        }

        return query.trim()
    }
}
