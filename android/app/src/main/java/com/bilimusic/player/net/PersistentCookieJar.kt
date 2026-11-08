package com.bilimusic.player.net

import android.content.Context
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * 持久化 Cookie。桌面端是自己解析 Set-Cookie 字符串（src/bili.js:_absorbCookies），
 * 安卓端用 OkHttp 自带的 CookieJar 更好：它会正确处理 Domain / Path / 过期时间。
 * 唯一的额外工作是把 Cookie 序列化进 SharedPreferences，否则每次冷启动都要重扫码。
 */
class PersistentCookieJar(context: Context) : CookieJar {

    private val prefs = context.getSharedPreferences("bili_cookies", Context.MODE_PRIVATE)
    private val cache = LinkedHashMap<String, Cookie>()

    init {
        prefs.getString(KEY, null)?.let { raw ->
            for (line in raw.split("\n")) {
                if (line.isBlank()) continue
                val c = deserialize(line)
                if (c != null) cache[key(c)] = c
            }
        }
        purgeExpired()
    }

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        for (c in cookies) cache[key(c)] = c
        purgeExpired()
        flush()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        purgeExpired()
        return cache.values.filter { it.matches(url) }
    }

    @Synchronized
    fun cookieHeader(url: HttpUrl): String =
        loadForRequest(url).joinToString("; ") { "${it.name}=${it.value}" }

    @Synchronized
    fun has(name: String): Boolean =
        cache.values.any { it.name == name && it.value.isNotEmpty() && it.value != "deleted" }

    @Synchronized
    fun value(name: String): String? = cache.values.firstOrNull { it.name == name }?.value

    @Synchronized
    fun put(name: String, value: String, domain: String = ".bilibili.com") {
        val c = Cookie.Builder()
            .name(name).value(value).domain(domain).path("/").build()
        cache[key(c)] = c
        flush()
    }

    @Synchronized
    fun clear() {
        cache.clear()
        prefs.edit().remove(KEY).apply()
    }

    private fun purgeExpired() {
        val now = System.currentTimeMillis()
        cache.values.removeAll { it.expiresAt < now }
    }

    private fun key(c: Cookie) = "${c.name}@${c.domain}${c.path}"

    private fun flush() {
        val raw = cache.values.joinToString("\n") { serialize(it) }
        prefs.edit().putString(KEY, raw).apply()
    }

    private fun serialize(c: Cookie): String = listOf(
        c.name, c.value, c.expiresAt.toString(), c.domain, c.path,
        if (c.secure) "1" else "0", if (c.httpOnly) "1" else "0",
        if (c.hostOnly) "1" else "0",
    ).joinToString(SEP) { it.replace(SEP, " ") }

    private fun deserialize(line: String): Cookie? = try {
        val p = line.split(SEP)
        if (p.size < 8) null else Cookie.Builder()
            .name(p[0])
            .value(p[1])
            .expiresAt(p[2].toLongOrNull() ?: 0L)
            .domain(p[3].removePrefix("."))
            .apply { if (p[6] == "1") httpOnly() }
            .path(p[4])
            .apply { if (p[5] == "1") secure() }
            .build()
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val KEY = "jar"
        private const val SEP = "\u0001"
    }
}
