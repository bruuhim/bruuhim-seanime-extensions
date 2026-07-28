/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register((ctx) => {

        // ──────────────────────────────── Types ────────────────────────────────

        interface FriendEntry {
            status: string
            score: number
            progress: number
            totalEpisodes?: number
            user: {
                name: string
                avatar?: string
            }
        }

        interface JikanUser {
            username: string
            images?: { webp?: { image_url?: string } }
        }

        interface JikanFriendEntry {
            user: JikanUser
        }

        interface JikanFriendsResponse {
            data: JikanFriendEntry[]
        }

        interface JikanAnimeEntry {
            anime: {
                mal_id: number
                episodes?: number
            }
            status: string
            score: number
            episodes_watched: number
        }

        interface JikanListResponse {
            data: JikanAnimeEntry[]
        }

        // ──────────────────────────────── Constants ────────────────────────────────

        const JIKAN_BASE = "https://api.jikan.moe/v4"
        const JIKAN_DELAY_MS = 400
        const MAX_FRIENDS = 15
        const CACHE_TTL_MS = 10 * 60 * 1000  // 10 min
        let lastJikanCall = 0

        // ──────────────────────────────── Jikan API ────────────────────────────────

        function jikanGet<T>(path: string): T | null {
            console.log(`mal-friend-stats: jikanGet called for path: ${path}`)
            for (let attempt = 0; attempt < 2; attempt++) {
                const now = Date.now()
                const elapsed = now - lastJikanCall
                if (elapsed < JIKAN_DELAY_MS) {
                    const delay = JIKAN_DELAY_MS - elapsed
                    console.log(`mal-friend-stats: jikanGet rate-limiting sleep for ${delay}ms`)
                    $sleep(delay)
                }
                lastJikanCall = Date.now()

                try {
                    let response: FetchResponse | undefined
                    const url = JIKAN_BASE + path
                    console.log(`mal-friend-stats: fetching Jikan API URL (attempt ${attempt + 1}): ${url}`)
                    $await(fetch(url).then(r => { response = r }))
                    if (!response) {
                        console.error(`mal-friend-stats: jikanGet received undefined response for ${path}`)
                        return null
                    }
                    console.log(`mal-friend-stats: Jikan response status: ${response.status}`)
                    if (response.status === 429) {
                        const sleepTime = 1000 * (attempt + 1)
                        console.warn(`mal-friend-stats: Jikan hit 429 rate limit. Sleeping for ${sleepTime}ms before retry...`)
                        $sleep(sleepTime)
                        continue
                    }
                    if (!response.ok) {
                        console.error(`mal-friend-stats: Jikan response not ok. status: ${response.status}`)
                        return null
                    }
                    const data = response.json<T>()
                    console.log(`mal-friend-stats: Jikan request successful.`)
                    return data
                } catch (err) {
                    console.error(`mal-friend-stats: Jikan exception on path ${path}:`, err)
                    if (attempt === 1) return null
                }
            }
            return null
        }

        // ──────────────────────────────── Helpers ────────────────────────────────

        function mapJikanStatus(status: string): string {
            switch (status) {
                case "watching":       return "CURRENT"
                case "completed":      return "COMPLETED"
                case "on_hold":        return "PAUSED"
                case "dropped":        return "DROPPED"
                case "plan_to_watch":  return "PLANNING"
                default:               return "PLANNING"
            }
        }

        function getMalMediaId(anilistId: number): number | null {
            console.log(`mal-friend-stats: getMalMediaId called for AniList ID: ${anilistId}`)
            const token = $database.anilist.getToken()
            if (!token) {
                console.warn("mal-friend-stats: AniList token is missing or not configured")
                return null
            }
            try {
                const query = `query ($id: Int) { Media(id: $id) { idMal } }`
                console.log("mal-friend-stats: sending custom GraphQL query for idMal mapping...")
                const res = $anilist.customQuery<{ Media: { idMal: number | null } }>(
                    { query, variables: { id: anilistId } },
                    token,
                )
                const malId = res?.Media?.idMal ?? null
                console.log(`mal-friend-stats: GraphQL mapped AniList ID ${anilistId} -> MAL ID ${malId}`)
                return malId
            } catch (err) {
                console.error("mal-friend-stats: failed to get MAL id:", err)
                return null
            }
        }

        function getMALUsername(): string | null {
            console.log("mal-friend-stats: getMALUsername checking sources...")
            try {
                const pref = $getUserPreference("MALUsername")
                console.log(`mal-friend-stats: getUserPreference('MALUsername') returned: "${pref}"`)
                if (pref) return pref
            } catch (e) {
                console.log("mal-friend-stats: getUserPreference failed or not set:", (e as Error).message)
            }
            console.warn("mal-friend-stats: No MAL username found in preferences")
            return null
        }

        function fetchMalFriends(malId: number, malUsername: string): FriendEntry[] {
            console.log(`mal-friend-stats: fetchMalFriends starting for MAL ID: ${malId}, user: ${malUsername}`)
            const friendsResp = jikanGet<JikanFriendsResponse>(
                `/users/${encodeURIComponent(malUsername)}/friends`,
            )
            if (!friendsResp) {
                console.warn(`mal-friend-stats: failed to fetch friends list for ${malUsername}`)
                return []
            }
            if (!friendsResp.data || !friendsResp.data.length) {
                console.log(`mal-friend-stats: friends list is empty for ${malUsername}`)
                return []
            }
            console.log(`mal-friend-stats: retrieved ${friendsResp.data.length} friends. Processing up to ${MAX_FRIENDS}...`)

            const results: FriendEntry[] = []
            const limit = Math.min(friendsResp.data.length, MAX_FRIENDS)

            for (let i = 0; i < limit; i++) {
                const friend = friendsResp.data[i]
                const username = friend.user.username
                console.log(`[${i+1}/${limit}] mal-friend-stats: checking friend: ${username}`)

                const listResp = jikanGet<JikanListResponse>(
                    `/users/${encodeURIComponent(username)}/animelist`,
                )
                if (!listResp) {
                    console.log(`mal-friend-stats: failed to fetch animelist for friend ${username}`)
                    continue
                }
                if (!listResp.data) {
                    console.log(`mal-friend-stats: empty/invalid animelist for friend ${username}`)
                    continue
                }
                console.log(`mal-friend-stats: fetched ${listResp.data.length} anime entries for friend ${username}`)

                const match = listResp.data.find(e => e.anime.mal_id === malId)
                if (!match) {
                    console.log(`mal-friend-stats: friend ${username} has NOT watched anime MAL ID ${malId}`)
                    continue
                }

                console.log(`mal-friend-stats: MATCH FOUND! friend ${username} status: ${match.status}, score: ${match.score}, progress: ${match.episodes_watched}`)
                results.push({
                    status: mapJikanStatus(match.status),
                    score: (match.score || 0) * 10,
                    progress: match.episodes_watched || 0,
                    totalEpisodes: match.anime.episodes ?? undefined,
                    user: {
                        name: username,
                        avatar: friend.user.images?.webp?.image_url,
                    },
                })
            }

            console.log(`mal-friend-stats: finished fetching. Found ${results.length} matching friends who watched MAL ID ${malId}`)
            return results
        }

        // ──────────────────────────────── Plugin Entry ────────────────────────────────

        const mediaId = ctx.state(0)
        const friends = ctx.state<FriendEntry[]>([])
        const loading = ctx.state(false)
        const configured = ctx.state(false)

        const panel = ctx.newWebview({
            slot: "after-anime-entry-episode-list",
            fullWidth: true,
            autoHeight: true,
        })

        panel.channel.sync("friends", friends)
        panel.channel.sync("loading", loading)
        panel.channel.sync("configured", configured)

        // ── Open profile links ──
        const openUrl = ctx.state("")
        panel.channel.on("open-profile", (url: string) => {
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
                console.error("mal-friend-stats: failed to open url", err)
            }
            openUrl.set("")
        }, [openUrl])

        // ── Track navigation ──
        ctx.screen.onNavigate((e) => {
            console.log("mal-friend-stats: onNavigate triggered:", e.pathname, JSON.stringify(e.searchParams))
            const id = e.pathname === "/entry" && !!e.searchParams.id
                ? parseInt(e.searchParams.id)
                : 0
            console.log(`mal-friend-stats: resolved mediaId from navigation: ${id}`)
            mediaId.set(id)
        })
        ctx.screen.loadCurrent()

        // ── Main effect ──
        ctx.effect(() => {
            const id = mediaId.get()
            console.log(`mal-friend-stats: Main effect triggered. mediaId = ${id}`)
            if (!id) {
                console.log("mal-friend-stats: No mediaId, cleaning up and hiding panel.")
                friends.set([])
                loading.set(false)
                panel.hide()
                return
            }

            const malUser = getMALUsername()
            if (!malUser) {
                console.warn("mal-friend-stats: MAL username not set, hiding panel.")
                friends.set([])
                configured.set(false)
                loading.set(false)
                panel.hide()
                return
            }
            configured.set(true)

            const malId = getMalMediaId(id)
            if (!malId) {
                console.warn(`mal-friend-stats: could not resolve MAL ID for AniList ID: ${id}`)
                friends.set([])
                loading.set(false)
                panel.show()
                return
            }

            console.log("mal-friend-stats: Setting loading state to true and retrieving from cache or Jikan...")
            loading.set(true)

            const entries = ctx.cache.getOrSet(`mal-friends-${malUser}-${malId}`, () => {
                console.log(`mal-friend-stats: cache miss or expired for mal-friends-${malUser}-${malId}. Fetching from Jikan...`)
                return fetchMalFriends(malId, malUser)
            }, CACHE_TTL_MS) as FriendEntry[]

            console.log(`mal-friend-stats: retrieved ${entries.length} entries.`)
            friends.set(entries)
            loading.set(false)

            if (entries.length > 0) {
                console.log("mal-friend-stats: Showing panel with entries.")
                panel.show()
            } else {
                console.log("mal-friend-stats: Hiding panel (no entries).")
                panel.hide()
            }
        }, [mediaId])

        // ── UI ──
        panel.setContent(() => `
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
    var STATUS_LABEL = {"CURRENT":"Watching","PLANNING":"Planning","COMPLETED":"Completed","DROPPED":"Dropped","PAUSED":"On Hold","REPEATING":"Rewatching"}
    var STATUS_COLOR = {"CURRENT":"#3db4f2","PLANNING":"#f2c94c","COMPLETED":"#4cd137","DROPPED":"#e84118","PAUSED":"#a4a4a4","REPEATING":"#9b59b6"}

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
            ep.textContent = "Ep " + entry.progress + (entry.totalEpisodes ? "/" + entry.totalEpisodes : "")
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
            empty.textContent = "No MAL friends found for this anime"
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

    function rerender() { render(_friends, _loading, _configured) }

    window.webview.on("friends", function (d) { _friends = d || []; rerender() })
    window.webview.on("loading", function (d) { _loading = !!d; rerender() })
    window.webview.on("configured", function (d) { _configured = !!d; rerender() })
</script>
</body>
</html>
        `)
    })
}
