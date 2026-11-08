package com.bilimusic.player

import android.content.Context
import com.bilimusic.player.sync.SyncClient
import com.bilimusic.player.sync.SyncCodec
import com.bilimusic.player.sync.SyncDiscovery
import com.bilimusic.player.sync.SyncDoc
import com.bilimusic.player.sync.SyncServer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 把「同步服务端」「同步客户端」「配对码」串起来。
 *
 * 局域网直连的完整流程：
 *   1. 两台设备都在同一个 Wi-Fi 下；
 *   2. 各自启动 [SyncServer]，监听随机端口；
 *   3. 一端显示二维码，内容是 `bilimusic://pair?ip=..&port=..&token=..`；
 *   4. 另一端扫码，拿到 ip/port/token，直接 POST /sync 做一次双向交换；
 *   5. 交换完两端都已经 merge 过对方的文档，所以立刻收敛。
 *
 * token 是配对时的一次性口令，防止同一个 Wi-Fi 下的陌生设备乱发数据。
 */
class SyncCoordinator(private val app: App) {

    data class ServerState(val running: Boolean, val ip: String?, val port: Int, val token: String)

    private val _server = MutableStateFlow(ServerState(false, null, 0, ""))
    val server: StateFlow<ServerState> = _server.asStateFlow()

    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    sealed interface SyncStatus {
        data object Idle : SyncStatus
        data class Running(val message: String) : SyncStatus
        data class Ok(val message: String) : SyncStatus
        data class Failed(val message: String) : SyncStatus
    }

    private var srv: SyncServer? = null
    private val discovery = SyncDiscovery()

    /**
     * 合并成功后回调，用来让界面重新读取歌单。
     *
     * 同步是在后台线程里跑完的，合并进来的曲目/歌单不会自己出现在 UI 上；
     * 没有这个回调，用户得退出重进才知道同步生效了。
     */
    var onMerged: (() -> Unit)? = null

    private fun notifyMerged() {
        // 同步线程不一定是主线程（服务端 handler 在自己的线程池里跑），
        // 回调统一抛回主线程，免得调用方踩到 UI 线程约束。
        val post = {
            runCatching { onMerged?.invoke() }
            Unit
        }
        runCatching {
            android.os.Handler(android.os.Looper.getMainLooper()).post(post)
        }.onFailure { post() }
    }

    private val _peers = MutableStateFlow<List<SyncDiscovery.Peer>>(emptyList())
    val peers: StateFlow<List<SyncDiscovery.Peer>> = _peers.asStateFlow()

    /** 配对二维码里放的东西。桌面端扫码后调 POST /sync 即可。 */
    fun pairingPayload(): String {
        val s = _server.value
        if (!s.running) return ""
        return "bilimusic://pair?ip=${s.ip}&port=${s.port}&token=${s.token}"
    }

    /** 启动本地同步服务；返回 (ip, port, token) */
    fun startServer(): SyncServer? {
        if (srv != null) return srv
        val token = randomToken()
        val server = SyncServer(token) { body ->
            // 收到对方的文档：解码 → 合并进本地 → 回发我合并后的整份
            try {
                val remote = SyncCodec.unpack(body)
                app.library.mergeWith(remote)
                app.library.flushIfDirty()
                notifyMerged()
                SyncCodec.pack(app.library.exportCompact())
            } catch (e: Exception) {
                ByteArray(0)
            }
        }
        val port = server.start()
        srv = server
        _server.value = ServerState(true, SyncServer.localAddress(), port, token)
        // 同时开始广播，让对端能自动发现我（不用手输 IP）
        runCatching {
            discovery.start(
                name = app.settings.deviceName,
                port = port,
                token = token,
                onPeers = { list -> _peers.value = list },
            )
        }
        return server
    }

    fun stopServer() {
        runCatching { discovery.stop() }
        _peers.value = emptyList()
        srv?.stop()
        srv = null
        _server.value = ServerState(false, null, 0, "")
    }

    /**
     * 主动连对端做一次双向交换。
     * 返回合并结果摘要；异常统一包成 SyncStatus.Failed。
     */
    fun syncNow(host: String, port: Int, token: String): SyncCoordinator {
        _status.value = SyncStatus.Running("正在连接 $host:$port …")
        Thread {
            try {
                val r = SyncClient.exchange(
                    host = host,
                    port = port,
                    token = token,
                    local = app.library.exportCompact(),
                )
                val merged = app.library.mergeWith(r.remote)
                app.library.flushIfDirty()
                app.settings.lastPeer = "$host:$port"
                app.settings.peerToken = token
                app.settings.lastSyncAt = System.currentTimeMillis()
                notifyMerged()
                _status.value = SyncStatus.Ok(describe(merged))
            } catch (e: Exception) {
                _status.value = SyncStatus.Failed(e.message ?: "同步失败")
            }
        }.start()
        return this
    }

    private fun describe(r: com.bilimusic.player.data.AppLibrary.MergeResult): String {
        val parts = ArrayList<String>()
        if (r.newTracks > 0) parts.add("${r.newTracks} 首新歌")
        if (r.newPlaylists > 0) parts.add("${r.newPlaylists} 个新歌单")
        if (r.addedItems > 0) parts.add("${r.addedItems} 条曲目")
        return if (parts.isEmpty()) "已是最新" else "同步完成：新增 " + parts.joinToString("、")
    }

    private fun randomToken(): String {
        val chars = "abcdefghijkmnpqrstuvwxyz23456789"
        val rnd = java.security.SecureRandom()
        return (0 until 12).map { chars[rnd.nextInt(chars.length)] }.joinToString("")
    }

    /** 服务端收到合并请求时，若文档过大（>6MB）就分片走二维码，不走 HTTP */
    fun docSize(): Int = runCatching { SyncCodec.pack(app.library.exportCompact()).size }.getOrDefault(0)

    // ---------------- 文本同步码（不需要两台设备在同一 Wi-Fi） ----------------

    /**
     * 把自己的整份状态编码成一串文本，可以走微信/QQ/邮件/任何 IM 传给对方。
     * 对方粘贴合并后，再把他那一串发回来合并一次，两端就收敛了。
     */
    fun exportCode(): String = runCatching { SyncCodec.encode(app.library.exportCompact()) }
        .getOrElse {
            _status.value = SyncStatus.Failed("生成同步码失败：${it.message}")
            ""
        }

    /** 吃掉对方发来的同步码 */
    fun importCode(text: String) {
        val clean = text.trim()
        if (clean.isEmpty()) {
            _status.value = SyncStatus.Failed("同步码是空的")
            return
        }
        _status.value = SyncStatus.Running("正在合并同步码…")
        Thread {
            try {
                val remote = SyncCodec.decode(clean)
                val merged = app.library.mergeWith(remote)
                app.library.flushIfDirty()
                notifyMerged()
                _status.value = SyncStatus.Ok(describe(merged))
            } catch (e: Exception) {
                _status.value = SyncStatus.Failed(e.message ?: "同步码无法识别")
            }
        }.start()
    }
}
