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

const NBT_MAPPING_URL = "https://raw.githubusercontent.com/ThaUnknown/anime-lists-ts/main/data/nbt-mapping.json"

class Provider {
    private defaultApiUrl = "https://nekobt.to/api/v1"
    private nbtTvdbMap: Record<string, string> | null = null
    private nbtTvdbMapLoading: Promise<void> | null = null

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

            console.debug(`nekoBT: smartSearch final result count: ${results.length}`)

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
    // ID Mapping (ThaUnknown/anime-lists-ts)
    // Maps TVDB ID -> NekoBT internal media ID (e.g. "s1234" or "m56")
    //+ --------------------------------------------------------------------------------------------------

    private async loadNbtTvdbMap(): Promise<void> {
        if (this.nbtTvdbMap !== null) return
        if (this.nbtTvdbMapLoading) {
            await this.nbtTvdbMapLoading
            return
        }
        this.nbtTvdbMapLoading = (async () => {
            try {
                console.debug("nekoBT: Loading TVDB\u2192NekoBT ID mapping from ThaUnknown/anime-lists-ts")
                const res = await fetch(NBT_MAPPING_URL)
                if (!res.ok) {
                    console.warn(`nekoBT: Failed to load ID mapping (HTTP ${res.status})`)
                    this.nbtTvdbMap = {}
                    return
                }
                const json = await res.json() as { tvdb?: Record<string, string>, tmdb?: Record<string, string> }
                this.nbtTvdbMap = json.tvdb ?? {}
                console.debug(`nekoBT: Loaded ${Object.keys(this.nbtTvdbMap).length} TVDB\u2192NekoBT mappings`)
            } catch (e) {
                console.warn("nekoBT: Could not load ID mapping: " + (e as Error).message)
                this.nbtTvdbMap = {}
            }
        })()
        await this.nbtTvdbMapLoading
    }

