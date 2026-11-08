package com.bilimusic.player.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.Player
import com.bilimusic.player.App
import com.bilimusic.player.data.FavSourceStore
import com.bilimusic.player.net.AudioStream
import com.bilimusic.player.player.PlayerHolder
import com.bilimusic.player.sync.TrackCore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 一个歌单在列表里的摘要 */
data class PlaylistUi(
    val id: String,
    val title: String,
    val count: Int,
    val isLoved: Boolean = false,
)

/** 当前播放队列里的一员（带了直链，切歌时直接用） */
data class QueueItem(val track: TrackCore, val url: String? = null)

data class PlayerUi(
    val current: TrackCore? = null,
    val playing: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val queue: List<TrackCore> = emptyList(),
    val index: Int = -1,
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * 唯一的状态中枢。所有界面都读它、所有修改都走它。
 *
 * 和桌面端最大的区别：桌面端有 IPC 分层（main / renderer），安卓端没有这一层，
 * 数据直接改 AppLibrary，再 notify 一下 Compose。
 */
class BiliViewModel(app: Application) : AndroidViewModel(app) {

    private val a = app as App
    val lib = a.library
    val bili = a.bili
    val favStore = a.favStore
    val settings = a.settings
    val sync = a.sync

    private val _playlists = MutableStateFlow<List<PlaylistUi>>(emptyList())
    val playlists: StateFlow<List<PlaylistUi>> = _playlists.asStateFlow()

    /** 库里的曲目总数，首页「我的库」入口上显示 */
    private val _libCount = MutableStateFlow(0)
    val libCount: StateFlow<Int> = _libCount.asStateFlow()

    private val _player = MutableStateFlow(PlayerUi())
    val player: StateFlow<PlayerUi> = _player.asStateFlow()

    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast.asStateFlow()

    private val _nav = MutableStateFlow<com.bilimusic.player.net.NavInfo?>(null)
    val nav: StateFlow<com.bilimusic.player.net.NavInfo?> = _nav.asStateFlow()

    private val _folders = MutableStateFlow<List<com.bilimusic.player.net.FavFolder>>(emptyList())
    val folders: StateFlow<List<com.bilimusic.player.net.FavFolder>> = _folders.asStateFlow()

    private val _busy = MutableStateFlow<String?>(null)
    val busy: StateFlow<String?> = _busy.asStateFlow()

    private val exo get() = PlayerHolder.player(a)

    /**
     * 库内容版本号。每次库发生变化就 +1，页面把它当作 `remember` 的 key，
     * 这样同步合并进来的内容会立刻反映到已经打开着的歌单页上。
     *
     * **必须声明在 `init` 之前**：Kotlin 按声明顺序初始化属性，`init` 里的
     * [refreshLibrary] 会读写它，若声明在后拿到的就是 null（NPE，冷启动必崩）。
     */
    private val _libRev = MutableStateFlow(0)
    val libRevision: StateFlow<Int> = _libRev.asStateFlow()

    init {
        refreshLibrary()
        attachPlayer()
        viewModelScope.launch {
            runCatching {
                if (bili.isLoggedIn()) {
                    bili.ensureBuvid()
                    _nav.value = bili.nav()
                }
            }
        }
        // 冷启动时补偿上次没落盘的数据
        lib.flushIfDirty()

        // 同步合并完立刻刷新歌单，否则用户得退出重进才看得到对端的数据
        sync.onMerged = { refreshLibrary() }
    }

    // ---------------- 库 ----------------

    fun refreshLibrary() {
        _libRev.value = _libRev.value + 1
        _playlists.value = buildList {
            val loved = lib.lovedKeys()
            add(PlaylistUi(LOVE_ID, "我喜欢的歌", loved.size, isLoved = true))
            for (p in lib.livePlaylists()) {
                add(PlaylistUi(p.id, p.title.v, lib.itemKeys(p.id).size))
            }
        }
        _libCount.value = lib.liveTracks().size
    }

    /**
     * 直接躺在库里的全部曲目（对应桌面端侧边栏「我的库」）。
     *
     * ## 为什么需要它
     *
     * 「链接收藏」导入的曲目只会进 tracks 表，不会自动进任何歌单；
     * 以前首页只渲染「我喜欢的歌」和自建歌单，于是导入成功了却
     * **在界面上完全看不到**——用户只能看到一句「已导入 N 首」。
     */
    fun libraryTracks(): List<TrackCore> =
        lib.liveTracks().sortedWith(compareByDescending<TrackCore> { it.title.isEmpty() }.thenBy { it.title })

    fun playlistTracks(id: String): List<TrackCore> =
        if (id == LOVE_ID) lib.lovedKeys().mapNotNull { lib.track(it) }
        else lib.playlistTracks(id)

    fun createPlaylist(title: String) {
        val name = title.trim()
        if (name.isEmpty()) return
        lib.createPlaylist(name)
        persist()
        refreshLibrary()
        toast("已创建「$name」")
    }

    fun renamePlaylist(id: String, title: String) {
        lib.renamePlaylist(id, title.trim())
        persist()
        refreshLibrary()
    }

    fun deletePlaylist(id: String) {
        lib.deletePlaylist(id)
        persist()
        refreshLibrary()
    }

    fun addToPlaylist(plId: String, keys: List<String>) {
        val n = lib.addToPlaylist(plId, keys)
        persist()
        refreshLibrary()
        toast(if (n > 0) "已加入 $n 首" else "这些歌已经在歌单里了")
    }

    fun removeFromPlaylist(plId: String, key: String) {
        lib.removeFromPlaylist(plId, key)
        persist()
        refreshLibrary()
    }

    fun moveItem(plId: String, from: Int, to: Int) {
        lib.moveItem(plId, from, to)
        persist()
    }

    fun toggleLoved(key: String) {
        lib.setLoved(key, !lib.isLoved(key))
        persist()
        refreshLibrary()
        // 列表页可能正显示「我喜欢的歌」，曲目变了要刷
        _player.update { it.copy() }
    }

    fun isLoved(key: String): Boolean = lib.isLoved(key)

    private fun persist() {
        lib.markDirty()
        lib.flushIfDirty()
    }

    // ---------------- 登录 ----------------

    suspend fun refreshNav() {
        _nav.value = runCatching {
            bili.ensureBuvid()
            bili.nav()
        }.getOrNull()
    }

    /** 供 Compose 回调里 fire-and-forget 用 */
    fun refreshNavSuspend() {
        viewModelScope.launch { refreshNav() }
    }

    fun logout() {
        bili.logout()
        _nav.value = null
        _folders.value = emptyList()
        toast("已退出登录")
    }

    // ---------------- 收藏夹 ----------------

    fun loadFolders() {
        viewModelScope.launch {
            _busy.value = "正在拉取收藏夹…"
            try {
                val mid = _nav.value?.mid ?: bili.nav().also { _nav.value = it }.mid
                _folders.value = bili.favFolders(mid)
                _busy.value = null
            } catch (e: Exception) {
                _busy.value = null
                toast("收藏夹获取失败：${e.message}")
            }
        }
    }

    /**
     * 拉一次收藏夹并写进本地镜像（桌面端的「跟随收藏夹」）。
     * 只替换镜像，不动用户自己建歌单。
     */
    fun syncFolder(folder: com.bilimusic.player.net.FavFolder) {
        viewModelScope.launch {
            _busy.value = "正在同步「${folder.title}」…"
            try {
                val (items, total) = bili.favItems(folder.id)
                val metas = bili.resolveMany(items.map { it.bvid })
                val tracks = ArrayList<TrackCore>()
                for (it in items) {
                    val meta = metas[it.bvid] ?: continue
                    if (meta.pages.size > 1) {
                        for (p in meta.pages) {
                            tracks.add(
                                FavSourceStore.toTrackCore(meta, p.page, meta.pages.size, p.part, p.duration, p.cid)
                            )
                        }
                    } else {
                        tracks.add(
                            FavSourceStore.toTrackCore(meta, 1, 1, "", meta.duration, meta.cid)
                        )
                    }
                }
                // 曲目本身也要进库，否则歌单里引用不到
                val touched = ArrayList<String>()
                for (t in tracks) {
                    lib.upsertTrack(t)
                    touched.add(t.key)
                }
                val added = favStore.applySnapshot(folder.id, folder.title, total, tracks)
                favStore.follow(folder)
                persist()
                refreshLibrary()
                _busy.value = null
                toast(if (added > 0) "「${folder.title}」新增 $added 首，共 ${tracks.size} 首" else "「${folder.title}」已是最新")
            } catch (e: Exception) {
                _busy.value = null
                toast("同步失败：${e.message}")
            }
        }
    }

    // ---------------- 链接导入 ----------------

    /**
     * 解析并导入链接里的曲目。
     *
     * [onDone] 在导入结束后回调（参数是成功条数，失败时是 -1），
     * 用来让界面在导入成功后直接跳到「我的库」——否则用户只能看到
     * 一句「已导入 N 首」，却不知道去哪儿找这些歌。
     */
    fun importLink(text: String, onDone: ((Int) -> Unit)? = null) {
        viewModelScope.launch {
            _busy.value = "正在解析链接…"
            try {
                val r = bili.resolveLinks(text)
                var n = 0
                for (t in r.tracks) {
                    lib.upsertTrack(
                        TrackCore(
                            key = "bili:${t.id}",
                            type = "bili",
                            id = t.id,
                            bvid = t.bvid,
                            cid = t.cid,
                            page = t.page,
                            title = t.title,
                            artist = t.artist,
                            cover = t.cover,
                            duration = t.duration.toLong(),
                            partCount = if (t.multiPage) r.tracks.count { it.bvid == t.bvid } else 1,
                        )
                    )
                    n++
                }
                persist()
                refreshLibrary()
                _busy.value = null
                if (n > 0) {
                    toast("已导入 $n 首，去「我的库」看看")
                } else {
                    toast("没解析出可导入的曲目，检查链接是否有效")
                }
                onDone?.invoke(n)
            } catch (e: Exception) {
                _busy.value = null
                toast("解析失败：${e.message}")
                onDone?.invoke(-1)
            }
        }
    }

    // ---------------- 播放 ----------------

    private fun attachPlayer() {
        val p = exo
        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _player.update { it.copy(playing = isPlaying) }
                tickPosition()
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    _player.update { it.copy(playing = false) }
                    // 播放器里只有一个 item，播完不会自动进下一首，
                    // 队列的推进由这里接管（顺序播放模式下也就自然停住）。
                    val st = _player.value
                    if (st.queue.isEmpty() || settings.playMode == "sequential") return
                    when (settings.playMode) {
                        "loop-one" -> {
                            val p2 = PlayerHolder.peek() ?: return
                            p2.seekTo(0L)
                            p2.play()
                        }
                        "shuffle" -> startAt(st.queue.indices.random())
                        else -> {
                            val nextIdx = if (st.index + 1 < st.queue.size) st.index + 1 else 0
                            startAt(nextIdx)
                        }
                    }
                }
            }

            override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
                // 播放器里只有当前这一首，currentMediaItemIndex 恒为 0，
                // 所以队列下标只能由 startAt 维护 —— 这里绝不能拿它去覆盖 index。
                _player.update { it.copy(durationMs = p.duration.coerceAtLeast(0)) }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // B 站直链有效期约 2 小时，长播时可能在歌与歌之间过期。
                // 遇到 4xx 先自动重解析一次并原地续播，别直接甩错误给用户。
                val httpCode = (error.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)
                    ?.responseCode
                val t = _player.value.current
                val stale = httpCode == 403 || httpCode == 410 || httpCode == 412 || httpCode == 404
                if (stale && t != null && t.type != "local" && !selfHealing) {
                    selfHealing = true
                    val resumeAt = PlayerHolder.peek()?.currentPosition ?: 0L
                    viewModelScope.launch {
                        val fresh = resolveUrl(t)
                        val p = PlayerHolder.peek()
                        val idx = p?.currentMediaItemIndex ?: -1
                        if (fresh.url != null && p != null && idx >= 0) {
                            p.replaceMediaItem(idx, PlayerHolder.mediaItemOf(t, fresh.url))
                            p.seekTo(idx, resumeAt)
                            p.play()
                            _player.update { it.copy(error = null, loading = false) }
                        } else {
                            _player.update {
                                it.copy(error = "重新取地址失败：${fresh.error ?: readable(error)}", loading = false)
                            }
                        }
                        selfHealing = false
                    }
                    return
                }
                _player.update { it.copy(error = readable(error), loading = false) }
            }
        })
    }

    private fun readable(e: androidx.media3.common.PlaybackException): String = when (e.errorCode) {
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> {
            val code = (e.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode
            when (code) {
                403 -> "音频地址被拒绝（403）。如果每首歌都这样，多半是 CDN 拦了 UA，请更新到最新版本"
                404 -> "音频地址不存在（404），这条可能已被删除"
                410, 412 -> "音频地址已过期（$code），请重新播放试试"
                else -> "音频地址被拒绝${code?.let { "（HTTP $it）" } ?: "（可能已过期）"}，请重新播放"
            }
        }
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "网络连接失败，检查手机网络"
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "网络超时，换个网络再试"
        androidx.media3.common.PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED -> "音频格式解析失败"
        else -> "播放出错：${e.errorCodeName}"
    }

    private var posJob: kotlinx.coroutines.Job? = null

    /** 防止「重新解析 → 又失败 → 再解析」打成死循环 */
    private var selfHealing = false

    private fun tickPosition() {
        if (_player.value.playing && posJob == null) {
            posJob = viewModelScope.launch {
                while (true) {
                    val p = PlayerHolder.peek() ?: break
                    _player.update { it.copy(positionMs = p.currentPosition, durationMs = p.duration.coerceAtLeast(0)) }
                    kotlinx.coroutines.delay(500)
                }
            }
        } else if (!_player.value.playing) {
            posJob?.cancel()
            posJob = null
        }
    }

    /**
     * 解析带超时和一次重试。
     *
     * ## 为什么必须重试
     *
     * 手机的网络比台式机差得多，切 Wi-Fi、熄屏、后台限流都会让单次请求失败。
     * 而以前的 [playAll] 是**一次性解析整张歌单**——同步前只有 6 首，同步后是 47 首，
     * 请求数翻了 8 倍，任何一次抖动都会让那一首变成「取不到播放地址」。
     * 没有超时的话，一个卡住的连接就能把整次播放拖到用户以为死机。
     */
    private suspend fun resolveUrlRetrying(t: TrackCore): Resolved {
        val first = kotlinx.coroutines.withTimeoutOrNull(RESOLVE_TIMEOUT_MS) { resolveUrl(t) }
            ?: Resolved(null, "解析超时（${RESOLVE_TIMEOUT_MS / 1000} 秒没有响应）")
        if (first.url != null) return first
        // 本地文件不存在重试也没用
        if (t.type == "local") return first
        kotlinx.coroutines.delay(400)
        val second = kotlinx.coroutines.withTimeoutOrNull(RESOLVE_TIMEOUT_MS) { resolveUrl(t) }
            ?: return Resolved(null, "${first.error ?: "未知原因"}；重试也超时")
        return if (second.url != null) second else Resolved(null, "${first.error ?: "未知原因"}；重试后仍失败")
    }

    /** 播一个歌单 */
    fun playAll(tracks: List<TrackCore>, startIndex: Int = 0) {
        if (tracks.isEmpty()) {
            toast("这个歌单还是空的")
            return
        }
        val idx = startIndex.coerceIn(0, tracks.lastIndex)
        // 队列只记在状态里，ExoPlayer 每首歌自己装载一次（见 startAt）。
        _player.update { it.copy(queue = tracks, index = idx) }
        startAt(idx)
    }

    fun togglePlayPause() {
        val p = PlayerHolder.peek() ?: return
        if (p.isPlaying) {
            p.pause()
        } else {
            startPlaybackService()
            p.play()
        }
    }

    /**
     * 把 MediaSessionService 拉起来，否则退到后台音乐会被系统掐掉。
     * 用 startService 而不是 startForegroundService：媒体播放的前台通知由
     * MediaSessionService 自己发，提前 startForegroundService 反而会因为
     * 5 秒内没 startForeground 而 ANR。
     */
    private fun startPlaybackService() {
        runCatching {
            val ctx = getApplication<Application>()
            ctx.startService(android.content.Intent(ctx, com.bilimusic.player.player.PlaybackService::class.java))
        }
    }

    fun next() {
        val st = _player.value
        if (st.queue.isEmpty()) return
        val nextIdx = if (st.index + 1 < st.queue.size) st.index + 1 else 0
        startAt(nextIdx)
    }

    fun prev() {
        val st = _player.value
        if (st.queue.isEmpty()) return
        val prevIdx = if (st.index - 1 >= 0) st.index - 1 else st.queue.lastIndex
        startAt(prevIdx)
    }

    fun seekTo(ms: Long) {
        PlayerHolder.peek()?.seekTo(ms)
    }

    /** 点队列里的某一行：切到那首并接着播 */
    fun seekToQueue(index: Int) {
        if (index !in _player.value.queue.indices) return
        startAt(index)
    }

    /**
     * 切到队列第 [index] 首并开始播。
     *
     * ExoPlayer 里始终只有**一个** item —— 队列存在于 [PlayerUi.queue] 里，
     * 由这里按需解析下一首。这样同步来 47 首的歌单也只需先解析一首就能出声，
     * 而不是连打 47 次 playurl 才肯开始播。
     */
    private fun startAt(index: Int) {
        val q = _player.value.queue
        val t = q.getOrNull(index) ?: return
        viewModelScope.launch {
            _player.update { it.copy(loading = true, index = index, current = t, error = null) }
            val r = resolveUrlRetrying(t)
            if (r.url == null) {
                _player.update {
                    it.copy(loading = false, error = "取不到「${t.title}」的播放地址：${r.error ?: "未知原因"}")
                }
                return@launch
            }
            withContext(Dispatchers.Main) {
                val p = exo
                p.setMediaItem(PlayerHolder.mediaItemOf(t, r.url))
                p.prepare()
                applyPlayMode()
                startPlaybackService()
                p.play()
                _player.update { it.copy(loading = false) }
            }
        }
    }

    /**
     * 播放模式循环切换，和桌面端一致：loop-all → loop-one → shuffle → sequential。
     * Media3 的 repeatMode 只有 ALL/ONE/OFF，shuffle 走 shuffleModeEnabled。
     */
    fun cyclePlayMode() {
        val next = when (settings.playMode) {
            "loop-all" -> "loop-one"
            "loop-one" -> "shuffle"
            "shuffle" -> "sequential"
            else -> "loop-all"
        }
        settings.playMode = next
        applyPlayMode()
    }

    /**
     * 播放器里始终只有一个 item，所以 repeatMode **必须恒为 OFF**：
     * 设成 ALL/ONE 会让同一首歌无限循环，[Player.STATE_ENDED] 永远不触发，
     * 队列就再也不会前进。循环/随机交给 [onPlaybackStateChanged] 里的队列逻辑。
     */
    fun applyPlayMode() {
        val p = PlayerHolder.peek() ?: return
        p.repeatMode = Player.REPEAT_MODE_OFF
        p.shuffleModeEnabled = false
        // 让界面刷新一次模式文字
        _player.update { it.copy() }
    }

    fun setVolume(v: Float) {
        exo.volume = v.coerceIn(0f, 1f)
        settings.volume = v
    }

    fun stop() {
        exo.stop()
        exo.clearMediaItems()
        _player.update { PlayerUi() }
    }

    /** 解析结果：要么有直链，要么带一句**说得清为什么**的失败原因。 */
    private data class Resolved(val url: String?, val error: String?)

    /**
     * 解析播放直链。
     * 注意桌面端把这一步放在主进程 + 本地代理里，安卓端直接把 DASH 的 baseUrl 交给 ExoPlayer，
     * 由 PlayerHolder 注入 Referer 头来绕过 403。
     *
     * ## 为什么要带 error 出去（踩过的坑）
     *
     * 以前这里失败时把 `e.message` 写进 `_player.value.error` 就返回 null，而紧接着
     * [playAll] 会用「取不到「X」的播放地址」把它**覆盖掉**。结果所有故障在界面上
     * 长得一模一样 —— 缺 cid、风控 412、登录态失效、网络不通全都显示同一句话，
     * 用户报「同步之后找不到播放地址」时完全无从判断。真实原因必须一路带到界面上。
     *
     * 缺 cid 单独给一句提示：同步过来的旧记录可能没有 cid（track 表里有条目、
     * 但 core 里 cid=0），[com.bilimusic.player.net.BiliClient.audioStreams] 会直接抛
     * -400「缺少 bvid 或 cid」，那是数据问题，不是网络问题。
     */
    private suspend fun resolveUrl(t: TrackCore): Resolved = withContext(Dispatchers.IO) {
        try {
            if (t.type == "local") {
                // 本地音源存的是文件路径
                val path = t.bvid
                return@withContext if (path.isEmpty()) {
                    Resolved(null, "本地曲目没有记录文件路径")
                } else {
                    Resolved(path, null)
                }
            }
            if (t.bvid.isEmpty()) return@withContext Resolved(null, "这条记录缺 bvid")
            if (t.cid <= 0) return@withContext Resolved(null, "这条记录缺 cid（多半是同步过来的旧数据）")
            val streams: List<AudioStream> = bili.audioStreams(t.bvid, t.cid)
            if (streams.isEmpty()) return@withContext Resolved(null, "接口没有返回任何音轨")
            val preferred = settings.quality
            val picked = streams.firstOrNull { it.id == preferred }
                ?: streams.maxByOrNull { it.bandwidth }
            val url = picked?.urls?.firstOrNull()
            if (url.isNullOrEmpty()) Resolved(null, "音轨里没有可用地址") else Resolved(url, null)
        } catch (e: Exception) {
            Resolved(null, e.message ?: e.javaClass.simpleName)
        }
    }

    // ---------------- 同步 ----------------

    fun startSyncServer() {
        sync.startServer()
    }

    fun stopSyncServer() {
        sync.stopServer()
    }

    fun syncWith(ip: String, port: Int, token: String) {
        sync.syncNow(ip, port, token)
    }

    /** 生成可复制粘贴的文本同步码 */
    fun exportSyncCode(): String = sync.exportCode()

    /** 合并一段文本同步码 */
    fun importSyncCode(text: String) = sync.importCode(text)

    // ---------------- 提示 ----------------

    fun toast(msg: String) {
        _toast.value = msg
    }

    fun clearToast() {
        _toast.value = null
    }

    fun clearError() {
        _player.update { it.copy(error = null) }
    }

    companion object {
        const val LOVE_ID = "__loved__"

        /** 单次直链解析的上限；超时后重试一次，仍失败就报错给用户看。 */
        private const val RESOLVE_TIMEOUT_MS = 12_000L
    }
}
