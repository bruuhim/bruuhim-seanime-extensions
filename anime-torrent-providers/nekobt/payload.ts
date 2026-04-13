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
        const batchParam = isBatch ? "&batch=true" : ""

        // Strategy A: Direct/Sanitized Query + Media Recommendation Discovery
        const primaryTitle = customQuery || media.romajiTitle || media.englishTitle || ""
        const sanitizedPrimary = this.sanitizeTitle(primaryTitle)
        
        if (sanitizedPrimary) {
            const epSuffix = episodeNumber && episodeNumber > 0 ? ` ${episodeNumber}` : ""
            const resSuffix = resolution ? ` ${resolution}` : ""
            const query = `${sanitizedPrimary}${epSuffix}${resSuffix}`.trim()
            
            const response = await this.tryFullResponse(query, baseUrl, batchParam)
            if (response && response.data) {
                if (Array.isArray(response.data.results) && response.data.results.length > 0) {
                    console.log(`nekoBT: Direct query returned ${response.data.results.length} results.`)
                    this.mergeResults(allResultsMap, response.data.results.map(t => this.toAnimeTorrent(t)), isBatch, episodeNumber, resolution)
                    return this.finalizeResults(allResultsMap)
                }

                // Strategy B: Media ID Discovery Recovery
                const mediaId = this.discoverMediaId(response, media)
                if (mediaId) {
                    console.log(`nekoBT: Found media recommendation ID: ${mediaId}`)
                    const recovered = await this.tryMediaIdSearch(mediaId, baseUrl, batchParam, episodeNumber, resolution)
                    if (recovered.length > 0) {
                        console.log(`nekoBT: Media ID search recovery succeeded for: ${mediaId}`)
                        this.mergeResults(allResultsMap, recovered, isBatch, episodeNumber, resolution)
                        return this.finalizeResults(allResultsMap)
                    }
                }
            }
        }

        // Strategy C: Alternative Titles Waterfall
        const altTitles = [media.romajiTitle, media.englishTitle, ...(media.synonyms || [])]
            .filter(t => t && t !== primaryTitle)
            .filter((v, i, a) => a.indexOf(v) === i) as string[]

        for (const title of altTitles) {
            const query = this.sanitizeTitle(title)
            if (!query) continue

            const results = await this.tryQuery(query, baseUrl, batchParam)
            if (results.length > 0) {
                console.log(`nekoBT: Alternative title search succeeded: ${query}`)
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        // Strategy D: Episode Formatting Retries
        if (episodeNumber && episodeNumber > 0) {
            const paddedEp = String(episodeNumber).padStart(2, "0")
            const variants = [
                `${sanitizedPrimary} ${paddedEp}`,
                `${sanitizedPrimary} E${paddedEp}`,
                `${sanitizedPrimary} EP${paddedEp}`,
                `${sanitizedPrimary} ep${episodeNumber}`
            ]
            for (const q of variants) {
                const results = await this.tryQuery(q, baseUrl, batchParam)
                if (results.length > 0) {
                    console.log(`nekoBT: Episode variant search succeeded: ${q}`)
                    this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                    return this.finalizeResults(allResultsMap)
                }
            }
        }

        // Strategy E: Broad Fallback (First 3 words)
        const broadTitle = sanitizedPrimary.split(" ").slice(0, 3).join(" ")
        if (broadTitle && broadTitle.length > 3) {
            const results = await this.tryQuery(broadTitle, baseUrl, batchParam)
            if (results.length > 0) {
                console.log(`nekoBT: Broad fallback search succeeded: ${broadTitle}`)
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        console.warn(`nekoBT: All strategies exhausted for: ${primaryTitle}`)
        return []
    }

    private discoverMediaId(response: NekoBTSearchResponse, targetMedia: Media): string | null {
        if (!response.data) return null

        // 1. Check Recommended Media (usually highest similarity)
        if (response.data.recommended_media && response.data.recommended_media.id) {
            return response.data.recommended_media.id
        }

        // 2. Check Similar Media and pick best candidate
        if (Array.isArray(response.data.similar_media) && response.data.similar_media.length > 0) {
            const best = [...response.data.similar_media].sort((a, b) => (b.similarity || 0) - (a.similarity || 0))[0]
            if (best && (best.similarity || 0) > 0.6) {
                return best.id
            }
        }

        return null
    }

    private async tryMediaIdSearch(mediaId: string, baseUrl: string, batchParam: string, epNum?: number, res?: string): Promise<AnimeTorrent[]> {
        const epSuffix = epNum && epNum > 0 ? `&episode_ids=${epNum}` : ""
        const url = `${baseUrl}/torrents/search?media_id=${mediaId}&sort_by=best&limit=50${batchParam}${epSuffix}`
        
        try {
            const torrents = await this.fetchTorrents(url)
            return torrents.map(t => this.toAnimeTorrent(t))
        } catch (e) {
            if (epSuffix) {
                return this.tryMediaIdSearch(mediaId, baseUrl, batchParam)
            }
            return []
        }
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

    private async tryFullResponse(query: string, baseUrl: string, batchParam: string): Promise<NekoBTSearchResponse | null> {
        const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50${batchParam}`
        try {
            const res = await fetch(url)
            if (!res.ok) return null
            return await res.json() as NekoBTSearchResponse
        } catch (e) {
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

            // Batch Intent mismatch penalty
            if (isBatch && !r.isBatch) score -= 2000
            if (!isBatch && r.isBatch) score -= 2000

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

    private async fetchTorrents(url: string): Promise<NekoBTTorrent[]> {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`nekoBT: HTTP ${res.status}`)
        const json = await res.json() as NekoBTSearchResponse
        if (json.error) throw new Error(`nekoBT: API error — ${json.message}`)
        return Array.isArray(json.data?.results) ? json.data.results : []
    }

    private toAnimeTorrent(t: NekoBTTorrent): AnimeTorrent {
        const dateStr = t.uploaded_at || "0"
        const date = new Date(parseInt(dateStr, 10)).toISOString()
        return {
            name: t.title || "Unknown",
            date: date,
            size: parseInt(t.filesize, 10) || 0,
            formattedSize: "",
            seeders: parseInt(t.seeders, 10) || 0,
            leechers: parseInt(t.leechers, 10) || 0,
            downloadCount: parseInt(t.completed, 10) || 0,
            link: t.id ? `https://nekobt.to/torrents/${t.id}` : "",
            magnetLink: t.magnet || undefined,
            infoHash: t.infohash || undefined,
            resolution: "",
            isBatch: !!t.batch,
            episodeNumber: -1,
            releaseGroup: (Array.isArray(t.groups) && t.groups.length > 0) ? t.groups[0].display_name : "",
            isBestRelease: false,
            confirmed: false,
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
