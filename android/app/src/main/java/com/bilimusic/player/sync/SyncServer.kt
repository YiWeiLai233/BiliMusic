package com.bilimusic.player.sync

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * 极简 HTTP 服务器 —— 只用 JDK 自带的 ServerSocket，不引第三方库。
 *
 * 为什么不用 Ktor / NanoHTTPD：只需要一个 POST 端点，多一个依赖就多一份体积和
 * 一份 ProGuard 麻烦。这里手写 HTTP/1.1 的请求行 + 头部 + Content-Length 就够。
 *
 * 只做两件事：
 *   GET  /ping        → 探测对端是否在线（不需要 token）
 *   POST /sync        → 交换整份同步文档，需要 token
 */
class SyncServer(
    private val token: String,
    private val handler: (ByteArray) -> ByteArray,
) {

    @Volatile private var socket: ServerSocket? = null
    @Volatile private var running = false
    private val pool = Executors.newFixedThreadPool(4)

    val port: Int get() = socket?.localPort ?: -1

    /** 绑定 0.0.0.0 的随机端口，返回实际端口 */
    fun start(): Int {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(0))
        socket = s
        running = true
        thread(isDaemon = true, name = "sync-server") {
            while (running) {
                val client = try {
                    s.accept()
                } catch (_: IOException) {
                    break
                }
                pool.submit { serve(client) }
            }
        }
        return s.localPort
    }

    fun stop() {
        running = false
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        socket = null
        pool.shutdownNow()
    }

    private fun serve(client: Socket) {
        client.use { c ->
            c.soTimeout = 20_000
            val input = BufferedInputStream(c.getInputStream())
            val output = BufferedOutputStream(c.getOutputStream())
            try {
                val requestLine = readLine(input) ?: return
                val parts = requestLine.split(' ')
                if (parts.size < 2) return
                val method = parts[0]
                val path = parts[1].substringBefore('?')

                var contentLength = 0
                var auth = ""
                while (true) {
                    val line = readLine(input) ?: break
                    if (line.isEmpty()) break
                    val idx = line.indexOf(':')
                    if (idx <= 0) continue
                    val k = line.substring(0, idx).trim().lowercase()
                    val v = line.substring(idx + 1).trim()
                    when (k) {
                        "content-length" -> contentLength = v.toIntOrNull() ?: 0
                        "x-sync-token" -> auth = v
                    }
                }

                when {
                    method == "GET" && path == "/ping" -> respond(output, 200, "text/plain", "ok".toByteArray())
                    method == "POST" && path == "/sync" -> {
                        if (auth != token) {
                            respond(output, 403, "text/plain", "token 不匹配".toByteArray())
                            return
                        }
                        if (contentLength <= 0 || contentLength > MAX_BODY) {
                            respond(output, 413, "text/plain", "载荷过大".toByteArray())
                            return
                        }
                        val body = ByteArray(contentLength)
                        var read = 0
                        while (read < contentLength) {
                            val n = input.read(body, read, contentLength - read)
                            if (n < 0) break
                            read += n
                        }
                        val reply = handler(body)
                        respond(output, 200, "application/octet-stream", reply)
                    }
                    else -> respond(output, 404, "text/plain", "not found".toByteArray())
                }
            } catch (_: Exception) {
                try {
                    respond(output, 500, "text/plain", "error".toByteArray())
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun respond(out: BufferedOutputStream, code: Int, type: String, body: ByteArray) {
        val head = "HTTP/1.1 $code ${if (code == 200) "OK" else "ERR"}\r\n" +
            "Content-Type: $type\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }

    private fun readLine(input: BufferedInputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toInt().toChar())
            if (sb.length > 8192) return null
        }
        return sb.toString()
    }

    companion object {
        const val MAX_BODY = 8 * 1024 * 1024

        /**
         * 找一个局域网 IPv4 地址给对端连。
         * 优先 wlan 网段（192.168 / 10. / 172.16-31），因为手机常常同时挂着 VPN / 蜂窝。
         */
        fun localAddress(): String? {
            val candidates = ArrayList<Pair<String, String>>()
            try {
                for (nif in NetworkInterface.getNetworkInterfaces()) {
                    if (!nif.isUp || nif.isLoopback) continue
                    val name = nif.name.lowercase()
                    for (addr in nif.inetAddresses) {
                        if (addr !is Inet4Address || addr.isLoopbackAddress) continue
                        val ip = addr.hostAddress ?: continue
                        if (!isPrivate(ip)) continue
                        candidates.add(name to ip)
                    }
                }
            } catch (_: Exception) {
                return null
            }
            if (candidates.isEmpty()) return null
            candidates.sortBy { (name, ip) ->
                when {
                    name.startsWith("wlan") -> 0
                    name.contains("wi-fi") || name.contains("wifi") -> 0
                    name.startsWith("ap") -> 2
                    ip.startsWith("192.168.") -> 1
                    ip.startsWith("10.") -> 3
                    else -> 4
                }
            }
            return candidates.first().second
        }

        private fun isPrivate(ip: String): Boolean =
            ip.startsWith("192.168.") || ip.startsWith("10.") ||
                Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(ip)
    }
}
