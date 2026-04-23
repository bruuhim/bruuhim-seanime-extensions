/// <reference path="../../typing/anime-torrent-provider.d.ts" />
/// <reference path="../../typing/core.d.ts" />

interface NekoBTTorrent {
    id: string
    uploaded_at: number
    title: string
    infohash: string
    magnet: string
    private_magnet: string | null
    media_id: string
    description?: string | null
    filesize: number
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
    seeders: number
    leechers: number
    completed: number
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
        recommended_media?: {
            id: string
            title: string
            similarity: number
        } | null
        similar_media?: {
            id: string
            title: string
            similarity: number
        }[] | null
        infohash_match?: string | null
    }
}

interface RankedTorrent {
    torrent: AnimeTorrent
    score: number
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
            console.debug("nekoBT: Fetching latest torrents")
            const url = `${this.getApiUrl()}/torrents/search?sort_by=rss&limit=50`
            const response = await this.tryFullResponseUrl(url)
            if (!response || !response.data || !Array.isArray(response.data.results)) return []
            return response.data.results.map(t => this.toAnimeTorrent(t))
        } catch (error) {
            console.error("nekoBT: Error fetching latest: " + (error as Error).message)
            return []
        }
    }

    public async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            console.debug(`nekoBT: Searching for "${opts.query}"`)
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
            
            console.debug(`nekoBT: Smart searching (batch: ${isBatch}, ep: ${epNum})...`)
            
            let results = await this.executeSearchWaterfall(opts.media, opts.query, opts.resolution, isBatch, epNum)

            if (!isBatch && epNum && epNum > 0) {
                const filtered = this.filterByEpisode(results, epNum)
                if (filtered.length > 0) results = filtered
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
        
        const allResultsMap = new Map<string, RankedTorrent>()
        const baseUrl = this.getApiUrl()
        const batchParam = isBatch !== undefined ? `&batch=${isBatch}` : ""
        
        let videoCodecParam = ""
        if (resolution) {
            const r = resolution.toLowerCase()
            if (r.includes("x265") || r.includes("hevc")) videoCodecParam = "&videocodec=1"
            else if (r.includes("x264") || r.includes("avc")) videoCodecParam = "&videocodec=2"
            else if (r.includes("av1")) videoCodecParam = "&videocodec=3"
        }

        // TVDB ID Search
        if (media.tvdbId) {
            const url = `${baseUrl}/torrents/search?tvdbid=${media.tvdbId}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const response = await this.tryFullResponseUrl(url)
            if (response && response.data && Array.isArray(response.data.results) && response.data.results.length > 0) {
                console.debug(`nekoBT: TVDB ID search returned ${response.data.results.length} results.`)
                this.mergeResults(allResultsMap, response.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                
                if (response.data.results.length < 10 && response.data.more) {
                    const response2 = await this.tryFullResponseUrl(`${url}&offset=50`)
                    if (response2 && response2.data && Array.isArray(response2.data.results)) {
                        this.mergeResults(allResultsMap, response2.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                    }
                }
                
                return this.finalizeResults(allResultsMap)
            }
        }

        const validCustomQuery = (customQuery && typeof customQuery === "string") ? customQuery.trim() : "";
        const primaryTitle = validCustomQuery || media.romajiTitle || media.englishTitle || ""
        const sanitizedPrimary = validCustomQuery ? validCustomQuery : this.sanitizeTitle(primaryTitle)
        
        let discoveredMediaId: string | null = null

        // Direct Title Query
        if (sanitizedPrimary) {
            const epSuffix = (!validCustomQuery && episodeNumber && episodeNumber > 0) ? ` ${episodeNumber}` : ""
            const resSuffix = (!validCustomQuery && resolution) ? ` ${resolution}` : ""
            const query = `${sanitizedPrimary}${epSuffix}${resSuffix}`.trim()
            
            const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const response = await this.tryFullResponseUrl(url)
            
            if (response && response.data) {
                discoveredMediaId = this.discoverMediaId(response, media)
                
                if (Array.isArray(response.data.results) && response.data.results.length > 0) {
                    console.debug(`nekoBT: Direct query returned ${response.data.results.length} results.`)
                    this.mergeResults(allResultsMap, response.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                    
                    if (response.data.results.length < 10 && response.data.more) {
                        const response2 = await this.tryFullResponseUrl(`${url}&offset=50`)
                        if (response2 && response2.data && Array.isArray(response2.data.results)) {
                            this.mergeResults(allResultsMap, response2.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                        }
                    }
                    return this.finalizeResults(allResultsMap)
                }
            }
        }

        // Media ID + Episode Filter
        if (discoveredMediaId && episodeNumber && episodeNumber > 0) {
            const url = `${baseUrl}/torrents/search?mediaid=${discoveredMediaId}&episodeids=${episodeNumber}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const results = await this.tryQueryUrl(url, episodeNumber)
            if (results.length > 0) {
                console.debug(`nekoBT: Media ID + episode filter returned ${results.length} results.`)
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        // Media ID without Episode Filter
        if (discoveredMediaId) {
            const url = `${baseUrl}/torrents/search?mediaid=${discoveredMediaId}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const results = await this.tryQueryUrl(url, episodeNumber)
            if (results.length > 0) {
                console.debug(`nekoBT: Media ID without episode filter returned ${results.length} results.`)
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        // Alternative Titles Waterfall
        const altTitles = [media.romajiTitle, media.englishTitle, ...(media.synonyms || [])]
            .filter(t => t && t !== primaryTitle)
            .filter((v, i, a) => a.indexOf(v) === i) as string[]

        for (const title of altTitles) {
            const query = this.sanitizeTitle(title)
            if (!query) continue

            const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const results = await this.tryQueryUrl(url, episodeNumber)
            if (results.length > 0) {
                console.debug(`nekoBT: Alternative title search succeeded: ${query}`)
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        // Episode Formatting Retries
        if (episodeNumber && episodeNumber > 0) {
            const paddedEp = String(episodeNumber).padStart(2, "0")
            const variants = [
                `${sanitizedPrimary} ${paddedEp}`,
                `${sanitizedPrimary} E${paddedEp}`,
                `${sanitizedPrimary} EP${paddedEp}`,
                `${sanitizedPrimary} ep${episodeNumber}`
            ]
            for (const q of variants) {
                const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(q)}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
                const results = await this.tryQueryUrl(url, episodeNumber)
                if (results.length > 0) {
                    console.debug(`nekoBT: Episode variant search succeeded: ${q}`)
                    this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                    return this.finalizeResults(allResultsMap)
                }
            }
        }

        // Broad Fallback (First 3 words)
        const broadTitle = sanitizedPrimary.split(" ").slice(0, 3).join(" ")
        if (broadTitle && broadTitle.length > 3) {
            const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(broadTitle)}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const results = await this.tryQueryUrl(url, episodeNumber)
            if (results.length > 0) {
                console.debug(`nekoBT: Broad fallback search succeeded: ${broadTitle}`)
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        console.warn(`nekoBT: All strategies exhausted for: ${primaryTitle}`)
        return []
    }

    private discoverMediaId(response: NekoBTSearchResponse, targetMedia: Media): string | null {
        if (!response.data) return null

        if (response.data.recommended_media && response.data.recommended_media.id) {
            return response.data.recommended_media.id
        }

        if (Array.isArray(response.data.similar_media) && response.data.similar_media.length > 0) {
            const best = [...response.data.similar_media].sort((a, b) => (b.similarity || 0) - (a.similarity || 0))[0]
            if (best && (best.similarity || 0) > 0.6) {
                return best.id
            }
        }

        return null
    }

    private async tryQueryUrl(url: string, epNum?: number): Promise<AnimeTorrent[]> {
        const response = await this.tryFullResponseUrl(url)
        if (response && response.data && Array.isArray(response.data.results)) {
            return response.data.results.map(t => this.toAnimeTorrent(t, epNum))
        }
        return []
    }

    private async tryFullResponseUrl(url: string): Promise<NekoBTSearchResponse | null> {
        console.debug(`nekoBT: Fetching ${url}`)
        try {
            const res = await fetch(url)
            if (res.status === 429) {
                console.warn("nekoBT: Rate limit reached (HTTP 429)")
                return null
            }
            if (!res.ok) {
                console.error(`nekoBT: HTTP ${res.status}`)
                return null
            }
            const json = await res.json() as any
            if (!json || typeof json.data !== 'object') {
                console.error("nekoBT: Unexpected API response format", json)
                return null
            }
            if (json.error) {
                console.error(`nekoBT: API error — ${json.message}`)
                return null
            }
            return json as NekoBTSearchResponse
        } catch (e) {
            console.error(`nekoBT: Fetch error: ${(e as Error).message}`)
            return null
        }
    }

    private mergeResults(
        map: Map<string, RankedTorrent>, 
        newResults: AnimeTorrent[],
        isBatch?: boolean,
        epNum?: number,
        res?: string
    ) {
        for (const r of newResults) {
            if (!r || !r.infoHash) continue

            // Deduplication
            if (map.has(r.infoHash)) {
                const existing = map.get(r.infoHash)!
                if (r.seeders > existing.torrent.seeders) {
                    existing.torrent = r
                }
                continue
            }
            
            // Scoring
            let score = r.seeders || 0
            const titleLower = r.name.toLowerCase()
            
            // Resolution Match Bonus
            if (res && titleLower.includes(res.toLowerCase())) {
                score += 1000
            }
            
            // Episode Match Bonus
            if (epNum && epNum > 0) {
                const epStr = String(epNum)
                const paddedEp = epStr.padStart(2, "0")
                if (titleLower.includes(`e${epStr}`) || titleLower.includes(`ep${epStr}`) || titleLower.includes(` ${epStr} `) ||
                    titleLower.includes(`e${paddedEp}`) || titleLower.includes(`ep${paddedEp}`) || titleLower.includes(` ${paddedEp} `)) {
                    score += 500
                }
            }

            // Codec Match Bonus
            if (res) {
                const rLower = res.toLowerCase()
                if ((rLower.includes("x265") || rLower.includes("hevc")) && (titleLower.includes("x265") || titleLower.includes("hevc"))) score += 300
                if ((rLower.includes("x264") || rLower.includes("avc")) && (titleLower.includes("x264") || titleLower.includes("avc"))) score += 300
                if (rLower.includes("av1") && titleLower.includes("av1")) score += 300
            }

            // Batch Intent mismatch penalty
            if (isBatch && !r.isBatch) score -= 2000
            if (!isBatch && r.isBatch) score -= 2000

            // Group quality signal
            if (r.releaseGroup) score += 100

            if (score > 1500) r.isBestRelease = true

            map.set(r.infoHash, {
                torrent: r,
                score: score
            })
        }
    }

    private finalizeResults(map: Map<string, RankedTorrent>): AnimeTorrent[] {
        const values = Array.from(map.values())
        return values
            .sort((a, b) => b.score - a.score)
            .map(v => v.torrent)
    }

    private filterByEpisode(results: AnimeTorrent[], epNum: number): AnimeTorrent[] {
        const epStr = String(epNum)
        const regex = new RegExp(`(\\D|^)0*${epStr}(\\D|$)`, "i")
        return results.filter(t => regex.test(t.name))
    }

    private toAnimeTorrent(t: NekoBTTorrent, expectedEp?: number): AnimeTorrent {
        let ts = 0;
        if (typeof t.uploaded_at === "number") {
            ts = t.uploaded_at;
        } else if (typeof t.uploaded_at === "string") {
            ts = parseInt(t.uploaded_at, 10);
        }
        
        let date: string;
        if (ts > 0 && !isNaN(ts)) {
            date = new Date(ts).toISOString();
        } else {
            date = new Date().toISOString();
        }

        // 1. Aggressive Resolution Extraction
        let resolution = "";
        const resMatch = t.title.match(/\b(2160p|4K|1080p|720p|480p|360p)\b/i);
        if (resMatch) resolution = resMatch[1].toLowerCase() === '4k' ? '2160p' : resMatch[1];

        // 2. Aggressive Context-Aware Episode Extraction
        let episodeNumber = -1;

        if (expectedEp !== undefined && expectedEp !== null) {
            // Aggressively search for the exact expected episode (padded or unpadded)
            const epStr = expectedEp.toString();
            const paddedEp = expectedEp < 10 ? `0${expectedEp}` : epStr;
            // Matches " 1 ", " 01 ", "[01]", "- 01", "E01"
            const targetRegex = new RegExp(`(?:^|[\\s_\\[\\-(])(?:EP?|E)?(?:${epStr}|${paddedEp})(?:v\\d)?(?:[\\s_\\]\\-)]|$)`, 'i');
            
            if (targetRegex.test(t.title)) {
                episodeNumber = expectedEp;
            }
        }

        // 3. Fallback generic extraction if expectedEp isn't provided or missed
        if (episodeNumber === -1) {
            // Strip resolutions and years so they aren't confused for episodes
            const cleanTitle = t.title.replace(/\b(?:1080p|720p|480p|2160p|4k|2k|x264|x265|HEVC|AV1|19\d{2}|20\d{2})\b/ig, '');
            const epMatch = cleanTitle.match(/(?:^|[\\s_\\[\\-(])(?:EP?|E)?0*(\d{1,4})(?:v\d)?(?:[\\s_\\]\\-)]|$)/i);
            if (epMatch) {
                episodeNumber = parseInt(epMatch[1], 10);
            }
        }

        return {
            name: t.title || "Unknown",
            date: date,
            size: typeof t.filesize === "number" ? t.filesize : (parseInt(String(t.filesize ?? "0"), 10) || 0),
            formattedSize: "",
            seeders: typeof t.seeders === "number" ? t.seeders : (parseInt(String(t.seeders ?? "0"), 10) || 0),
            leechers: typeof t.leechers === "number" ? t.leechers : (parseInt(String(t.leechers ?? "0"), 10) || 0),
            downloadCount: typeof t.completed === "number" ? t.completed : (parseInt(String(t.completed ?? "0"), 10) || 0),
            link: t.id ? `https://nekobt.to/torrents/${t.id}` : "",
            magnetLink: t.magnet || undefined,
            infoHash: t.infohash ? t.infohash.toLowerCase() : undefined,
            resolution: resolution,
            isBatch: !!t.batch,
            episodeNumber: episodeNumber,
            releaseGroup: (Array.isArray(t.groups) && t.groups.length > 0) ? t.groups[0].display_name : "",
            isBestRelease: false,
            confirmed: (episodeNumber !== -1 || !!t.batch),
        }
    }

    private getApiUrl(): string {
        return this.defaultApiUrl
    }

    private sanitizeTitle(title: string): string {
        if (!title) return ""
        return title
            .replace(/[：:「」【】『』（）()[\]{}]/g, " ")
            .replace(/[^\w\s\-']/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }
}