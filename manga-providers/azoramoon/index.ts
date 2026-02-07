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
                const synonyms = post.alternativeTitles 
                    ? post.alternativeTitles.split(/[\s\t]+/).filter((s: string) => s.length > 2)
                    : []

                const year = post.createdAt ? new Date(post.createdAt).getFullYear() : undefined

                return {
                    // ID format: ID|Slug to be used in findChapters
                    id: `${post.id}|${post.slug}`,
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
        console.log(`[AzoraMoon] findChapters for: "${mangaId}"`)
        try {
            let numericId: string | null = null
            let mangaSlug: string | null = null

            // Support both new "ID|Slug" and old "Slug" format
            if (mangaId.includes("|")) {
                const parts = mangaId.split("|")
                numericId = parts[0]
                mangaSlug = parts[1]
                console.log(`[AzoraMoon] Parsed ID: ${numericId}, Slug: ${mangaSlug}`)
            } else {
                mangaSlug = mangaId
                console.log(`[AzoraMoon] Slug provided: ${mangaSlug}. Attempting to resolve numeric ID...`)
                // Try to find the numeric ID by searching for the slug (as words)
                const queryTitle = mangaSlug.replace(/-/g, " ")
                const searchResp = await this.fetch(`${this.apiUrl}/query?searchTerm=${encodeURIComponent(queryTitle)}`)
                const searchData = await searchResp.json()
                const post = searchData?.posts?.find((p: any) => p.slug === mangaSlug)
                if (post) {
                    numericId = post.id.toString()
                    console.log(`[AzoraMoon] Resolved numeric ID: ${numericId}`)
                }
            }

            if (!numericId) {
                console.error(`[AzoraMoon] Could not resolve numeric ID for: "${mangaId}"`)
                return []
            }

            const url = `${this.apiUrl}/chapters?postId=${numericId}`
            const resp = await this.fetch(url)
            const chaptersData = await resp.json()

            // The API returns { post: { chapters: [] }, totalChapterCount: ... }
            const rawChapters = chaptersData.post?.chapters || (Array.isArray(chaptersData) ? chaptersData : [])

            if (!rawChapters || rawChapters.length === 0) {
                console.warn(`[AzoraMoon] No chapters found for ID: ${numericId}`)
                return []
            }

            console.log(`[AzoraMoon] Total chapters found in API for ID ${numericId}: ${rawChapters.length}`)

            const chapters: ChapterDetails[] = []
            
            rawChapters.forEach((ch: any) => {
                // isLocked: true means requires payment or timer
                // unlockAt: if present and in future, it's locked
                const isLocked = ch.isLocked || (ch.unlockAt && new Date(ch.unlockAt) > new Date())
                
                if (isLocked) {
                    return
                }

                // If we don't have mangaSlug yet (rare), try to get it from the chapter info
                if (!mangaSlug && ch.mangaPost && ch.mangaPost.slug) {
                    mangaSlug = ch.mangaPost.slug
                }

                chapters.push({
                    id: `${mangaSlug}$${ch.slug}`,
                    url: `${this.api}/series/${mangaSlug}/${ch.slug}`,
                    title: ch.title || `الفصل ${ch.number}`,
                    chapter: ch.number.toString(),
                    index: 0
                })
            })

            console.log(`[AzoraMoon] Free chapters available: ${chapters.length}`)

            // Sort ascending by chapter number
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
        console.log(`[AzoraMoon] findChapterPages for: "${chapterId}"`)
        try {
            const [mangaSlug, chapterSlug] = chapterId.split("$")
            const url = `${this.api}/series/${mangaSlug}/${chapterSlug}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const pages: ChapterPage[] = []

            // Extract images using regex from the whole HTML source
            // This is more robust as AzoraMoon uses Next.js App Router with RSC/push calls
            // where images might not be in the initial DOM or are lazy-loaded without data-src.
            const imgRegex = /https:\/\/storage\.azoramoon\.com\/WP-manga\/data\/[^\s"']+\.(?:webp|jpg|png|jpeg)/gi
            const matches = html.match(imgRegex)
            
            if (matches && matches.length > 0) {
                const uniqueImages = [...new Set(matches)]
                uniqueImages.forEach((url, i) => {
                    pages.push({
                        url: url,
                        index: i,
                        headers: {
                            "Referer": this.api + "/"
                        }
                    })
                })
            }

            if (pages.length === 0) {
                console.warn("[AzoraMoon] Regex extraction failed, falling back to DOM parsing")
                const $ = LoadDoc(html)
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
            }

            console.log(`[AzoraMoon] Extracted ${pages.length} pages`)
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
