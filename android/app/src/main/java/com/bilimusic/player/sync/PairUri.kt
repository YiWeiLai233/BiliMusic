package com.bilimusic.player.sync

/**
 * 配对信息（`bilimusic://pair?ip=..&port=..&token=..`）。
 *
 * 桌面端把它渲成二维码，手机扫一下就不用再手抄 IP 和口令。
 * 解析写成纯函数（不依赖 android.net.Uri），这样能在 JVM 单测里直接跑。
 */
data class PairInfo(val ip: String, val port: Int, val token: String) {
    fun url(): String = "http://$ip:$port"
}

object PairUri {

    const val SCHEME = "bilimusic://pair?"

    /**
     * 解析任意可能含配对串的文本：扫码结果、粘贴的一坨、手输的也行。
     * 找不到合法 ip/port/token 就返回 null（不抛异常）。
     */
    fun parse(text: String?): PairInfo? {
        if (text.isNullOrBlank()) return null
        val t = text.trim()

        // 扫到的可能是别的 App 的二维码（B 站视频、Wi-Fi 配网……）。
        // 凡是带「://」却不是我们自己的 scheme 的，一律不认——哪怕它的 query
        // 里恰好凑齐了 ip/port/token（B 站视频链接带上 ?p=2&token=..&ip=.. 就很像）。
        val schemeAt = t.indexOf("://")
        if (schemeAt >= 0) {
            val scheme = t.substring(0, schemeAt).lowercase()
            if (scheme != "bilimusic") return null
        }

        // 允许扫到的是完整 URL，也允许对方只贴了参数部分
        val q = when {
            t.startsWith(SCHEME) -> t.substring(SCHEME.length)
            t.contains("?") -> t.substringAfter('?')
            else -> t
        }

        val map = LinkedHashMap<String, String>()
        for (kv in q.split('&', ';')) {
            if (kv.isEmpty()) continue
            val i = kv.indexOf('=')
            if (i <= 0) continue
            val k = kv.substring(0, i).trim().lowercase()
            val v = unescape(kv.substring(i + 1).trim())
            if (k.isNotEmpty() && v.isNotEmpty()) map[k] = v
        }

        // host/port 有时也写成 host=1.2.3.4:5678 或 addr= 形式
        var ip = map["ip"] ?: map["host"] ?: map["addr"] ?: ""
        var portText = map["port"] ?: ""
        if (portText.isEmpty() && ip.contains(':')) {
            portText = ip.substringAfterLast(':')
            ip = ip.substringBeforeLast(':')
        }

        val port = portText.toIntOrNull() ?: return null
        if (port !in 1..65535) return null
        if (!isLikelyIpv4(ip)) return null

        val token = map["token"] ?: map["pass"] ?: map["key"] ?: return null
        if (token.isEmpty()) return null

        return PairInfo(ip, port, token)
    }

    /** 只认 IPv4 字面量——局域网配对不需要域名，也避免被奇怪输入骗去连外网。 */
    fun isLikelyIpv4(s: String): Boolean {
        if (s.isEmpty() || s.length > 15) return false
        val parts = s.split('.')
        if (parts.size != 4) return false
        for (p in parts) {
            if (p.isEmpty() || p.length > 3) return false
            if (!p.all { it in '0'..'9' }) return false
            val n = p.toIntOrNull() ?: return false
            if (n !in 0..255) return false
        }
        return true
    }

    private fun unescape(s: String): String {
        if (!s.contains('%')) return s
        val out = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length) {
                val hex = s.substring(i + 1, i + 3)
                val code = hex.toIntOrNull(16)
                if (code != null) {
                    out.append(code.toChar())
                    i += 3
                    continue
                }
            }
            out.append(c)
            i++
        }
        return out.toString()
    }
}
