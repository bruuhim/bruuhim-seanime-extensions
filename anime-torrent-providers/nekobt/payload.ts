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
            
            // Waterfall will return deduped AnimeTorrent[]
            let results = await this.executeSearchWaterfall(opts.media, opts.query, opts.resolution, isBatch, epNum)

            // Post-search filtering for episode numbers
            if (!isBatch && epNum && epNum > 0) {
                const filtered = this.filterByEpisode(results, epNum)
                // If filter wipes everything, return original set (better to show more than nothing)
                if (filtered.length > 0) {
                    results = filtered
                }
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
    // Search Waterfall Logic
    //+ --------------------------------------------------------------------------------------------------

    private async executeSearchWaterfall(
        media: Media, 
        customQuery?: string, 
        resolution?: string, 
        isBatch?: boolean, 
        episodeNumber?: number
    ): Promise<AnimeTorrent[]> {
        
        const allResultsMap = new Map<string, AnimeTorrent>()
        const baseUrl = this.getApiUrl()
        const batchParam = isBatch ? "&batch=true" : ""

        // Strategy A: Refined/Custom Title
        const primaryTitle = customQuery || media.romajiTitle || media.englishTitle || ""
        const primaryStrategies = this.buildStrategySet(primaryTitle, episodeNumber, resolution)
        
        for (const query of primaryStrategies) {
            const results = await this.tryQuery(query, baseUrl, batchParam)
            if (results.length > 0) {
                console.log(`nekoBT: Strategy A (Primary) succeeded with query: ${query}`)
                this.mergeResults(allResultsMap, results, media, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap) // Return early for primary success
            }
        }

        // Strategy B: Alternative Titles & Synonyms
        const altTitles = [media.romajiTitle, media.englishTitle, ...(media.synonyms || [])]
            .filter(t => t && t !== primaryTitle)
            .filter((v, i, a) => a.indexOf(v) === i) as string[]

        for (const title of altTitles) {
            const strategies = this.buildStrategySet(title, episodeNumber, undefined) // Drop resolution for fallback
            for (const query of strategies) {
                const results = await this.tryQuery(query, baseUrl, batchParam)
                if (results.length > 0) {
                    console.log(`nekoBT: Strategy B (Alternative) succeeded with query: ${query}`)
                    this.mergeResults(allResultsMap, results, media, isBatch, episodeNumber, resolution)
                }
            }
            if (allResultsMap.size > 0) return this.finalizeResults(allResultsMap)
        }

        // Strategy C: Broad Title Fallback
        const broadTitle = this.sanitizeTitle(primaryTitle).split(" ").slice(0, 3).join(" ")
        if (broadTitle && broadTitle.length > 3) {
            const results = await this.tryQuery(broadTitle, baseUrl, batchParam)
            if (results.length > 0) {
                console.log(`nekoBT: Strategy C (Broad) succeeded with query: ${broadTitle}`)
                this.mergeResults(allResultsMap, results, media, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        console.warn(`nekoBT: All strategies exhausted for: ${primaryTitle}`)
        return []
    }

    private buildStrategySet(title: string, epNum?: number, res?: string): string[] {
        const base = this.sanitizeTitle(title)
        if (!base) return []

        const strategies: string[] = []
        const epSuffix = epNum && epNum > 0 ? ` ${epNum}` : ""
        const resSuffix = res ? ` ${res}` : ""

        // Standard
        strategies.push(`${base}${epSuffix}${resSuffix}`.trim())
        
        // Zero-padded episode
        if (epNum && epNum > 0) {
            const paddedEp = String(epNum).padStart(2, "0")
            strategies.push(`${base} ${paddedEp}${resSuffix}`.trim())
            strategies.push(`${base} E${paddedEp}${resSuffix}`.trim())
        }

        return [...new Set(strategies)]
    }

    private async tryQuery(query: string, baseUrl: string, batchParam: string): Promise<AnimeTorrent[]> {
        const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50${batchParam}`
        try {
            const torrents = await this.fetchTorrents(url)
            return torrents.map(t => this.toAnimeTorrent(t))
        } catch (e) {
            return []
        }
    }

    private mergeResults(
        map: Map<string, AnimeTorrent>, 
        newResults: AnimeTorrent[],
        media: Media,
        isBatch?: boolean,
        epNum?: number,
        res?: string
    ) {
        for (const r of newResults) {
            if (map.has(r.infoHash)) {
                // Keep the one with better metadata or more seeders if already present
                const existing = map.get(r.infoHash)!
                if (r.seeders > existing.seeders) map.set(r.infoHash, r)
                continue
            }
            
            // Initial Ranking Weights
            let score = r.seeders
            const titleLower = r.name.toLowerCase()
            
            // Bonus for resolution match
            if (res && titleLower.includes(res.toLowerCase())) score += 1000
            
            // Bonus for episode match
            if (epNum && epNum > 0) {
                const epStr = String(epNum)
                const paddedEp = epStr.padStart(2, "0")
                if (titleLower.includes(`e${epStr}`) || titleLower.includes(`ep${epStr}`) || titleLower.includes(` ${epStr} `) ||
                    titleLower.includes(`e${paddedEp}`) || titleLower.includes(`ep${paddedEp}`) || titleLower.includes(` ${paddedEp} `)) {
                    score += 500
                }
            }

            // Penalty for batch mismatch
            if (isBatch && !r.isBatch) score -= 2000
            if (!isBatch && r.isBatch) score -= 2000

            // Store with score for final sorting (not exposed in AnimeTorrent interface)
            (r as any)._rankScore = score
            map.set(r.infoHash, r)
        }
    }

    private finalizeResults(map: Map<string, AnimeTorrent>): AnimeTorrent[] {
        return Array.from(map.values()).sort((a, b) => ((b as any)._rankScore || 0) - ((a as any)._rankScore || 0))
    }

    private filterByEpisode(results: AnimeTorrent[], epNum: number): AnimeTorrent[] {
        const epStr = String(epNum)
        const regex = new RegExp(`(\\D|^)0*${epStr}(\\D|$)`, "i")
        return results.filter(t => regex.test(t.name))
    }

    //+ --------------------------------------------------------------------------------------------------
    // Core fetch
    //+ --------------------------------------------------------------------------------------------------

    private async fetchTorrents(url: string): Promise<NekoBTTorrent[]> {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`nekoBT: HTTP ${res.status}`)
        const json = await res.json() as NekoBTSearchResponse
        if (json.error) throw new Error(`nekoBT: API error — ${json.message}`)
        return json.data?.results ?? []
    }

    //+ --------------------------------------------------------------------------------------------------
    // Mapping
    //+ --------------------------------------------------------------------------------------------------

    private toAnimeTorrent(t: NekoBTTorrent): AnimeTorrent {
        const date = new Date(parseInt(t.uploaded_at, 10)).toISOString()
        const seeders = parseInt(t.seeders, 10) || 0
        const leechers = parseInt(t.leechers, 10) || 0
        const size = parseInt(t.filesize, 10) || 0

        return {
            name: t.title,
            date: date,
            size: size,
            formattedSize: "",
            seeders: seeders,
            leechers: leechers,
            downloadCount: parseInt(t.completed, 10) || 0,
            link: `https://nekobt.to/torrents/${t.id}`,
            magnetLink: t.magnet || undefined,
            infoHash: t.infohash || undefined,
            resolution: "",
            isBatch: t.batch,
            episodeNumber: -1,
            releaseGroup: (t.groups && t.groups.length > 0) ? t.groups[0].display_name : "",
            isBestRelease: false,
            confirmed: false,
        }
    }

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
