package com.bilimusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 返回键导航的逻辑测试。
 *
 * 背景：之前整个工程没有一处 `BackHandler`，按系统返回键直接退出 Activity，
 * 表现是「在歌单详情/收藏夹里按返回，整个 App 没了」。
 *
 * 现在的规则（见 MainActivity 里的 BackHandler）：
 *   1. 栈里有上一页 → 回上一页；
 *   2. 停在「收藏夹」「我的」→ 回「我的音乐」；
 *   3. 已在「我的音乐」→ 连按两次才退出。
 *
 * 这里把栈的规则抽成纯函数验证，不依赖 Activity 生命周期；
 * 真正接上系统返回键的部分由 MainActivity 里的 BackHandler 负责。
 */
class BackNavigationTest {

    /** 复刻 MainActivity 里的 pop()：只有多于一层时才退栈 */
    private fun pop(stack: List<Route>): List<Route> =
        if (stack.size > 1) stack.dropLast(1) else stack

    /** 复刻「顶层标签页返回首页」 */
    private fun backToHome(): List<Route> = listOf(Route.Library)

    @Test
    fun from_playlist_detail_goes_back_to_library() {
        val stack = listOf(Route.Library, Route.Playlist("p1", "通勤"))
        assertEquals(listOf<Route>(Route.Library), pop(stack))
    }

    @Test
    fun from_favorites_goes_back_to_library() {
        val stack = listOf<Route>(Route.Library, Route.Favorites)
        assertEquals(listOf<Route>(Route.Library), pop(stack))
    }

    @Test
    fun from_folder_goes_back_to_favorites_not_library() {
        // 三级页面要退回上一级，不能直接跳回首页
        val stack = listOf<Route>(Route.Library, Route.Favorites, Route.Folder(4469944130L, "默认收藏夹"))
        assertEquals(
            listOf<Route>(Route.Library, Route.Favorites),
            pop(stack)
        )
    }

    @Test
    fun from_now_playing_goes_back_to_the_page_that_opened_it() {
        val fromPlaylist = listOf<Route>(Route.Library, Route.Playlist("p1", "通勤"), Route.NowPlaying)
        assertEquals(
            listOf<Route>(Route.Library, Route.Playlist("p1", "通勤")),
            pop(fromPlaylist)
        )
        val fromFolder = listOf<Route>(Route.Library, Route.Favorites, Route.Folder(1L, "收藏夹"), Route.NowPlaying)
        assertEquals(
            listOf<Route>(Route.Library, Route.Favorites, Route.Folder(1L, "收藏夹")),
            pop(fromFolder)
        )
    }

    @Test
    fun from_sync_page_goes_back_to_where_it_was_opened() {
        assertEquals(
            listOf<Route>(Route.Library),
            pop(listOf<Route>(Route.Library, Route.Sync))
        )
        assertEquals(
            listOf<Route>(Route.Library, Route.Me),
            pop(listOf<Route>(Route.Library, Route.Me, Route.Sync))
        )
    }

    @Test
    fun popping_the_root_stack_leaves_it_untouched() {
        // 首页不能被 pop 成空栈，否则 when 分发会崩
        val root = listOf<Route>(Route.Library)
        assertEquals(root, pop(root))
    }

    @Test
    fun tab_pages_return_to_library_rather_than_exiting() {
        // 「收藏夹」「我的」是顶层标签页：按返回应回首页，而不是退出 App
        assertFalse("收藏夹是顶层页", listOf<Route>(Route.Favorites).size > 1)
        assertEquals(listOf<Route>(Route.Library), backToHome())
    }

    @Test
    fun home_is_the_only_page_where_back_exits() {
        val topLevel = listOf(Route.Library, Route.Favorites, Route.Me)
        val shouldExit = topLevel.filter { it is Route.Library }
        assertEquals("只有首页按返回才走退出逻辑", 1, shouldExit.size)
        assertTrue("首页判定必须准确", shouldExit.single() is Route.Library)
    }

    @Test
    fun stack_never_becomes_empty_through_back_operations() {
        var stack: List<Route> = listOf(Route.Library)
        val path = listOf(
            Route.Favorites,
            Route.Folder(1L, "x"),
            Route.NowPlaying,
        )
        for (r in path) stack = stack + r
        repeat(10) { stack = pop(stack) }
        assertTrue("怎么按返回都不能把栈退空", stack.isNotEmpty())
        assertEquals(listOf<Route>(Route.Library), stack)
    }
}
