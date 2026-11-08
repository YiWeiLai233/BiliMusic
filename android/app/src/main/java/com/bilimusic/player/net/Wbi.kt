package com.bilimusic.player.net

import java.security.MessageDigest

/**
 * WBI 签名。移植自桌面端 src/bili.js 的 _ensureWbi / _signedParams。
 *
 * B 站把两个密钥（img_url / sub_url 的文件名）按一张固定的 64 项置换表重排，
 * 取前 32 位当盐，然后把「按 key 排序的查询串 + 盐」取 md5 作为 w_rid。
 * 表是写死的，所以除了接口本身变化之外这段逻辑不会失效。
 */
object Wbi {

    /** bili.js:21-26 的 MIXIN_TAB 原样搬过来 */
    val MIXIN_TAB = intArrayOf(
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
        27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
        37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
        22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    )

    /** 从 nav 的两个 url 里算出 mixinKey */
    fun mixinKey(imgUrl: String, subUrl: String): String {
        val img = fileName(imgUrl)
        val sub = fileName(subUrl)
        val orig = img + sub
        if (orig.length < 64) return ""
        val sb = StringBuilder(32)
        for (i in 0 until 32) sb.append(orig[MIXIN_TAB[i]])
        return sb.toString()
    }

    private fun fileName(url: String): String {
        val tail = url.substringAfterLast('/')
        return tail.substringBefore('.')
    }

    /** 和 encodeURIComponent 一致（然后去掉 !'()* —— B 站前端就是这么干的） */
    fun encodeValue(v: String): String {
        val sb = StringBuilder(v.length + 8)
        for (b in v.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xFF
            val ch = c.toChar()
            if (ch.isLetterOrDigit() && c < 0x80 || ch in "-_.~") {
                sb.append(ch)
            } else when (ch) {
                '!' , '\'', '(', ')', '*' -> Unit  // 直接丢掉
                ' ' -> sb.append("%20")
                else -> sb.append('%').append(HEX[c shr 4]).append(HEX[c and 0x0F])
            }
        }
        return sb.toString()
    }

    private val HEX = "0123456789ABCDEF".toCharArray()

    /** 按 key 升序拼查询串 */
    fun buildQuery(params: Map<String, String>): String =
        params.keys.sorted().joinToString("&") { "${encodeValue(it)}=${encodeValue(params[it] ?: "")}" }

    /** 加 wts 并签名，返回可直接接在 url 后面的查询串 */
    fun signed(params: Map<String, String>, mixin: String, nowSec: Long = System.currentTimeMillis() / 1000): String {
        val withTs = LinkedHashMap<String, String>(params.size + 1).apply {
            putAll(params)
            put("wts", nowSec.toString())
        }
        val q = buildQuery(withTs)
        return "$q&w_rid=${md5(q + mixin)}"
    }

    fun md5(s: String): String {
        val d = MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(32)
        for (b in d) {
            val v = b.toInt() and 0xFF
            sb.append(HEX[v shr 4]).append(HEX[v and 0x0F])
        }
        return sb.toString().lowercase()
    }
}