    private async resolveNbtMediaId(media: Media): Promise<string | null> {
        await this.loadNbtTvdbMap()
        if (!this.nbtTvdbMap) return null
        if (media.tvdbId) {
            const id = this.nbtTvdbMap[String(media.tvdbId)]
            if (id) {
                console.debug(`nekoBT: Resolved TVDB ${media.tvdbId} \u2192 NekoBT media ID "${id}"`)
                return id
            }
        }
        return null
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

        // Step 1: Resolve NekoBT media ID via ThaUnknown's TVDB mapping
        const resolvedMediaId = await this.resolveNbtMediaId(media)
        if (resolvedMediaId) {
            const url = `${baseUrl}/torrents/search?mediaid=${resolvedMediaId}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const response1 = await this.tryFullResponseUrl(url)
            if (response1 && response1.data && Array.isArray(response1.data.results) && response1.data.results.length > 0) {
                console.debug(`nekoBT: Mapped media ID returned ${response1.data.results.length} results.`)
                let step1Results = response1.data.results.map(t => this.toAnimeTorrent(t, episodeNumber))
                if (response1.data.more) {
                    const response1p2 = await this.tryFullResponseUrl(`${url}&offset=50`)
                    if (response1p2 && response1p2.data && Array.isArray(response1p2.data.results)) {
                        step1Results = step1Results.concat(response1p2.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)))
                    }
                }
                const step1Filtered = this.filterByMediaTitle(step1Results, media)
                this.mergeResults(allResultsMap, step1Filtered.length > 0 ? step1Filtered : step1Results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        // Step 2: TVDB ID direct API search (fallback if mapping missed)
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

        const validCustomQuery = (customQuery && typeof customQuery === "string") ? customQuery.trim() : ""
        const primaryTitle = validCustomQuery || media.romajiTitle || media.englishTitle || ""
        const sanitizedPrimary = validCustomQuery ? validCustomQuery : this.sanitizeTitle(primaryTitle)

        // Step 3: Direct title query — validate mediaId from response before follow-up
        if (sanitizedPrimary) {
            const epSuffix = (!validCustomQuery && episodeNumber && episodeNumber > 0) ? ` ${episodeNumber}` : ""
            const resSuffix = (!validCustomQuery && resolution) ? ` ${resolution}` : ""
            const query = `${sanitizedPrimary}${epSuffix}${resSuffix}`.trim()

            const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(query)}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
            const response = await this.tryFullResponseUrl(url)

            if (response && response.data) {
                if (Array.isArray(response.data.results) && response.data.results.length > 0) {
                    console.debug(`nekoBT: Direct query returned ${response.data.results.length} results.`)

                    // Validate media ID before follow-up to avoid poisoning from wrong first result.
                    // Priority: recommended_media (NekoBT's own pick) → similar_media ≥ 0.7 → majority vote ≥ 60%
                    const confirmedMediaId = this.resolveConfirmedMediaId(response)

                    if (confirmedMediaId) {
                        const followUpUrl = `${baseUrl}/torrents/search?mediaid=${confirmedMediaId}&sort_by=best&limit=50${batchParam}${videoCodecParam}`
                        const followUpResponse = await this.tryFullResponseUrl(followUpUrl)
                        if (followUpResponse && followUpResponse.data && Array.isArray(followUpResponse.data.results) && followUpResponse.data.results.length > 0) {
                            console.debug(`nekoBT: mediaid follow-up returned ${followUpResponse.data.results.length} results.`)
                            let followUpResults = followUpResponse.data.results.map(t => this.toAnimeTorrent(t, episodeNumber))
                            if (followUpResponse.data.more) {
                                const followUpResponse2 = await this.tryFullResponseUrl(`${followUpUrl}&offset=50`)
                                if (followUpResponse2 && followUpResponse2.data && Array.isArray(followUpResponse2.data.results)) {
                                    console.debug(`nekoBT: mediaid follow-up page 2 returned ${followUpResponse2.data.results.length} results.`)
                                    followUpResults = followUpResults.concat(followUpResponse2.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)))
                                }
                            }
                            const titleFiltered = this.filterByMediaTitle(followUpResults, media)
                            const toUse = titleFiltered.length > 0 ? titleFiltered : followUpResults
                            this.mergeResults(allResultsMap, toUse, isBatch, episodeNumber, resolution)
                            return this.finalizeResults(allResultsMap)
                        }
                    }

                    // No confirmed mediaId or follow-up returned nothing — use title query results as-is
                    this.mergeResults(allResultsMap, response.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                    return this.finalizeResults(allResultsMap)
                }
            }
        }

        // Step 4: Alternative titles waterfall
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

        // Step 5: Episode formatting retries
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

        // Step 6: Broad fallback (first 3 words)
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

    // Validate and resolve a NekoBT media ID from a search response.
    // Priority: recommended_media (NekoBT's own pick) → similar_media ≥ 0.7 → majority vote ≥ 60%
    // Returns null if no confident match is found, preventing follow-up with wrong media.
    private resolveConfirmedMediaId(response: NekoBTSearchResponse): string | null {
        if (!response.data) return null

        // 1. NekoBT's own recommendation — highest confidence
        if (response.data.recommended_media?.id) {
            console.debug(`nekoBT: Using recommended_media ID: ${response.data.recommended_media.id}`)
            return response.data.recommended_media.id
        }

        // 2. Best similar_media entry with similarity ≥ 0.7
        if (Array.isArray(response.data.similar_media) && response.data.similar_media.length > 0) {
            const best = [...response.data.similar_media].sort((a, b) => (b.similarity || 0) - (a.similarity || 0))[0]
            if (best && (best.similarity || 0) >= 0.7) {
                console.debug(`nekoBT: Using similar_media ID: ${best.id} (similarity ${best.similarity})`)
                return best.id
            }
        }

        // 3. Majority vote across all result media_ids — use if top candidate ≥ 60% of results
        const results = response.data.results
        if (!Array.isArray(results) || results.length === 0) return null

        const counts: Record<string, number> = {}
        for (const t of results) {
            if (t.media_id) counts[t.media_id] = (counts[t.media_id] || 0) + 1
        }
        const topId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]
        if (topId && counts[topId] / results.length >= 0.6) {
            console.debug(`nekoBT: Using majority-vote media ID: ${topId} (${counts[topId]}/${results.length} results)`)
            return topId
        }

        console.debug(`nekoBT: Could not confirm media ID — skipping follow-up`)
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
            if (!json || typeof json.data !== "object") {
                console.error("nekoBT: Unexpected API response format", json)
                return null
            }
            if (json.error) {
                console.error(`nekoBT: API error \u2014 ${json.message}`)
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

            if (map.has(r.infoHash)) {
                const existing = map.get(r.infoHash)!
                if (r.seeders > existing.torrent.seeders) {
                    existing.torrent = r
                }
                continue
            }

            let score = r.seeders || 0
            const titleLower = r.name.toLowerCase()

            if (res && titleLower.includes(res.toLowerCase())) score += 1000

            if (epNum && epNum > 0) {
                const epStr = String(epNum)
                const paddedEp = epStr.padStart(2, "0")
                if (
                    titleLower.includes(`e${epStr}`) || titleLower.includes(`ep${epStr}`) || titleLower.includes(` ${epStr} `) ||
                    titleLower.includes(`e${paddedEp}`) || titleLower.includes(`ep${paddedEp}`) || titleLower.includes(` ${paddedEp} `)
                ) {
                    score += 500
                }
            }

            if (res) {
                const rLower = res.toLowerCase()
                if ((rLower.includes("x265") || rLower.includes("hevc")) && (titleLower.includes("x265") || titleLower.includes("hevc"))) score += 300
                if ((rLower.includes("x264") || rLower.includes("avc")) && (titleLower.includes("x264") || titleLower.includes("avc"))) score += 300
                if (rLower.includes("av1") && titleLower.includes("av1")) score += 300
            }

            if (isBatch && !r.isBatch) score -= 2000
            if (!isBatch && r.isBatch) score -= 2000

            if (r.releaseGroup) score += 100

            if (score > 1500) r.isBestRelease = true

            map.set(r.infoHash, { torrent: r, score })
        }
    }

    private finalizeResults(map: Map<string, RankedTorrent>): AnimeTorrent[] {
        return Array.from(map.values())
            .sort((a, b) => b.score - a.score)
            .map(v => v.torrent)
    }

    private filterByEpisode(results: AnimeTorrent[], epNum: number): AnimeTorrent[] {
        const ep = epNum
        const filtered = results.filter(t => {
            const title = t.name
            // SxxEyy — match episode part only, not season part
            const sxeMatch = title.match(/S\d+E(\d+)/i)
            if (sxeMatch) return parseInt(sxeMatch[1], 10) === ep
            // [EP01] or (EP01) or EP01 word boundary
            const epTagMatch = title.match(/[\[(]?EP?(\d+)[\])]?/i)
            if (epTagMatch) return parseInt(epTagMatch[1], 10) === ep
            // " - 01" or " - 1 " style (fansub common format)
            const dashMatch = title.match(/\s-\s*(\d+)\s*[\[(v\.]/)
            if (dashMatch) return parseInt(dashMatch[1], 10) === ep
            // bare number surrounded by spaces/brackets at end: "Title 01 [1080p]"
            const bareMatch = title.match(/(?:^|\s)(\d{1,4})(?:\s|v\d|\[|\(|\.mkv|$)/i)
            if (bareMatch) return parseInt(bareMatch[1], 10) === ep
            return false
        })

        console.debug(`nekoBT: filterByEpisode(ep=${epNum}) — input: ${results.length}, output: ${filtered.length}`)
        if (filtered.length < results.length) {
            const dropped = results.filter(r => !filtered.includes(r)).slice(0, 5).map(r => r.name)
            console.debug(`nekoBT: filterByEpisode — dropped examples: ${JSON.stringify(dropped)}`)
        }

        return filtered
    }

    private toAnimeTorrent(t: NekoBTTorrent, expectedEp?: number): AnimeTorrent {
        let ts = 0
        if (typeof t.uploaded_at === "number") {
            ts = t.uploaded_at
        } else if (typeof t.uploaded_at === "string") {
            ts = parseInt(t.uploaded_at, 10)
        }

        const date = (ts > 0 && !isNaN(ts)) ? new Date(ts).toISOString() : new Date().toISOString()

        let resolution = ""
        const tLower = t.title.toLowerCase()
        if (tLower.includes("2160p") || tLower.includes("4k")) resolution = "2160p"
        else if (tLower.includes("1080p")) resolution = "1080p"
        else if (tLower.includes("720p")) resolution = "720p"
        else if (tLower.includes("480p")) resolution = "480p"

        let episodeNumber = -1
        const sxeMatch = t.title.match(/S[0-9]+E([0-9]+)/i)
        if (sxeMatch) {
            episodeNumber = parseInt(sxeMatch[1], 10)
        } else {
            const dashMatch = t.title.match(/\s-\s*(\d{1,4})(?:\s|v\d|\[|\(|\.)/i)
            if (dashMatch) {
                episodeNumber = parseInt(dashMatch[1], 10)
            } else {
                const epMatch = t.title.match(/\bEP?([0-9]{1,4})\b/i)
                if (epMatch) {
                    episodeNumber = parseInt(epMatch[1], 10)
                }
            }
        }

        const cleanTitle = tLower
            .split("1080p").join("").split("720p").join("").split("480p").join("")
            .split("2160p").join("").split("2024").join("").split("2025").join("")
            .split("2026").join("").split("x264").join("").split("x265").join("")

        if (episodeNumber === -1 && expectedEp !== undefined && expectedEp !== null) {
            const epStr = expectedEp.toString()
            const padEp = expectedEp < 10 ? "0" + epStr : epStr
            const variants = [
                " " + padEp + " ", " " + padEp + "(", " " + padEp + "[", " " + padEp + ".mkv",
                " " + epStr + " ", " " + epStr + "(", " " + epStr + "[", " " + epStr + ".mkv",
                "[" + padEp + "]", "[" + epStr + "]",
                "-" + padEp, "- " + padEp,
                "e" + padEp, "ep" + padEp, "ep " + padEp,
                "episode " + padEp, "episode " + epStr
            ]
            for (let i = 0; i < variants.length; i++) {
                if (cleanTitle.includes(variants[i])) {
                    episodeNumber = expectedEp
                    break
                }
            }
        }

        return {
            name: t.title || "Unknown",
            date,
            size: typeof t.filesize === "number" ? t.filesize : (parseInt(String(t.filesize ?? "0"), 10) || 0),
            formattedSize: "",
            seeders: typeof t.seeders === "number" ? t.seeders : (parseInt(String(t.seeders ?? "0"), 10) || 0),
            leechers: typeof t.leechers === "number" ? t.leechers : (parseInt(String(t.leechers ?? "0"), 10) || 0),
            downloadCount: typeof t.completed === "number" ? t.completed : (parseInt(String(t.completed ?? "0"), 10) || 0),
            link: t.id ? `https://nekobt.to/torrents/${t.id}` : "",
            magnetLink: t.magnet || undefined,
            infoHash: t.infohash ? t.infohash.toLowerCase() : undefined,
            resolution,
            isBatch: !!t.batch,
            episodeNumber,
            releaseGroup: (Array.isArray(t.groups) && t.groups.length > 0) ? t.groups[0].display_name : "",
            isBestRelease: false,
            confirmed: (episodeNumber !== -1 || !!t.batch),
        }
    }

