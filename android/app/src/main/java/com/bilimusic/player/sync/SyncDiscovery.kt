package com.bilimusic.player.sync

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import kotlin.concurrent.thread

/**
 * 局域网里「自动发现对端」，省掉让用户手输 IP 和配对口令。
 *
 * 做法就是 UDP 广播：每台设备 2 秒往 255.255.255.255:41789 喊一嗓子，
 * 内容带上自己的同步端口和一次性 token。同一 Wi-Fi 下的另一台就能直接看到。
 *
 * 为什么不用 mDNS：mDNS 在安卓上要额外引库，很多家用路由还会拦组播；
 * 应用内私有的 UDP 广播最简单可靠，而且包里有 token，别人捡到也用不了。
 */
class SyncDiscovery {

    data class Peer(
        val name: String,
        val host: String,
        val port: Int,
        val token: String,
        val seenAt: Long,
    )

    private var sock: DatagramSocket? = null
    private var broadcaster: Thread? = null
    private var listener: Thread? = null

    @Volatile private var running = false

    /** 本机要广播出去的端口/token；没启动服务端时就是 0 */
    @Volatile private var myPort: Int = 0
    @Volatile private var myToken: String = ""
    @Volatile private var myName: String = "Android"

    private val peers = LinkedHashMap<String, Peer>()

    private var onUpdate: ((List<Peer>) -> Unit)? = null

    fun start(name: String, port: Int, token: String, onPeers: (List<Peer>) -> Unit) {
        myName = name
        myPort = port
        myToken = token
        onUpdate = onPeers
        if (running) return
        running = true

        val s = DatagramSocket(null)
        s.reuseAddress = true
        s.broadcast = true
        s.bind(InetSocketAddress(PORT))
        s.soTimeout = 1000
        sock = s

        listener = thread(name = "sync-discover-rx", isDaemon = true) {
            val buf = ByteArray(512)
            while (running) {
                try {
                    val p = DatagramPacket(buf, buf.size)
                    s.receive(p)
                    val text = String(p.data, 0, p.length, Charsets.UTF_8)
                    handle(text, p.address.hostAddress ?: continue)
                } catch (_: java.net.SocketTimeoutException) {
                    // 正常：超时只是让我们有机会检查 running
                } catch (_: Exception) {
                    if (!running) break
                }
            }
        }

        broadcaster = thread(name = "sync-discover-tx", isDaemon = true) {
            while (running) {
                if (myPort > 0) {
                    val msg = "BILIMUSIC1|$myPort|$myToken|$myName"
                    val bytes = msg.toByteArray(Charsets.UTF_8)
                    try {
                        s.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName("255.255.255.255"), PORT))
                        // 有些路由不转发受限广播，再补一次子网内的定向广播
                        val local = SyncServer.localAddress() ?: ""
                        if (local.isNotEmpty() && !local.startsWith("127.")) {
                            val parts = local.split(".")
                            if (parts.size == 4) {
                                val directed = "${parts[0]}.${parts[1]}.${parts[2]}.255"
                                s.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName(directed), PORT))
                            }
                        }
                    } catch (_: Exception) {
                    }
                }
                try {
                    Thread.sleep(2000)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
    }

    fun updateSelf(port: Int, token: String) {
        myPort = port
        myToken = token
    }

    fun stop() {
        running = false
        runCatching { sock?.close() }
        sock = null
        broadcaster?.interrupt()
        listener?.interrupt()
        broadcaster = null
        listener = null
        peers.clear()
        onUpdate?.invoke(emptyList())
    }

    private fun handle(text: String, from: String) {
        val parts = text.split("|")
        if (parts.size < 4 || parts[0] != "BILIMUSIC1") return
        val port = parts[1].toIntOrNull() ?: return
        val token = parts[2]
        val name = parts.drop(3).joinToString("|")
        // 自己发的包也收得到，按 host+port 排除自己
        val key = "$from:$port"
        if (from == SyncServer.localAddress() && port == myPort) return
        synchronized(peers) {
            peers[key] = Peer(name, from, port, token, System.currentTimeMillis())
            // 10 秒没再喊就认为下线
            val cutoff = System.currentTimeMillis() - 10_000
            peers.entries.removeAll { it.value.seenAt < cutoff }
            onUpdate?.invoke(peers.values.toList())
        }
    }

    companion object {
        const val PORT = 41789
    }
}
