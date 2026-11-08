package com.bilimusic.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 播放取流的请求头回归测试。
 *
 * 背景：曾经所有歌曲都提示「音频地址被拒绝」，根因是取流时用了 Android UA，
 * B 站音视频 CDN（upos-*.bilivideo.com）对含 `Android` 的 UA 直接回 403 nginx 页面。
 * 实测同一台机器、同一条直链：桌面 UA → 200 / Android UA → 403。
 *
 * 这个测试的意义是把「UA 里不能有 Android」「Referer 必须是 bilibili.com」两条
 * 硬性要求钉死，避免以后有人为了「看起来更像手机客户端」把 UA 改回去又踩一遍。
 */
class PlayerHolderHeaderTest {

    /**
     * 直接读被测常量。
     * media3 的 `DefaultHttpDataSource.Factory` 只有 setter，没有 getter，
     * 所以 [PlayerHolder.httpDataSourceFactory] 用的是同一个 [PlayerHolder.CDN_REQUEST_HEADERS]，
     * 断言这个 Map 就等于断言实际发出去的请求头。
     */
    private fun properties(): Map<String, String> = PlayerHolder.CDN_REQUEST_HEADERS

    @Test
    fun cdn_user_agent_must_not_contain_android() {
        val ua = PlayerHolder.CDN_UA
        assertFalse(
            "取流 UA 不能含 Android —— B 站 CDN 会用 403 拒绝（这就是「音频地址被拒绝」的根因），实际是：$ua",
            ua.contains("Android", ignoreCase = true)
        )
    }

    @Test
    fun cdn_user_agent_should_look_like_desktop_chrome() {
        val ua = PlayerHolder.CDN_UA
        assertTrue("取流 UA 应该是桌面浏览器串：$ua", ua.contains("Windows NT") || ua.contains("Macintosh"))
        assertTrue("取流 UA 应该带 Chrome 版本号：$ua", ua.contains("Chrome/"))
    }

    @Test
    fun request_properties_carry_bilibili_referer() {
        val referer = properties()["Referer"]
        assertTrue("必须带 Referer，否则 CDN 也回 403", referer != null && referer.isNotBlank())
        assertTrue("Referer 必须指向 bilibili.com，实际是：$referer", referer!!.contains("bilibili.com"))
    }

    @Test
    fun referer_is_exactly_the_desktop_origin() {
        assertEquals(
            "Referer 用桌面站点首页，实测 200；写成 m.bilibili.com 不会救回被拦的 UA",
            "https://www.bilibili.com/",
            properties()["Referer"]
        )
    }

    @Test
    fun origin_header_is_present() {
        assertEquals(
            "B 站 CDN 会看 Origin，别删",
            "https://www.bilibili.com",
            properties()["Origin"]
        )
    }

    /**
     * API 层和取流层用的是**两个不同的 UA**，这是刻意的：
     * - API（BiliClient.UA）保持手机形态，登录 / 收藏夹走的是网页接口，没问题；
     * - 取流（CDN_UA）必须是桌面形态，否则 CDN 403。
     *
     * 如果有人「顺手统一一下」把两者合并，这里会失败，提醒他别这么干。
     */
    @Test
    fun api_and_cdn_user_agents_are_intentionally_different() {
        val apiUa = com.bilimusic.player.net.BiliClient.UA
        assertTrue("API 层 UA 保持手机形态（网页接口不接受无 UA，手机串实测可用）", apiUa.contains("Android"))
        assertFalse("取流层 UA 不能是手机形态", PlayerHolder.CDN_UA.contains("Android", ignoreCase = true))
        assertTrue("两者应该是不同的串，别合并", apiUa != PlayerHolder.CDN_UA)
    }
}
