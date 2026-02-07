/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://azoramoon.com"
    private apiUrl: string = "https://api.azoramoon.com/api"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
        try {
            const resp = await fetch(url, {
                ...opts,
                headers: {
                    "User-Agent": this.userAgent,
                    "Referer": this.api + "/",
                    ...opts.headers,
                }
            })
            return resp
        } catch (e) {
            throw e
        }
    }

    async search({ query }: QueryOptions): Promise<SearchResult[]> {
        try {
            // Using the API for search is much more reliable
            const url = `${this.apiUrl}/query?searchTerm=${encodeURIComponent(query)}&perPage=20`
            const resp = await this.fetch(url)
            const data = await resp.json()

            if (!data || !data.posts) return []

            return data.posts.map((post: any) => ({
                id: post.slug,
                title: post.postTitle,
                image: post.featuredImage || ""
            }))
        } catch (e) {
            console.error("AzoraMoon search error:", e)
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try {
            // Fetch series details including chapters from the API
            const url = `${this.apiUrl}/query?search=${encodeURIComponent(mangaId)}`
            const resp = await this.fetch(url)
            const data = await resp.json()

            if (!data || !data.posts) return []

            // Find the exact post matching the slug
            const post = data.posts.find((p: any) => p.slug === mangaId)
            if (!post || !post.chapters) return []

            const chapters: ChapterDetails[] = []
            
            post.chapters.forEach((ch: any) => {
                // Skip locked chapters
                if (ch.isLocked) return

                chapters.push({
                    id: `${mangaId}$${ch.slug}`,
                    url: `${this.api}/series/${mangaId}/${ch.slug}`,
                    title: `الفصل ${ch.number}`,
                    chapter: ch.number.toString(),
                    index: 0
                })
            })

            // Sort chapters by number descending
            chapters.sort((a, b) => parseFloat(b.chapter) - parseFloat(a.chapter))
            chapters.forEach((chapter, index) => {
                chapter.index = index
            })

            return chapters
        } catch (e) {
            console.error("AzoraMoon findChapters error:", e)
            return []
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        try {
            const [mangaId, chapterSlug] = chapterId.split("$")
            const url = `${this.api}/series/${mangaId}/${chapterSlug}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            const pages: ChapterPage[] = []
            
            // Selector from research: .comic-images-wrapper img
            const images = $(".comic-images-wrapper img")
            
            images.each((i: number, el: any) => {
                let src = el.attr("src") || el.attr("data-src") || el.attr("data-lazy-src")
                if (src) {
                    src = src.trim()
                    if (!src.startsWith("http")) {
                        src = (this.api + (src.startsWith("/") ? "" : "/") + src).replace(/([^:]\/)\/+/g, "$1")
                    }
                    
                    pages.push({
                        url: src,
                        index: i,
                        headers: {
                            "Referer": this.api + "/"
                        }
                    })
                }
            })

            return pages
        } catch (e) {
            console.error("AzoraMoon findChapterPages error:", e)
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