    private getApiUrl(): string {
        return this.defaultApiUrl
    }

    private filterByMediaTitle(results: AnimeTorrent[], media: Media): AnimeTorrent[] {
        const candidates = [
            media.romajiTitle,
            media.englishTitle,
            ...(media.synonyms || [])
        ].filter(Boolean) as string[]

        if (candidates.length === 0) return results

        const normalize = (s: string) => s.toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()

        // Stop words to exclude — these appear in too many unrelated strings
        const STOP_WORDS = new Set(["the","and","are","you","for","was","its","his","her","not","but","all","can","had","has","have","this","that","with","from","they","will","been","one","into","who","how","our","out","about","also","just","more","than","when","what","then","very","your","would","could","should","him","them","their","been","were","after"])

        // Build significant word sets per candidate — only words ≥4 chars and not stop words
        const candidateSets = candidates.map(c => {
            const words = normalize(c).split(" ").filter(w => w.length >= 4 && !STOP_WORDS.has(w))
            return new Set(words)
        })

        // Remove empty sets
        const validSets = candidateSets.filter(s => s.size > 0)
        if (validSets.length === 0) return results

        console.debug(`nekoBT: filterByMediaTitle — significant word sets: ${JSON.stringify(validSets.map(s => [...s]))}`)

        const passed: AnimeTorrent[] = []
        const rejected: string[] = []

        for (const t of results) {
            const norm = normalize(t.name)

            // A torrent passes if it matches ANY candidate's words with ≥50% overlap
            let pass = false
            for (const wordSet of validSets) {
                let matches = 0
                for (const w of wordSet) {
                    if (norm.includes(w)) matches++
                }
                const ratio = matches / wordSet.size
                // Need at least 2 matching significant words AND ≥50% of that candidate's words
                if (matches >= 2 && ratio >= 0.5) {
                    pass = true
                    break
                }
            }

            if (pass) {
                passed.push(t)
            } else {
                rejected.push(`"${t.name}"`)
            }
        }

        console.debug(`nekoBT: filterByMediaTitle — passed: ${passed.length}, rejected: ${rejected.length}`)

        // Safety: if we filtered too aggressively (< 3 passed), return all results unfiltered
        if (passed.length < 3) {
            console.debug(`nekoBT: filterByMediaTitle — too few passed (${passed.length}), returning all ${results.length} unfiltered`)
            return results
        }

        return passed
    }

    private sanitizeTitle(title: string): string {
        if (!title) return ""
        return title
            .replace(/[\uff1a:\u300c\u300d\u3010\u3011\u300e\u300f\uff08\uff09()[\]{}]/g, " ")
            .replace(/[^\w\s\-']/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }
}
