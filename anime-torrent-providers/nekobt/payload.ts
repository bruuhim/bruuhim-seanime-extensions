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
            const url = `${this.getApiUrl()}/torrents/search?sort_by=latest&limit=50`
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
            return this.executeSearchWaterfall(opts.media, opts.query, undefined, false, undefined)
        } catch (error) {
            console.error("nekoBT: Error in search: " + (error as Error).message)
            return []
        }
    }

    public async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const isBatch = !!opts.batch
            const epNum = isBatch ? undefined : opts.episodeNumber
            
            console.log(`nekoBT: Smart searching (batch: ${isBatch}, ep: ${epNum})...`)
            let results = await this.executeSearchWaterfall(opts.media, opts.query, opts.resolution, isBatch, epNum)

            if (isBatch) {
                results = results.map(t => {
                    t.isBatch = true
                    return t
                })
            } else if (epNum && epNum > 0) {
                results = this.filterByEpisode(results, epNum)
            }

            return results
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
    // Search Strategies
    //+ --------------------------------------------------------------------------------------------------

    private async executeSearchWaterfall(
        media: Media, 
        customQuery?: string, 
        resolution?: string, 
        isBatch?: boolean, 
        episodeNumber?: number
    ): Promise<AnimeTorrent[]> {
        
        const strategies = this.buildSearchStrategies(media, customQuery)
        
        // Append resolution ONLY to the first strategy
        if (strategies.length > 0 && resolution) {
            strategies[0] = `${strategies[0]} ${resolution}`
        }

        const baseUrl = this.getApiUrl()
        const batchParam = isBatch ? "&batch=true" : ""

        for (let i = 0; i < strategies.length; i++) {
            const query = strategies[i]
            if (!query) continue

            const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50${batchParam}`
            
            try {
                const torrents = await this.fetchTorrents(url)
                if (torrents.length > 0) {
                    console.log(`nekoBT: strategy ${i + 1} succeeded with query: ${query}`)
                    return torrents.map(t => this.toAnimeTorrent(t))
                }
            } catch (err) {
                console.warn(`nekoBT: strategy ${i + 1} failed for query ${query}: ${(err as Error).message}`)
            }
        }

        const original = customQuery || media.romajiTitle || media.englishTitle || "unknown"
        console.warn(`nekoBT: all strategies exhausted for: ${original}`)
        return []
    }

    private buildSearchStrategies(media: Media, customQuery?: string): string[] {
        const queries: string[] = []
        const baseTitle = customQuery || media.romajiTitle || media.englishTitle || ""

        if (!baseTitle) return queries

        // Strategy 1: Full sanitized title
        queries.push(this.sanitizeTitle(baseTitle))

        // Strategy 2: Subtitle only (everything after last colon)
        if (baseTitle.includes(":")) {
            const parts = baseTitle.split(":")
            queries.push(this.sanitizeTitle(parts[parts.length - 1]))
        }

        // Strategy 3: First 3 meaningful words (skip particles/articles)
        const words = this.sanitizeTitle(baseTitle).split(/\s+/)
        const stopWords = new Set(["no", "na", "wa", "ga", "wo", "the", "a", "an"])
        const meaningful = words.filter(w => !stopWords.has(w.toLowerCase()))
        
        if (meaningful.length >= 3) {
            queries.push(meaningful.slice(0, 3).join(" "))
        } else if (meaningful.length > 0) {
            queries.push(meaningful.join(" "))
        }

        // Strategy 4: English synonyms (ASCII only)
        if (media && media.synonyms) {
            for (const syn of media.synonyms) {
                // Ensure the synonym contains only ASCII characters to avoid breaking searches
                if (/^[\x00-\x7F]*$/.test(syn)) {
                    queries.push(this.sanitizeTitle(syn))
                }
            }
        }

        // Strategy 5: English title
        if (media && media.englishTitle) {
            queries.push(this.sanitizeTitle(media.englishTitle))
        }

        // Deduplicate and remove empty
        const uniqueQueries = [...new Set(queries.filter(q => q.trim().length > 0))]
        return uniqueQueries
    }

    private filterByEpisode(results: AnimeTorrent[], epNum: number): AnimeTorrent[] {
        const epStr = String(epNum)
        const regex = new RegExp(`(\\D|^)0*${epStr}(\\D|$)`, "i")
        
        const filtered = results.filter(t => {
            if (t.isBatch) return false
            return regex.test(t.name)
        })

        // If filtered set is empty, return the unfiltered set 
        return filtered.length > 0 ? filtered : results
    }

    //+ --------------------------------------------------------------------------------------------------
    // Core fetch
    //+ --------------------------------------------------------------------------------------------------

    private async fetchTorrents(url: string): Promise<NekoBTTorrent[]> {
        console.log(`nekoBT: Fetching from ${url}`)
        
        // No custom headers (no API key auth required)
        const res = await fetch(url)

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

    private getApiUrl(): string {
        let url = $getUserPreference("apiUrl") || this.defaultApiUrl
        return url.endsWith("/") ? url.slice(0, -1) : url
    }

    private sanitizeTitle(title: string): string {
        return title
            .replace(/[：:「」【】『』（）()[\]{}]/g, " ")
            .replace(/[^\w\s\-']/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }
}