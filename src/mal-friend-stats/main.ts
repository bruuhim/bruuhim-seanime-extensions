/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register((ctx) => {

        // ──────────────────────────────── Types ────────────────────────────────

        type MediaType = "anime" | "manga"

        interface FriendEntry {
            status: string
            score: number
            progress: number
            total?: number
            user: {
                name: string
                avatar?: string
            }
        }

        interface MalFriend {
            username: string
            avatar: string
        }

        // L1: in-memory fast path — lives only while this plugin VM is alive.
        const memoryCache = new Map<string, { value: any, complete?: boolean, expiresAt: number }>()

        // ──────────────────────────────── Constants ────────────────────────────────

        const PLUGIN_VERSION = "1.0.3"

        const FRIENDS_LIST_TTL_MS = 60 * 60 * 1000  // 1h
        const LIST_TTL_MS = 60 * 60 * 1000          // 1h
        const RESULT_TTL_MS = 24 * 60 * 60 * 1000   // 24h
        const MALID_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d

        // ──────────────────────────────── Cache helpers ($storage-backed) ──────────
        // Two layers:
        //   L1: in-memory Map — fast path while this plugin VM is alive
        //   L2: $storage — persistent across navigation / restarts (requires "storage" permission)
        // Persistent entries are stored as { v, c, e }: v = value, c = complete flag, e = expiry (ms).

        function cacheGet(key: string): { value: any, complete?: boolean } | null {
            const now = Date.now()
            const mem = memoryCache.get(key)
            if (mem && mem.expiresAt > now) {
                return { value: mem.value, complete: mem.complete }
            }
            try {
                const stored = $storage.get<{ v?: any, c?: boolean, e?: number }>(key)
                if (stored && stored.e && stored.e > now) {
                    return { value: stored.v, complete: stored.c }
                }
            } catch (err) {
                // storage unavailable — fall back to memory-only caching
            }
            return null
        }

        function cacheSet(key: string, value: any, ttlMs: number, complete?: boolean) {
            const expiresAt = Date.now() + ttlMs
            memoryCache.set(key, { value, complete, expiresAt })
            try {
                $storage.set(key, { v: value, c: complete, e: expiresAt })
            } catch (err) {
                // ignore — memory cache still provides a fast path for this session
            }
        }

        // ──────────────────────────────── Version-based cache reset ──────────────
        // When the plugin updates (version bump), wipe all persistent caches so
        // users never see results computed by an older build.
        try {
            const storedVer = $storage.get<{ v?: string }>("mfs:version")
            if (storedVer && storedVer.v !== PLUGIN_VERSION) {
                $storage.clear()
                $storage.set("mfs:version", { v: PLUGIN_VERSION })
            } else if (!storedVer) {
                $storage.set("mfs:version", { v: PLUGIN_VERSION })
            }
        } catch (err) {
            // storage unavailable — skip version handling
        }

        // ──────────────────────────────── Helpers ────────────────────────────────

        function mapMALStatus(statusNum: number, mediaType: MediaType): string {
            switch (statusNum) {
                case 1:  return mediaType === "manga" ? "READING" : "CURRENT"
                case 2:  return "COMPLETED"
                case 3:  return "PAUSED"
                case 4:  return "DROPPED"
                case 6:  return "PLANNING"
                default: return "PLANNING"
            }
        }

        // Resolves an AniList media ID to its MAL ID. Async + timeout-bounded so a
        // slow/unreachable AniList can never hang the plugin. Cached for 7 days.
        async function getMalMediaId(anilistId: number): Promise<number | null> {
            const cacheKey = `mfs:malid:${anilistId}`
            const cached = cacheGet(cacheKey)
            if (cached) {
                return cached.value
            }

            const token = $database.anilist.getToken()
            try {
                const query = `query ($id: Int) { Media(id: $id) { idMal } }`
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                }
                if (token) {
                    headers["Authorization"] = `Bearer ${token}`
                }
                const res = await ctx.fetch("https://graphql.anilist.co", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ query, variables: { id: anilistId } }),
                    timeout: 10,
                })
                if (!res || !res.ok) {
                    return null
                }
                const data = res.json<{ data?: { Media?: { idMal?: number | null } } }>()
                const malId = data?.data?.Media?.idMal ?? null
                if (malId) {
                    cacheSet(cacheKey, malId, MALID_TTL_MS)
                }
                return malId
            } catch (err) {
                return null
            }
        }

        function getMALUsername(): string | null {
            const malUser = "{{malUsername}}"
            if (!malUser || malUser.startsWith("{{")) {
                return null
            }
            return malUser
        }

        async function fetchFriendList(malUsername: string): Promise<MalFriend[]> {
            const cacheKey = `mfs:friends:${malUsername}`

            const cached = cacheGet(cacheKey)
            if (cached) {
                return cached.value
            }

            const friendsUrl = `https://myanimelist.net/profile/${encodeURIComponent(malUsername)}/friends`

            let friendsHtml = ""
            try {
                const friendsHtmlResp = await ctx.fetch(friendsUrl, { timeout: 15 })
                if (!friendsHtmlResp || !friendsHtmlResp.ok) {
                    return []
                }
                friendsHtml = friendsHtmlResp.text()
            } catch (err) {
                return []
            }

            const parts = friendsHtml.split('<div class="boxlist col-3">')
            const parsed: MalFriend[] = []

            for (let i = 1; i < parts.length; i++) {
                const part = parts[i]
                const userMatch = part.match(/href="https:\/\/myanimelist\.net\/profile\/([^"/?#\s]+)"/)
                if (userMatch) {
                    const username = decodeURIComponent(userMatch[1])
                    let avatar = ""
                    const dataSrcMatch = part.match(/data-src="([^"]+)"/)
                    if (dataSrcMatch) {
                        avatar = dataSrcMatch[1]
                    } else {
                        const srcMatch = part.match(/src="([^"]+)"/)
                        if (srcMatch && !srcMatch[1].endsWith('spacer.gif')) {
                            avatar = srcMatch[1]
                        }
                    }
                    parsed.push({ username, avatar })
                }
            }

            cacheSet(cacheKey, parsed, FRIENDS_LIST_TTL_MS)
            return parsed
        }

        // Fetches a single friend's anime/manga list (paginated only when necessary).
        // Returns [] on failure so the caller can continue with the other friends.
        async function fetchFriendListData(friend: MalFriend, malId: number, mediaType: MediaType): Promise<any[]> {
            const cacheKey = `mfs:${mediaType}:${friend.username.toLowerCase()}`

            const idField = mediaType === "manga" ? "manga_id" : "anime_id"

            const cached = cacheGet(cacheKey)
            if (cached) {
                // Target already present in the cached list → done.
                const hit = (cached.value || []).find((e: any) => e[idField] === malId)
                if (hit) {
                    return cached.value
                }
                // Only trust a cache entry that covers the friend's ENTIRE list.
                if (cached.complete) {
                    return cached.value
                }
                // Incomplete + target not present → re-fetch (list may be truncated).
            }

            let listData: any[] = []
            let offset = 0
            let complete = false
            try {
                while (offset < 900) {
                    const listUrl = `https://myanimelist.net/${mediaType}list/${encodeURIComponent(friend.username)}/load.json?status=7&offset=${offset}`
                    const listResp = await ctx.fetch(listUrl, { timeout: 15 })
                    if (!listResp || !listResp.ok) {
                        break
                    }

                    const pageData = listResp.json<any[]>()
                    if (!pageData || !pageData.length) {
                        // Reached the end of the friend's list.
                        complete = true
                        break
                    }

                    listData = listData.concat(pageData)

                    // Early exit once we found the target media, or when the page
                    // was not completely full (no more pages exist).
                    const found = listData.some(e => e[idField] === malId)
                    if (found || pageData.length < 300) {
                        complete = pageData.length < 300
                        break
                    }

                    offset += 300
                }

                cacheSet(cacheKey, listData, LIST_TTL_MS, complete)
            } catch (err) {
                // Silently ignore — caller continues with the other friends.
            }

            return listData
        }

        async function fetchMalFriends(malId: number, malUsername: string, mediaType: MediaType): Promise<FriendEntry[]> {
            const friends = await fetchFriendList(malUsername)

            const results: FriendEntry[] = []

            // Fetch ALL friend lists in parallel — no staggering, no artificial
            // delays, no friend cap. Every friend is checked so no one is missed.
            const lists = await Promise.all(
                friends.map((friend) => fetchFriendListData(friend, malId, mediaType))
            )

            const idField = mediaType === "manga" ? "manga_id" : "anime_id"
            const progressField = mediaType === "manga" ? "num_read_chapters" : "num_watched_episodes"
            const totalField = mediaType === "manga" ? "manga_num_chapters" : "anime_num_episodes"

            for (let i = 0; i < friends.length; i++) {
                const friend = friends[i]
                const listData = lists[i] || []
                const match = listData.find(e => e[idField] === malId)
                if (match) {
                    results.push({
                        status: mapMALStatus(match.status, mediaType),
                        score: (match.score || 0) * 10,
                        progress: match[progressField] || 0,
                        total: match[totalField] ?? undefined,
                        user: {
                            name: friend.username,
                            avatar: friend.avatar || undefined,
                        },
                    })
                }
            }

            return results
        }

        // ──────────────────────────────── Plugin Entry ────────────────────────────────

        const mediaId = ctx.state(0)
        const mediaType = ctx.state<MediaType | null>(null)
        const friends = ctx.state<FriendEntry[]>([])
        const loading = ctx.state(false)
        const configured = ctx.state(false)

        const animePanel = ctx.newWebview({
            slot: "after-anime-entry-episode-list",
            fullWidth: true,
            autoHeight: true,
        })

        const mangaPanel = ctx.newWebview({
            slot: "after-manga-entry-chapter-list",
            fullWidth: true,
            autoHeight: true,
        })

        // Both panels share the same state and content — only the slot differs.
        animePanel.channel.sync("friends", friends)
        animePanel.channel.sync("loading", loading)
        animePanel.channel.sync("configured", configured)
        animePanel.channel.sync("mediaType", mediaType)
        mangaPanel.channel.sync("friends", friends)
        mangaPanel.channel.sync("loading", loading)
        mangaPanel.channel.sync("configured", configured)
        mangaPanel.channel.sync("mediaType", mediaType)

        // ── Open profile links ──
        const openUrl = ctx.state("")
        animePanel.channel.on("open-profile", (url: string) => {
            openUrl.set(url)
        })
        mangaPanel.channel.on("open-profile", (url: string) => {
            openUrl.set(url)
        })

        ctx.effect(() => {
            const url = openUrl.get()
            if (!url) return
            try {
                if ($os.platform === "windows") {
                    $os.cmd("cmd", "/c", "start", url).start()
                } else if ($os.platform === "darwin") {
                    $os.cmd("open", url).start()
                } else {
                    $os.cmd("xdg-open", url).start()
                }
            } catch (err) {
                // Silently ignore — unable to open the URL.
            }
            openUrl.set("")
        }, [openUrl])

        // ── Track navigation ──
        ctx.screen.onNavigate((e) => {
            let type: MediaType | null = null
            if (e.pathname === "/entry" && !!e.searchParams.id) {
                type = "anime"
            } else if (e.pathname.startsWith("/manga/entry") && !!e.searchParams.id) {
                type = "manga"
            }

            const id = type ? parseInt(e.searchParams.id) : 0
            mediaId.set(id)
            mediaType.set(type)

            if (!type) {
                animePanel.hide()
                mangaPanel.hide()
                return
            }

            // Show the loading state as soon as we land on an entry page so the
            // user always sees feedback while the plugin is working.
            friends.set([])
            loading.set(true)
            if (type === "anime") {
                animePanel.show()
                mangaPanel.hide()
            } else {
                mangaPanel.show()
                animePanel.hide()
            }
        })
        ctx.screen.loadCurrent()

        // ── Main effect ──
        // All network work happens inside the async IIFE so the effect function
        // itself returns immediately. This keeps Seanime's infinite-loop guard
        // (effectStack) from ever flagging this effect, and the navToken guard
        // discards stale runs when the user navigates mid-fetch.
        let navToken = 0
        ctx.effect(() => {
            const id = mediaId.get()
            const type = mediaType.get()
            if (!id || !type) {
                friends.set([])
                loading.set(false)
                animePanel.hide()
                mangaPanel.hide()
                return
            }

            const panel = type === "anime" ? animePanel : mangaPanel

            const malUser = getMALUsername()
            if (!malUser) {
                friends.set([])
                configured.set(false)
                loading.set(false)
                panel.hide()
                return
            }
            configured.set(true)

            // Show the panel with the loading spinner immediately, before any
            // network work happens.
            loading.set(true)
            panel.show()

            const myToken = ++navToken

            // Failsafe: never let the spinner stay stuck. If nothing has
            // finished after 45s, give up gracefully.
            const cancelFailsafe = ctx.setTimeout(() => {
                if (myToken === navToken) {
                    loading.set(false)
                }
            }, 45 * 1000)

            ;(async () => {
                try {
                    // Resolve the MAL ID (async + timeout-bounded, cached 7 days).
                    const malId = await getMalMediaId(id)
                    if (myToken !== navToken) return
                    if (!malId) {
                        friends.set([])
                        panel.hide()
                        return
                    }

                    const cacheKey = `mfs:result:${type}:${malUser}:${malId}`
                    const cached = cacheGet(cacheKey)

                    if (cached) {
                        // Instant path: cached answer — no need to show the spinner.
                        friends.set(cached.value)
                        if (cached.value.length > 0) {
                            panel.show()
                        } else {
                            panel.hide()
                        }
                        return
                    }

                    const entries = await fetchMalFriends(malId, malUser, type)
                    if (myToken !== navToken) return
                    cacheSet(cacheKey, entries, RESULT_TTL_MS)
                    friends.set(entries)
                    if (entries.length > 0) {
                        panel.show()
                    } else {
                        panel.hide()
                    }
                } catch (err) {
                    if (myToken !== navToken) return
                    friends.set([])
                    panel.hide()
                } finally {
                    if (myToken === navToken) {
                        loading.set(false)
                    }
                    cancelFailsafe()
                }
            })()
        }, [mediaId, mediaType])

        // ── UI (shared by both panels) ──
        const panelContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    html { color-scheme: dark; overflow: hidden; }
    body { background: transparent; color: #e2e8f0; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 0; }

    .heading { font-size: 1.3rem; font-weight: 600; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    .heading .icon-svg { flex-shrink: 0; }
    .heading .badge { font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #2e51a2; color: #fff; margin-left: 4px; }

    .list { display: flex; flex-wrap: wrap; gap: 9px; }

    .row { display: flex; align-items: center; gap: 12px; padding: 9px 15px; background: rgba(255,255,255,0.04); border-radius: 12px; text-decoration: none; color: inherit; cursor: pointer; }
    .row:hover { background: rgba(255,255,255,0.08); }

    .avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: rgba(255,255,255,0.08); }
    .name { font-size: 1.3rem; max-width: 270px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .episode { font-size: 1.2rem; opacity: 0.8; }
    .score { font-size: 1.2rem; font-weight: 600; }
    .status { font-size: 1.1rem; font-weight: 600; padding: 3px 12px; border-radius: 999px; color: #10161f; }

    .loading { display: flex; align-items: center; gap: 10px; padding: 12px 15px; color: #8892a4; font-size: 1.2rem; }
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.12); border-top-color: #8892a4; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .empty { color: #8892a4; padding: 12px 15px; font-size: 1.2rem; }
    .note { color: #5a6476; padding: 12px 15px; font-size: 1.1rem; }
</style>
</head>
<body>
<div id="app"></div>
<script>
    var STATUS_LABEL = {"READING":"Reading","CURRENT":"Watching","PLANNING":"Planning","COMPLETED":"Completed","DROPPED":"Dropped","PAUSED":"On Hold","REPEATING":"Rewatching"}
    var STATUS_COLOR = {"READING":"#3db4f2","CURRENT":"#3db4f2","PLANNING":"#f2c94c","COMPLETED":"#4cd137","DROPPED":"#e84118","PAUSED":"#a4a4a4","REPEATING":"#9b59b6"}

    function scoreColor(s) {
        if (s >= 80) return "#4cd137"
        if (s >= 60) return "#c9d137"
        if (s >= 40) return "#f2994a"
        return "#e84118"
    }

    function renderRow(entry) {
        var username = (entry.user && entry.user.name) || ""
        var url = "https://myanimelist.net/profile/" + encodeURIComponent(username)

        var row = document.createElement("a")
        row.className = "row"
        row.href = url
        row.target = "_blank"
        row.rel = "noopener noreferrer"
        row.addEventListener("click", function (e) {
            e.preventDefault()
            window.webview.send("open-profile", url)
        })

        var img = document.createElement("img")
        img.className = "avatar"
        img.src = (entry.user && entry.user.avatar) || ""
        img.onerror = function () { this.style.display = "none" }
        row.appendChild(img)

        var name = document.createElement("div")
        name.className = "name"
        name.textContent = username || "Unknown"
        row.appendChild(name)

        if (entry.progress > 0 && entry.status !== "COMPLETED") {
            var ep = document.createElement("div")
            ep.className = "episode"
            var prefix = _mediaType === "manga" ? "Ch " : "Ep "
            ep.textContent = prefix + entry.progress + (entry.total ? "/" + entry.total : "")
            row.appendChild(ep)
        }

        if (entry.score > 0) {
            var s = document.createElement("div")
            s.className = "score"
            s.style.color = scoreColor(entry.score)
            s.textContent = String(Math.round(entry.score) / 10)
            row.appendChild(s)
        }

        var st = document.createElement("div")
        st.className = "status"
        st.style.background = STATUS_COLOR[entry.status] || "#a4a4a4"
        st.textContent = STATUS_LABEL[entry.status] || entry.status
        row.appendChild(st)

        return row
    }

    function render(friends, loading, configured) {
        var app = document.getElementById("app")
        app.innerHTML = ""

        if (!configured) {
            var note = document.createElement("div")
            note.className = "note"
            note.textContent = "Set your MAL username in settings"
            app.appendChild(note)
            return
        }

        if (loading) {
            var loader = document.createElement("div")
            loader.className = "loading"
            var sp = document.createElement("div")
            sp.className = "spinner"
            loader.appendChild(sp)
            loader.appendChild(document.createTextNode("Loading MAL friends\u2026"))
            app.appendChild(loader)
            return
        }

        if (!friends || friends.length === 0) {
            var empty = document.createElement("div")
            empty.className = "empty"
            empty.textContent = _mediaType === "manga"
                ? "No MAL friends found for this manga"
                : "No MAL friends found for this anime"
            app.appendChild(empty)
            return
        }

        // Heading with MAL icon
        var heading = document.createElement("div")
        heading.className = "heading"
        heading.innerHTML = '<svg class="icon-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#2e51a2"/><circle cx="8.5" cy="9.5" r="1.5" fill="white"/><circle cx="15.5" cy="9.5" r="1.5" fill="white"/><path d="M7 14.5c1.5 2.5 4.5 2.5 6 0" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>'
        heading.appendChild(document.createTextNode("MAL Friends"))
        var badge = document.createElement("span")
        badge.className = "badge"
        badge.textContent = "MAL"
        heading.appendChild(badge)
        app.appendChild(heading)

        var list = document.createElement("div")
        list.className = "list"
        friends.forEach(function (f) { list.appendChild(renderRow(f)) })
        app.appendChild(list)
    }

    var _friends = []
    var _loading = false
    var _configured = false
    var _mediaType = "anime"

    function rerender() { render(_friends, _loading, _configured) }

    window.webview.on("friends", function (d) { _friends = d || []; rerender() })
    window.webview.on("loading", function (d) { _loading = !!d; rerender() })
    window.webview.on("configured", function (d) { _configured = !!d; rerender() })
    window.webview.on("mediaType", function (d) { _mediaType = d === "manga" ? "manga" : "anime"; rerender() })
</script>
</body>
</html>
        `
        animePanel.setContent(() => panelContent)
        mangaPanel.setContent(() => panelContent)
    })
}