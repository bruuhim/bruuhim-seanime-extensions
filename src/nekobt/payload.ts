/// <reference path="../../typing/anime-torrent-provider.d.ts" />
/// <reference path="../../typing/core.d.ts" />

interface Media {
    tvdbId?: number
    tmdbId?: number
}

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
    private qualityScores: Map<string, number> = new Map()

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
        let magnet = torrent.magnetLink || torrent.downloadUrl || ""
        if (!magnet) return ""
        const userkey = $getUserPreference("userkey")
        if (userkey && userkey.trim()) {
            let cleanUserkey = userkey.trim()
            if (cleanUserkey.includes("/tracker/")) {
                const parts = cleanUserkey.split("/tracker/")
                if (parts.length > 1) {
                    const subParts = parts[1].split("/")
                    cleanUserkey = subParts[0]
                }
            }
            const trUrl = `https://tracker.nekobt.to/api/tracker/${cleanUserkey}/announce`
            const encodedTr = encodeURIComponent(trUrl)
            
            // Search for existing nekoBT tracker URL (encoded or unencoded) and replace/update it
            const regexEncoded = /tr=https%3A%2F%2Ftracker\.nekobt\.to%2Fapi%2Ftracker%2F[a-zA-Z0-9_-]+%2Fannounce/i
            const regexUnencoded = /tr=https:\/\/tracker\.nekobt\.to\/api\/tracker\/[a-zA-Z0-9_-]+\/announce/i
            
            if (regexEncoded.test(magnet)) {
                magnet = magnet.replace(regexEncoded, `tr=${encodedTr}`)
            } else if (regexUnencoded.test(magnet)) {
                magnet = magnet.replace(regexUnencoded, `tr=${trUrl}`)
            } else {
                magnet += `&tr=${encodedTr}`
            }
        }
        return magnet
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
                
                const res = await fetch(NBT_MAPPING_URL)
                if (!res.ok) {
                    console.warn(`nekoBT: Failed to load ID mapping (HTTP ${res.status})`)
                    this.nbtTvdbMap = {}
                    return
                }
                const json = await res.json() as { tvdb?: Record<string, string>, tmdb?: Record<string, string> }
                this.nbtTvdbMap = json.tvdb ?? {}
            } catch (e) {
                console.warn("nekoBT: Could not load ID mapping: " + (e as Error).message)
                this.nbtTvdbMap = {}
            }
        })()
        await this.nbtTvdbMapLoading
    }

    private async resolveNbtMediaId(media: Media): Promise<string | null> {
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

        this.qualityScores.clear()
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

        let epQueryParam = ""
        if (!isBatch && episodeNumber && episodeNumber > 0) {
            epQueryParam = `&query=${episodeNumber}`
        }

        // Step 1: Resolve NekoBT media ID via ThaUnknown's TVDB mapping
        const resolvedMediaId = await this.resolveNbtMediaId(media)
        if (resolvedMediaId) {
            const url = `${baseUrl}/torrents/search?mediaid=${resolvedMediaId}&sort_by=best&limit=50${batchParam}${videoCodecParam}${epQueryParam}`
            const response1 = await this.tryFullResponseUrl(url)
            if (response1 && response1.data && Array.isArray(response1.data.results) && response1.data.results.length > 0) {
                this.computeQualityScores(response1.data.results)
                let step1Results = response1.data.results.map(t => this.toAnimeTorrent(t, episodeNumber))
                if (response1.data.more) {
                    const response1p2 = await this.tryFullResponseUrl(`${url}&offset=50`)
                    if (response1p2 && response1p2.data && Array.isArray(response1p2.data.results)) {
                        this.computeQualityScores(response1p2.data.results)
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
            const url = `${baseUrl}/torrents/search?tvdbid=${media.tvdbId}&sort_by=best&limit=50${batchParam}${videoCodecParam}${epQueryParam}`
            const response = await this.tryFullResponseUrl(url)
            if (response && response.data && Array.isArray(response.data.results) && response.data.results.length > 0) {
                this.computeQualityScores(response.data.results)
                this.mergeResults(allResultsMap, response.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                if (response.data.results.length < 10 && response.data.more) {
                    const response2 = await this.tryFullResponseUrl(`${url}&offset=50`)
                    if (response2 && response2.data && Array.isArray(response2.data.results)) {
                        this.computeQualityScores(response2.data.results)
                        this.mergeResults(allResultsMap, response2.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                    }
                }
                return this.finalizeResults(allResultsMap)
            }
        }

        // Step 2.5: TMDB ID direct API search (fallback if mapping missed)
        if (media.tmdbId) {
            const url = `${baseUrl}/torrents/search?tmdbid=${media.tmdbId}&sort_by=best&limit=50${batchParam}${videoCodecParam}${epQueryParam}`
            const response = await this.tryFullResponseUrl(url)
            if (response && response.data && Array.isArray(response.data.results) && response.data.results.length > 0) {
                this.computeQualityScores(response.data.results)
                this.mergeResults(allResultsMap, response.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                if (response.data.results.length < 10 && response.data.more) {
                    const response2 = await this.tryFullResponseUrl(`${url}&offset=50`)
                    if (response2 && response2.data && Array.isArray(response2.data.results)) {
                        this.computeQualityScores(response2.data.results)
                        this.mergeResults(allResultsMap, response2.data.results.map(t => this.toAnimeTorrent(t, episodeNumber)), isBatch, episodeNumber, resolution)
                    }
                }
                return this.finalizeResults(allResultsMap)
            }
        }

        const validCustomQuery = (customQuery && typeof customQuery === "string") ? customQuery.trim() : ""
        const primaryTitle = validCustomQuery || media.romajiTitle || media.englishTitle || ""
        const sanitizedPrimary = validCustomQuery ? validCustomQuery : this.sanitizeTitle(primaryTitle)

        // Step 3: Direct title query with pagination � query title only (no episode number appended), paginate to find enough ep matches
        if (sanitizedPrimary) {
            // Build query without episode number (just title + optional resolution)
            const resSuffix = (!validCustomQuery && resolution) ? ` ${resolution}` : ""
            const queryBase = `${sanitizedPrimary}${resSuffix}`.trim()

            let allTitleResults: AnimeTorrent[] = []
            let offset = 0
            const MAX_PAGES = 3

            for (let page = 0; page < MAX_PAGES; page++) {
                const pageParam = offset > 0 ? `&offset=${offset}` : ""
                const url = `${baseUrl}/torrents/search?query=${encodeURIComponent(queryBase)}&sort_by=best&limit=50${batchParam}${videoCodecParam}${pageParam}`
                
                const response = await this.tryFullResponseUrl(url)

                if (!response || !response.data || !Array.isArray(response.data.results) || response.data.results.length === 0) {
                    break
                }

                this.computeQualityScores(response.data.results)
                const rawResults = response.data.results.map(t => this.toAnimeTorrent(t, episodeNumber))
                const titleFiltered = this.filterByMediaTitle(rawResults, media)
                allTitleResults = allTitleResults.concat(titleFiltered)
                

                // Guard against undefined episode (Batch mode)
                if (episodeNumber === undefined || episodeNumber === null) {
                    if (!response.data.more) break
                    offset += 50
                    continue
                }

                // Check how many match the target episode
                const epMatches = this.countEpisodeMatches(allTitleResults, episodeNumber)
                

                // Stop only if no more pages
                if (!response.data.more) break
                offset += 50
            }

            if (allTitleResults.length > 0) {
                
                this.mergeResults(allResultsMap, allTitleResults, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
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
                
                this.mergeResults(allResultsMap, results, isBatch, episodeNumber, resolution)
                return this.finalizeResults(allResultsMap)
            }
        }

        console.warn(`nekoBT: All strategies exhausted for: ${primaryTitle}`)
        return []
    }

private async tryQueryUrl(url: string, epNum?: number): Promise<AnimeTorrent[]> {
        const response = await this.tryFullResponseUrl(url)
        if (response && response.data && Array.isArray(response.data.results)) {
            this.computeQualityScores(response.data.results)
            return response.data.results.map(t => this.toAnimeTorrent(t, epNum))
        }
        return []
    }

    private async tryFullResponseUrl(url: string): Promise<NekoBTSearchResponse | null> {
        
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

            const qualityScore = this.qualityScores.get(r.infoHash) || 0
            score += qualityScore

            if (score > 2500) r.isBestRelease = true

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
        const epPatterns = [
            new RegExp(`s\\d{1,2}e0*${ep}(?!\\d)`, "i"),   // S01E01
            new RegExp(`e0*${ep}(?!\\d)`, "i"),              // E01 standalone
            new RegExp(`[-_\\s]0*${ep}(?!\\d)`, "i"),        // - 01 or _01 or space01
            new RegExp(`ep\\.?\\s*0*${ep}(?!\\d)`, "i"),     // ep01 or ep. 01
            new RegExp(`episode\\s*0*${ep}(?!\\d)`, "i"),    // episode 01
        ]
        
        return results.filter(t => {
            const name = t.name.toLowerCase()
            return epPatterns.some(p => p.test(name))
        })
    }

    private countEpisodeMatches(results: AnimeTorrent[], episodeNumber: number): number {
        const ep = episodeNumber
        const epPatterns = [
            new RegExp(`s\\d{1,2}e0*${ep}(?!\\d)`, "i"),   // S01E01
            new RegExp(`e0*${ep}(?!\\d)`, "i"),              // E01 standalone
            new RegExp(`[-_\\s]0*${ep}(?!\\d)`, "i"),        // - 01 or _01 or space01
            new RegExp(`ep\\.?\\s*0*${ep}(?!\\d)`, "i"),     // ep01 or ep. 01
            new RegExp(`episode\\s*0*${ep}(?!\\d)`, "i"),    // episode 01
        ]
        return results.filter(t => {
            const name = t.name.toLowerCase()
            return epPatterns.some(p => p.test(name))
        }).length
    }


    private computeQualityScores(torrents: NekoBTTorrent[]): void {
        for (const t of torrents) {
            let score = 0
            // NekoBT internal quality level
            score += (t.level || 0) * 50
            // Source quality (video_type): 1=BD, 4=WEB, 2=DVD, 3=TV
            if (t.video_type === 1) score += 500
            else if (t.video_type === 4) score += 300
            else if (t.video_type === 2) score += 200
            else if (t.video_type === 3) score += 100
            // Fansub (professional subbing group)
            if (t.fsub_lang) score += 400
            // Not on-the-fly encode
            if (!t.otl) score += 200
            // Softsubs preferred over hardsubs
            if (!t.hardsub) score += 100
            // Not machine translated
            if (!t.mtl) score += 100
            // Release group count (more groups = more reputable)
            if (t.groups && t.groups.length > 0) score += t.groups.length * 50
            // Video codec quality: x265 > AV1 > x264
            if (t.video_codec === 1) score += 300       // x265/HEVC
            else if (t.video_codec === 3) score += 250   // AV1
            else if (t.video_codec === 2) score += 200   // x264/AVC
            this.qualityScores.set(t.infohash, score)
        }
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

        const rawSize = typeof t.filesize === "number" ? t.filesize : (parseInt(String(t.filesize ?? "0"), 10) || 0)
        return {
            name: t.title || "Unknown",
            date,
            size: rawSize,
            formattedSize: this.formatBytes(rawSize),
            seeders: typeof t.seeders === "number" ? t.seeders : (parseInt(String(t.seeders ?? "0"), 10) || 0),
            leechers: typeof t.leechers === "number" ? t.leechers : (parseInt(String(t.leechers ?? "0"), 10) || 0),
            downloadCount: typeof t.completed === "number" ? t.completed : (parseInt(String(t.completed ?? "0"), 10) || 0),
            link: t.id ? `https://nekobt.to/torrents/${t.id}` : "",
            magnetLink: undefined,
            downloadUrl: t.magnet || "",
            infoHash: t.infohash ? t.infohash.toLowerCase() : undefined,
            resolution,
            isBatch: !!t.batch,
            episodeNumber,
            releaseGroup: (Array.isArray(t.groups) && t.groups.length > 0) ? t.groups[0].display_name : "",
            isBestRelease: false,
            confirmed: (episodeNumber !== -1 || !!t.batch),
        }
    }

    private formatBytes(bytes: number, decimals: number = 2): string {
        if (bytes === 0) return "0 Bytes"
        const k = 1024
        const dm = decimals < 0 ? 0 : decimals
        const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i]
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

        const normalizedCandidates = candidates.map(normalize)

        const passed: AnimeTorrent[] = []
        const rejected: string[] = []

        for (const t of results) {
            const norm = normalize(t.name)

            // Check if any candidate title appears as a substring in the torrent name
            let pass = false
            for (const candidate of normalizedCandidates) {
                if (norm.includes(candidate)) {
                    pass = true
                    break
                }
            }

            // Fallback: sliding window � check if 3+ consecutive words of any candidate appear in order
            if (!pass) {
                for (const candidate of normalizedCandidates) {
                    const words = candidate.split(" ").filter(w => w.length >= 3)
                    if (words.length < 3) continue
                    // Check all windows of 3 consecutive words
                    for (let i = 0; i <= words.length - 3; i++) {
                        const window = words.slice(i, i + 3)
                        // All 3 consecutive words must appear in the torrent name
                        if (window.every(w => norm.includes(w))) {
                            pass = true
                            break
                        }
                    }
                    if (pass) break
                }
            }

            if (pass) {
                passed.push(t)
            } else {
                rejected.push(t.name)
            }
        }

        // Safety: if fewer than 2 passed, return unfiltered
        if (passed.length < 2) {
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
