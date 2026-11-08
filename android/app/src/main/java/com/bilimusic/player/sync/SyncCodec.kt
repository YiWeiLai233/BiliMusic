package com.bilimusic.player.sync

import kotlinx.serialization.json.Json
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * 同步载荷的编解码。
 *
 * 两种面向用户的通道，共用同一份二进制载荷：
 *  1. **文本同步码**：一串 base64url，可以直接粘进微信/QQ 发给另一台设备。
 *  2. **二维码分片**：同样的载荷切成 N 片，每片一个二维码，扫完拼回来。
 *     一屏放不下就用「多张码」这个最土但最可靠的办法，不需要任何服务器。
 *
 * 载荷 = [头部 10 字节] + deflate(JSON)。
 * 头部里带 CRC32 和分片信息，扫错/扫漏能被立刻发现，不会把坏数据合进库里。
 */
object SyncCodec {

    private const val MAGIC0 = 0x42 // 'B'
    private const val MAGIC1 = 0x4D // 'M'
    private const val FORMAT_VERSION = 1
    private const val HEADER = 10
    private const val COMPRESS_THRESHOLD = 96

    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    // ---------------- 整包编解码 ----------------

    fun encode(doc: SyncDoc): String = Base64Url.encode(pack(doc))

    fun decode(text: String): SyncDoc {
        val cleaned = text.trim().filterNot { it.isWhitespace() }
        val bytes = Base64Url.decode(cleaned)
        return unpack(bytes)
    }

    fun pack(doc: SyncDoc): ByteArray {
        val raw = json.encodeToString(SyncDoc.serializer(), doc).toByteArray(Charsets.UTF_8)
        val body = if (raw.size >= COMPRESS_THRESHOLD) deflate(raw) else raw
        val flags = if (raw.size >= COMPRESS_THRESHOLD && body.size < raw.size) FLAG_DEFLATE else 0
        val crc = crc32(body)

        val out = ByteArray(HEADER + body.size)
        out[0] = MAGIC0.toByte()
        out[1] = MAGIC1.toByte()
        out[2] = FORMAT_VERSION.toByte()
        out[3] = flags.toByte()
        out[4] = 1 // seq
        out[5] = 1 // total
        putInt(out, 6, crc.toInt())
        System.arraycopy(body, 0, out, HEADER, body.size)
        return out
    }

    fun unpack(bytes: ByteArray): SyncDoc {
        if (bytes.size < HEADER) throw SyncException("同步码太短")
        if (bytes[0] != MAGIC0.toByte() || bytes[1] != MAGIC1.toByte()) {
            throw SyncException("这不是 BiliMusic 的同步码")
        }
        val ver = bytes[2].toInt()
        if (ver != FORMAT_VERSION) throw SyncException("同步码格式版本不支持：$ver")
        val flags = bytes[3].toInt()
        val crc = getInt(bytes, 6).toLong() and 0xFFFFFFFFL
        val body = bytes.copyOfRange(HEADER, bytes.size)
        if (crc32(body) != crc) throw SyncException("同步码校验失败，可能复制时丢字符了")
        val raw = if (flags and FLAG_DEFLATE != 0) inflate(body) else body
        return try {
            json.decodeFromString(SyncDoc.serializer(), raw.toString(Charsets.UTF_8))
        } catch (e: Exception) {
            throw SyncException("同步码内容解析失败：${e.message}")
        }
    }

    // ---------------- 二维码分片 ----------------

    fun packChunks(doc: SyncDoc, maxChunkBytes: Int): List<String> {
        val total = pack(doc)
        val crc = crc32(total)
        val maxData = (maxChunkBytes - HEADER).coerceAtLeast(64)
        val count = ((total.size + maxData - 1) / maxData).coerceAtLeast(1)
        if (count > 255) throw SyncException("歌单太大，二维码放不下；请改用文本同步码")

        val out = ArrayList<String>(count)
        for (i in 0 until count) {
            val from = i * maxData
            val to = minOf(total.size, from + maxData)
            val chunk = ByteArray(HEADER + (to - from))
            chunk[0] = MAGIC0.toByte()
            chunk[1] = MAGIC1.toByte()
            chunk[2] = FORMAT_VERSION.toByte()
            chunk[3] = FLAG_CHUNK.toByte()
            chunk[4] = i.toByte()
            chunk[5] = count.toByte()
            putInt(chunk, 6, crc.toInt())
            System.arraycopy(total, from, chunk, HEADER, to - from)
            out.add(Base64Url.encode(chunk))
        }
        return out
    }

    /** 逐片收集，够数了拼回原文 */
    class ChunkAssembler {
        private var crc = 0L
        private var total = 0
        private val parts = HashMap<Int, ByteArray>()

        val received: Int get() = parts.size
        val expected: Int get() = total
        val complete: Boolean get() = total > 0 && parts.size == total

