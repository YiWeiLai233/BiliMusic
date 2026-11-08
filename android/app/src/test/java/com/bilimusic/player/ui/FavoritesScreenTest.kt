package com.bilimusic.player.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 收藏夹页「闪退」的回归测试（真实页面结构）。
 *
 * FavoritesKeyTest 用最小列表验证了「同一个 LazyColumn 里重复 key 必崩」这个机制；
 * 这里再进一步：用与 FavoritesScreen 里**同样的分组结构**渲染，
 * 确认修复后「同一个收藏夹既在已同步分组、又在账号分组」能正常渲染。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FavoritesScreenTest {

    @get:Rule
    val compose = createComposeRule()

    /** 修复后的组合：同一收藏夹同时出现在两个分组，不应崩 */
    @Test
    fun same_folder_in_both_groups_renders() {
        var crashed: Throwable? = null
        try {
            compose.setContent { FavoritesListHarness(count = 1) }
            compose.waitForIdle()
        } catch (e: Throwable) {
            crashed = e
        }
        assertTrue("同一收藏夹出现在两个分组时不应崩溃：${crashed?.message}", crashed == null)
    }

    /** 多收藏夹、且全部重合的场景（关注了整个账号收藏夹的常见状态） */
    @Test
    fun many_overlapping_folders_render() {
        var crashed: Throwable? = null
        try {
            compose.setContent { FavoritesListHarness(count = 12) }
            compose.waitForIdle()
        } catch (e: Throwable) {
            crashed = e
        }
        assertTrue("多个收藏夹全部重合时不应崩溃：${crashed?.message}", crashed == null)
    }

    /** 只有账号列表、还没有任何已同步时也要正常（否则会漏掉「没同步过也崩」的情况） */
    @Test
    fun account_only_renders() {
        var crashed: Throwable? = null
        try {
            compose.setContent { FavoritesListHarness(count = 5, mirrored = false) }
            compose.waitForIdle()
        } catch (e: Throwable) {
            crashed = e
        }
        assertTrue("只有账号列表时不应崩溃：${crashed?.message}", crashed == null)
    }
}

/**
 * 复刻 FavoritesScreen 里 LazyColumn 的分组结构（已同步段 + 账号段），
 * 用固定假数据，避免依赖网络与登录态。
 */
@Composable
private fun FavoritesListHarness(count: Int, mirrored: Boolean = true) {
    val ids = (1..count).map { 4469944100L + it }
    LazyColumn {
        if (mirrored) {
            item { Text("已同步 · ${ids.size}") }
            items(ids, key = { folderListKey(it, mirrored = true) }) { id ->
                Text("mirror $id")
            }
            item { Spacer(Modifier.height(14.dp)) }
        }
        item { Text("账号里的收藏夹 · ${ids.size}") }
        items(ids, key = { folderListKey(it, mirrored = false) }) { id ->
            Text("account $id")
        }
    }
}
