package com.bilimusic.player.sync

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 把整份同步文档发给对端，并取回对端的文档。
 *
 * 一次往返就能让两端收敛：我发我的，你拿我的合一份再发回来，
 * 我拿回来的那份再合一次。因为 merge 幂等，多合一次不会出错。
 */
object SyncClient {

    class Result(val remote: SyncDoc, val bytesIn: Int, val bytesOut: Int)

    fun exchange(host: String, port: Int, token: String, local: SyncDoc, timeoutMs: Int = 15_000): Result {
        val payload = SyncCodec.pack(local)
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), timeoutMs)
            socket.soTimeout = timeoutMs
            val out = socket.getOutputStream()
            val head = "POST /sync HTTP/1.1\r\n" +
                "Host: $host\r\n" +
                "X-Sync-Token: $token\r\n" +
                "Content-Type: application/octet-stream\r\n" +
                "Content-Length: ${payload.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(payload)
            out.flush()

            val input = BufferedInputStream(socket.getInputStream())
            val statusLine = readLine(input) ?: throw IOException("对端没有响应")
            val code = statusLine.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            var contentLength = -1
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx <= 0) continue
                if (line.substring(0, idx).trim().equals("Content-Length", true)) {
                    contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: -1
                }
            }
            if (code != 200) {
                throw IOException("对端返回 $code")
            }
            val body = if (contentLength >= 0) {
                val buf = ByteArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = input.read(buf, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                buf
            } else {
                val bout = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    bout.write(buf, 0, n)
                }
                bout.toByteArray()
            }
            return Result(SyncCodec.unpack(body), body.size, payload.size)
        } finally {
            try {
                socket.close()
            } catch (_: IOException) {
            }
        }
    }

    /** 探活，不需要 token */
    fun ping(host: String, port: Int, timeoutMs: Int = 2500): Boolean {
        val socket = Socket()
        return try {
            socket.connect(InetSocketAddress(host, port), timeoutMs)
            socket.soTimeout = timeoutMs
            val out = socket.getOutputStream()
            out.write("GET /ping HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n".toByteArray())
            out.flush()
            val line = readLine(BufferedInputStream(socket.getInputStream())) ?: return false
            line.contains("200")
        } catch (_: Exception) {
            false
        } finally {
            try {
                socket.close()
            } catch (_: IOException) {
            }
        }
    }

    private fun readLine(input: BufferedInputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toInt().toChar())
        }
        return sb.toString()
    }
}
