/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://mangatuk.com"
    private apiUrl: string = "https://api.mangatuk.com/api"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: Record<string, any> = {}): Promise<Response> {
        console.info(`[MangaTuk] fetch: ${url}`)
        try {
            const resp = await fetch(url, {
                ...opts,
                headers: {
                    "User-Agent": this.userAgent,
                    "Referer": this.api + "/",
                    ...(opts.headers || {}),
                }
            })
            return resp
        } catch (e) {
            console.error(`[MangaTuk] fetch error:`, e)
            throw e
        }
    }

    async search(opts: Record<string, any>): Promise<SearchResult[]> {
        const query = opts?.query || ""
        console.info(`[MangaTuk] search("${query}")`)
        try {
            const url = `${this.apiUrl}/catalog/search?q=${encodeURIComponent(query)}&limit=20`

            const resp = await this.fetch(url)
            if (!resp.ok) {
                console.error(`[MangaTuk] search response NOT OK: ${resp.status}`)
                const text = await resp.text()
                console.error(`[MangaTuk] search error body:`, text.substring(0, 500))
                return []
            }

            const text = await resp.text()

            let data: any
            try {
                data = JSON.parse(text)
            } catch (parseErr) {
                console.error(`[MangaTuk] search JSON parse failed:`, parseErr)
                return []
            }

            if (!data || !data.data || !Array.isArray(data.data)) {
                console.warn(`[MangaTuk] search no data.data array found, returning []`)
                return []
            }

            const results = data.data.map((item: any) => {
                const synonyms = item.associatedNames
                    ? item.associatedNames.split("\n").filter((s: string) => s.trim().length > 0)
                    : undefined

                const mapped = {
                    id: item.slug,
                    title: item.title,
                    image: item.coverImage || "",
                    synonyms: synonyms,
                }
                return mapped
            })

            console.info(`[MangaTuk] search -> ${results.length} results`)
            return results
        } catch (e) {
            console.error(`[MangaTuk] search error:`, e)
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        console.info(`[MangaTuk] findChapters("${mangaId}")`)
        try {
            const url = `${this.apiUrl}/catalog/series/by-slug/${mangaId}`

            const resp = await this.fetch(url)
            if (!resp.ok) {
                console.error(`[MangaTuk] findChapters response NOT OK: ${resp.status}`)
                const text = await resp.text()
                console.error(`[MangaTuk] findChapters error body:`, text.substring(0, 500))
                return []
            }

            const text = await resp.text()

            let data: any
            try {
                data = JSON.parse(text)
            } catch (parseErr) {
                console.error(`[MangaTuk] findChapters JSON parse failed:`, parseErr)
                return []
            }

            if (!data || !data.chapters || !Array.isArray(data.chapters)) {
                console.warn(`[MangaTuk] findChapters no chapters array found`)
                return []
            }

            const chapters: ChapterDetails[] = data.chapters.map((ch: any) => {
                const rawNum = ch.number
                const chapterNum = parseFloat(rawNum).toString()
                const mapped = {
                    id: `${mangaId}$${ch.slug}`,
                    url: `${this.api}/series/${mangaId}/${ch.slug}`,
                    title: `Chapter ${chapterNum}`,
                    chapter: chapterNum,
                    index: 0,
                    scanlator: ch.uploadedByTeamName || undefined,
                }
                return mapped
            })

            chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
            chapters.forEach((chapter, index) => {
                chapter.index = index
            })

            console.info(`[MangaTuk] findChapters -> ${chapters.length} chapters`)
            return chapters
        } catch (e) {
            console.error(`[MangaTuk] findChapters error:`, e)
            return []
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        console.info(`[MangaTuk] findChapterPages("${chapterId}")`)
        try {
            const parts = chapterId.split("$")
            const mangaSlug = parts[0]
            const chapterSlug = parts[1]

            if (!mangaSlug || !chapterSlug) {
                console.error(`[MangaTuk] findChapterPages invalid chapterId format: ${chapterId}`)
                return []
            }

            const url = `${this.apiUrl}/catalog/chapters/by-slug/${mangaSlug}/${chapterSlug}`

            const resp = await this.fetch(url)
            if (!resp.ok) {
                console.error(`[MangaTuk] findChapterPages response NOT OK: ${resp.status}`)
                const text = await resp.text()
                console.error(`[MangaTuk] findChapterPages error body:`, text.substring(0, 500))
                return []
            }

            const text = await resp.text()

            let data: any
            try {
                data = JSON.parse(text)
            } catch (parseErr) {
                console.error(`[MangaTuk] findChapterPages JSON parse failed:`, parseErr)
                return []
            }

            if (!data || !data.pages || !Array.isArray(data.pages)) {
                console.warn(`[MangaTuk] findChapterPages no pages array found`)
                return []
            }

            const pages = data.pages.map((page: any, i: number) => ({
                url: page.imageUrl,
                index: i,
                headers: {
                    "Referer": this.api + "/"
                }
            }))

            console.info(`[MangaTuk] findChapterPages -> ${pages.length} pages`)
            return pages
        } catch (e) {
            console.error(`[MangaTuk] findChapterPages error:`, e)
            return []
        }
    }

    getSettings(): Settings {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }
}
