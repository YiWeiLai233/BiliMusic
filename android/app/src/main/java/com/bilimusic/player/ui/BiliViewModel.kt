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
    }

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

    /** 解析并导入链接里的曲目 */
    fun importLink(text: String) {
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
                toast("已导入 $n 首")
            } catch (e: Exception) {
                _busy.value = null
                toast("解析失败：${e.message}")
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
                }
            }

            override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
                val i = p.currentMediaItemIndex
                val st = _player.value
                _player.update {
                    it.copy(
                        index = i.coerceAtLeast(0),
                        current = st.queue.getOrNull(i) ?: st.current,
                        durationMs = p.duration.coerceAtLeast(0),
                    )
                }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                _player.update { it.copy(error = readable(error), loading = false) }
            }
        })
    }

    private fun readable(e: androidx.media3.common.PlaybackException): String = when (e.errorCode) {
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
            "音频地址被拒绝（可能已过期），请重新播放"
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "网络连接失败，检查手机网络"
        androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "网络超时，换个网络再试"
        else -> "播放出错：${e.errorCodeName}"
    }

    private var posJob: kotlinx.coroutines.Job? = null

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

    /** 播一个歌单 */
    fun playAll(tracks: List<TrackCore>, startIndex: Int = 0) {
        if (tracks.isEmpty()) {
            toast("这个歌单还是空的")
            return
        }
        viewModelScope.launch {
            _player.update { it.copy(loading = true, error = null) }
            val items = mutableListOf<androidx.media3.common.MediaItem>()
            val startPos = mutableListOf<Int>()
            for ((i, t) in tracks.withIndex()) {
                val url = resolveUrl(t) ?: continue
                items.add(PlayerHolder.mediaItemOf(t, url))
                startPos.add(i)
            }
            if (items.isEmpty()) {
                _player.update { it.copy(loading = false) }
                return@launch
            }
            val idx = startPos.indexOf(startIndex).let { if (it >= 0) it else 0 }
            withContext(Dispatchers.Main) {
                val p = exo
                _player.update { it.copy(queue = tracks, index = idx) }
                p.setMediaItems(items)
                p.prepare()
                p.seekTo(idx, 0L)
                applyPlayMode()
                startPlaybackService()
                p.play()
                _player.update { it.copy(loading = false) }
            }
        }
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
        val p = PlayerHolder.peek() ?: return
        if (p.hasNextMediaItem()) p.seekToNextMediaItem()
    }

    fun prev() {
        val p = PlayerHolder.peek() ?: return
        if (p.hasPreviousMediaItem()) p.seekToPreviousMediaItem()
    }

    fun seekTo(ms: Long) {
        PlayerHolder.peek()?.seekTo(ms)
    }

    /** 点队列里的某一行：切到那首并接着播 */
    fun seekToQueue(index: Int) {
        val st = _player.value
        if (index !in st.queue.indices) return
        val p = PlayerHolder.peek() ?: return
        // 播放器里的 item 与队列可能因解析失败而错位，越界就不动
        if (index <= st.queue.lastIndex) {
            p.seekTo(index, 0L)
            p.play()
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

    fun applyPlayMode() {
        val p = PlayerHolder.peek() ?: return
        when (settings.playMode) {
            "loop-one" -> {
                p.repeatMode = Player.REPEAT_MODE_ONE
                p.shuffleModeEnabled = false
            }
            "shuffle" -> {
                p.repeatMode = Player.REPEAT_MODE_ALL
                p.shuffleModeEnabled = true
            }
            "sequential" -> {
                p.repeatMode = Player.REPEAT_MODE_OFF
                p.shuffleModeEnabled = false
            }
            else -> {
                p.repeatMode = Player.REPEAT_MODE_ALL
                p.shuffleModeEnabled = false
            }
        }
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

    /**
     * 解析播放直链。
     * 注意桌面端把这一步放在主进程 + 本地代理里，安卓端直接把 DASH 的 baseUrl 交给 ExoPlayer，
     * 由 PlayerHolder 注入 Referer 头来绕过 403。
     */
    private suspend fun resolveUrl(t: TrackCore): String? = withContext(Dispatchers.IO) {
        try {
            if (t.type == "local") {
                // 本地音源存的是文件路径
                val path = t.bvid
                return@withContext if (path.isEmpty()) null else path
            }
            val streams: List<AudioStream> = bili.audioStreams(t.bvid, t.cid)
            val preferred = settings.quality
            val picked = streams.firstOrNull { it.id == preferred }
                ?: streams.maxByOrNull { it.bandwidth }
            picked?.urls?.firstOrNull()
        } catch (e: Exception) {
            _player.update { it.copy(error = e.message) }
            null
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
    }
}
