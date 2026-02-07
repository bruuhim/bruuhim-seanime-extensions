/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://azoramoon.com"
    private apiUrl: string = "https://api.azoramoon.com/api"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
        console.log(`[AzoraMoon] Fetching: ${url}`)
        try {
            const resp = await fetch(url, {
                ...opts,
                headers: {
                    "User-Agent": this.userAgent,
                    "Referer": this.api + "/",
                    ...opts.headers,
                }
            })
            console.log(`[AzoraMoon] Response Status: ${resp.status} for ${url}`)
            return resp
        } catch (e) {
            console.error(`[AzoraMoon] Fetch Error for ${url}:`, e)
            throw e
        }
    }

    async search({ query }: QueryOptions): Promise<SearchResult[]> {
        console.log(`[AzoraMoon] Search Query: "${query}"`)
        try {
            const url = `${this.apiUrl}/query?searchTerm=${encodeURIComponent(query)}&perPage=20`
            const resp = await this.fetch(url)
            const data = await resp.json()

            if (!data || !data.posts) {
                console.warn(`[AzoraMoon] No posts found for query: "${query}"`)
                return []
            }

            console.log(`[AzoraMoon] Found ${data.posts.length} results`)

            return data.posts.map((post: any) => {
                // Map alternativeTitles to synonyms for better matching in Seanime
                const synonyms = post.alternativeTitles 
                    ? post.alternativeTitles.split(/[\s\t]+/).filter((s: string) => s.length > 2)
                    : []

                const year = post.createdAt ? new Date(post.createdAt).getFullYear() : undefined

                return {
                    id: post.slug,
                    title: post.postTitle,
                    image: post.featuredImage || "",
                    synonyms: synonyms,
                    year: year
                }
            })
        } catch (e) {
            console.error("[AzoraMoon] search error:", e)
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        console.log(`[AzoraMoon] Fetching chapters for MangaID (Slug): "${mangaId}"`)
        try {
            // Using searchTerm with the exact slug is usually very reliable on this API
            const url = `${this.apiUrl}/query?searchTerm=${encodeURIComponent(mangaId)}`
            const resp = await this.fetch(url)
            const data = await resp.json()

            if (!data || !data.posts) {
                console.warn(`[AzoraMoon] No post found for MangaID: "${mangaId}"`)
                return []
            }

            const post = data.posts.find((p: any) => p.slug === mangaId)
            if (!post) {
                console.warn(`[AzoraMoon] Could not find exact matching slug for: "${mangaId}" in results`)
                return []
            }

            if (!post.chapters) {
                console.warn(`[AzoraMoon] No chapters array found for: "${mangaId}"`)
                return []
            }

            console.log(`[AzoraMoon] Total chapters found in API for "${mangaId}": ${post.chapters.length}`)

            const chapters: ChapterDetails[] = []
            
            post.chapters.forEach((ch: any) => {
                // Skip locked chapters
                // isLocked: true means requires payment or timer
                // unlockAt: if present, usually means it's locked until then
                const isLocked = ch.isLocked || (ch.unlockAt && new Date(ch.unlockAt) > new Date())
                
                if (isLocked) {
                    // console.log(`[AzoraMoon] Skipping locked chapter: ${ch.number}`)
                    return
                }

                chapters.push({
                    id: `${mangaId}$${ch.slug}`,
                    url: `${this.api}/series/${mangaId}/${ch.slug}`,
                    title: `الفصل ${ch.number}`,
                    chapter: ch.number.toString(),
                    index: 0
                })
            })

            console.log(`[AzoraMoon] Free chapters available after filtering: ${chapters.length}`)

            // Sort chapters by number descending (provider expectations vary, but descending is common for UI)
            // Note: Some systems expect ascending. If Seanime expects ascending, we should reverse.
            // Based on example: "The chapters should be sorted in ascending order (0, 1, ...)"
            // So we sort ascending by chapter number.
            chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
            
            chapters.forEach((chapter, index) => {
                chapter.index = index
            })

            return chapters
        } catch (e) {
            console.error("[AzoraMoon] findChapters error:", e)
            return []
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        console.log(`[AzoraMoon] Fetching pages for ChapterID: "${chapterId}"`)
        try {
            const [mangaId, chapterSlug] = chapterId.split("$")
            const url = `${this.api}/series/${mangaId}/${chapterSlug}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            const pages: ChapterPage[] = []
            const images = $(".comic-images-wrapper img")
            
            console.log(`[AzoraMoon] Found ${images.length} potential images in HTML`)

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

            console.log(`[AzoraMoon] Successfully extracted ${pages.length} pages`)
            return pages
        } catch (e) {
            console.error("[AzoraMoon] findChapterPages error:", e)
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