        /** @return true 表示这一片是新片 */
        fun offer(text: String): Boolean {
            val b = Base64Url.decode(text.trim().filterNot { it.isWhitespace() })
            if (b.size <= HEADER) throw SyncException("分片太短")
            if (b[0] != MAGIC0.toByte() || b[1] != MAGIC1.toByte()) throw SyncException("不是本应用的二维码")
            if (b[3].toInt() and FLAG_CHUNK == 0) throw SyncException("这是一个完整码，不需要拼")
            val seq = b[4].toInt() and 0xFF
            val cnt = b[5].toInt() and 0xFF
            val thisCrc = getInt(b, 6).toLong() and 0xFFFFFFFFL
            if (cnt <= 0) throw SyncException("分片信息无效")
            if (total != 0 && total != cnt) throw SyncException("混入了另一次同步的二维码")
            total = cnt
            crc = thisCrc
            val data = b.copyOfRange(HEADER, b.size)
            val existed = parts.put(seq, data) != null
            return !existed
        }

        fun assemble(): SyncDoc {
            if (!complete) throw SyncException("还差 ${total - parts.size} 张二维码")
            val bos = ByteArrayOutputStream()
            for (i in 0 until total) {
                val d = parts[i] ?: throw SyncException("缺少第 ${i + 1} 张二维码")
                bos.write(d)
            }
            val bytes = bos.toByteArray()
            if (crc32(bytes) != crc) throw SyncException("分片校验失败，重新扫一遍")
            return unpack(bytes)
        }

        fun reset() {
            parts.clear()
            total = 0
            crc = 0
        }
    }

    // ---------------- 底层 ----------------

    private const val FLAG_DEFLATE = 1
    private const val FLAG_CHUNK = 2

    private fun deflate(src: ByteArray): ByteArray {
        val d = Deflater(Deflater.BEST_COMPRESSION, true)
        d.setInput(src)
        d.finish()
        val out = ByteArrayOutputStream(src.size / 2 + 64)
        val buf = ByteArray(8192)
        while (!d.finished()) {
            val n = d.deflate(buf)
            if (n > 0) out.write(buf, 0, n) else break
        }
        d.end()
        return out.toByteArray()
    }

    private fun inflate(src: ByteArray): ByteArray {
        val inf = Inflater(true)
        inf.setInput(src)
        val out = ByteArrayOutputStream(src.size * 3 + 64)
        val buf = ByteArray(8192)
        try {
            while (!inf.finished()) {
                val n = inf.inflate(buf)
                if (n > 0) out.write(buf, 0, n) else if (inf.needsInput()) break
            }
        } catch (e: Exception) {
            throw SyncException("同步码解压失败")
        } finally {
            inf.end()
        }
        return out.toByteArray()
    }

    private fun crc32(b: ByteArray): Long {
        val c = CRC32()
        c.update(b)
        return c.value
    }

    private fun putInt(a: ByteArray, off: Int, v: Int) {
        a[off] = (v ushr 24).toByte()
        a[off + 1] = (v ushr 16).toByte()
        a[off + 2] = (v ushr 8).toByte()
        a[off + 3] = v.toByte()
    }

    private fun getInt(a: ByteArray, off: Int): Int =
        ((a[off].toInt() and 0xFF) shl 24) or
            ((a[off + 1].toInt() and 0xFF) shl 16) or
            ((a[off + 2].toInt() and 0xFF) shl 8) or
            (a[off + 3].toInt() and 0xFF)
}

class SyncException(message: String) : Exception(message)

/**
 * 不依赖 android.util.Base64（那是 API 26+，且单元测试里跑不了）。
 * base64url 无填充，复制粘贴时不会有 `+` `/` `=` 被各种聊天软件吃掉的问题。
 */
object Base64Url {
    private const val T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val INV = IntArray(128) { -1 }.also { a ->
        for (i in T.indices) a[T[i].code] = i
    }

    fun encode(src: ByteArray): String {
        val sb = StringBuilder((src.size + 2) / 3 * 4)
        var i = 0
        while (i < src.size) {
            val b0 = src[i].toInt() and 0xFF
            val b1 = if (i + 1 < src.size) src[i + 1].toInt() and 0xFF else 0
            val b2 = if (i + 2 < src.size) src[i + 2].toInt() and 0xFF else 0
            sb.append(T[b0 ushr 2])
            sb.append(T[((b0 and 0x03) shl 4) or (b1 ushr 4)])
            if (i + 1 < src.size) sb.append(T[((b1 and 0x0F) shl 2) or (b2 ushr 6)])
            if (i + 2 < src.size) sb.append(T[b2 and 0x3F])
            i += 3
        }
        return sb.toString()
    }

    fun decode(text: String): ByteArray {
        val s = text.trim().trimEnd('=')
        val out = ByteArrayOutputStream(s.length * 3 / 4 + 3)
        var buf = 0
        var bits = 0
        for (ch in s) {
            val c = ch.code
            val v = if (c < 128) INV[c] else -1
            if (v < 0) {
                if (ch.isWhitespace()) continue
                // 兼容用户从别处粘来的标准 base64
                val alt = when (ch) { '+' -> 62; '/' -> 63; else -> -1 }
                if (alt < 0) throw SyncException("同步码里有非法字符「$ch」")
                buf = (buf shl 6) or alt
            } else {
                buf = (buf shl 6) or v
            }
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buf ushr bits) and 0xFF)
            }
        }
        return out.toByteArray()
    }
}
