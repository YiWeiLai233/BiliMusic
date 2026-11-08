package com.bilimusic.player.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 配对串解析。扫码拿到的就是一串文本，解析错了会连到错误地址干等 15 秒，
 * 所以这里把现实里会遇到的各种脏输入都钉住。
 */
class PairUriTest {

    @Test
    fun parses_canonical_payload() {
        val p = PairUri.parse("bilimusic://pair?ip=192.168.1.23&port=47821&token=abc123def456")
        assertEquals("192.168.1.23", p?.ip)
        assertEquals(47821, p?.port)
        assertEquals("abc123def456", p?.token)
    }

    /** 桌面端将来改渲染顺序、加上额外字段，手机端不能因此挂掉 */
    @Test
    fun tolerates_extra_fields_and_any_order() {
        val p = PairUri.parse("bilimusic://pair?token=zzz&name=PC&ip=10.0.0.5&port=1234&v=2")
        assertEquals("10.0.0.5", p?.ip)
        assertEquals(1234, p?.port)
        assertEquals("zzz", p?.token)
    }

    @Test
    fun accepts_plain_query_without_scheme() {
        // 用户把二维码内容复制成文本发过来，或者手输时漏了前缀
        val p = PairUri.parse("ip=192.168.0.8&port=5000&token=k")
        assertEquals("192.168.0.8", p?.ip)
        assertEquals(5000, p?.port)
    }

    @Test
    fun accepts_host_with_embedded_port() {
        val p = PairUri.parse("bilimusic://pair?host=192.168.1.7:6666&token=t")
        assertEquals("192.168.1.7", p?.ip)
        assertEquals(6666, p?.port)
    }

    @Test
    fun decodes_percent_escapes() {
        val p = PairUri.parse("bilimusic://pair?ip=192.168.1.9&port=700&token=a%2Db%20c")
        assertEquals("a-b c", p?.token)
    }

    @Test
    fun rejects_missing_fields() {
        assertNull(PairUri.parse("bilimusic://pair?ip=192.168.1.2&port=1"))
        assertNull(PairUri.parse("bilimusic://pair?ip=192.168.1.2&token=x"))
        assertNull(PairUri.parse("bilimusic://pair?port=1&token=x"))
    }

    @Test
    fun rejects_bad_port() {
        assertNull(PairUri.parse("bilimusic://pair?ip=192.168.1.2&port=0&token=x"))
        assertNull(PairUri.parse("bilimusic://pair?ip=192.168.1.2&port=70000&token=x"))
        assertNull(PairUri.parse("bilimusic://pair?ip=192.168.1.2&port=abc&token=x"))
    }

    /** 不能因为扫到一个诡异二维码就让 App 去连外网地址 */
    @Test
    fun rejects_non_ipv4_hosts() {
        assertNull(PairUri.parse("bilimusic://pair?ip=evil.example.com&port=80&token=x"))
        assertNull(PairUri.parse("bilimusic://pair?ip=192.168.1&port=80&token=x"))
        assertNull(PairUri.parse("bilimusic://pair?ip=999.1.1.1&port=80&token=x"))
        assertNull(PairUri.parse("bilimusic://pair?ip=&port=80&token=x"))
    }

    @Test
    fun rejects_garbage() {
        assertNull(PairUri.parse(null))
        assertNull(PairUri.parse(""))
        assertNull(PairUri.parse("   "))
        assertNull(PairUri.parse("https://www.bilibili.com"))
        assertNull(PairUri.parse("这不是码"))
    }

    /** 用户扫码时可能顺手扫到 B 站视频二维码，别把它当配对串 */
    @Test
    fun rejects_bilibili_video_qr() {
        assertNull(PairUri.parse("https://b23.tv/BV1fx411c7mD"))
        assertNull(PairUri.parse("https://www.bilibili.com/video/BV1fx411c7mD?p=2&token=x&port=1&ip=1.2.3.4"))
    }

    @Test
    fun ipv4_checker() {
        assertTrue(PairUri.isLikelyIpv4("0.0.0.0"))
        assertTrue(PairUri.isLikelyIpv4("255.255.255.255"))
        assertFalse(PairUri.isLikelyIpv4("256.1.1.1"))
        assertFalse(PairUri.isLikelyIpv4("1.2.3"))
        assertFalse(PairUri.isLikelyIpv4("1.2.3.4.5"))
        assertFalse(PairUri.isLikelyIpv4("a.b.c.d"))
        assertFalse(PairUri.isLikelyIpv4(""))
    }

    /** 手机端出的串，桌面端正则必须认；这里至少锁住自己产出的格式 */
    @Test
    fun roundtrip_through_url() {
        val p = PairInfo("192.168.1.23", 47821, "abc")
        val text = "bilimusic://pair?ip=${p.ip}&port=${p.port}&token=${p.token}"
        assertEquals("http://192.168.1.23:47821", p.url())
        assertEquals(p, PairUri.parse(text))
    }
}
