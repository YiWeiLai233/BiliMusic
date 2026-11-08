package com.bilimusic.player.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 收藏夹页闪退的回归测试。
 *
 * 事故经过：把「已同步的收藏夹」和「账号里的收藏夹」放在**同一个** LazyColumn 里，
 * 两处的 key 都直接用了收藏夹 id。已同步的收藏夹本来就在账号列表里，
 * 于是同一个 id 出现在两个 `items()` 中 —— LazyColumn 遇到重复 key 会直接抛异常，
 * 用户看到的就是「点开收藏夹闪退」。
 *
 * 这里不是在读源码猜，而是真的把两种写法各渲染一遍：
 * 重复 key 必须复现出崩溃，加了命名空间前缀的写法必须能正常渲染。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FavoritesKeyTest {

    @get:Rule
    val compose = createComposeRule()

    /** 修复前的写法：两段 items 的 key 都是裸 id */
    @Test
    fun duplicate_keys_in_one_lazy_column_crash() {
        var crashed: Throwable? = null
        try {
            compose.setContent {
                LazyColumn {
                    items(listOf(4469944130L), key = { it.toString() }) { Text("mirror $it") }
                    items(listOf(4469944130L), key = { it.toString() }) { Text("account $it") }
                }
            }
            compose.waitForIdle()
        } catch (e: Throwable) {
            crashed = e
        }

        assertTrue(
            "同一个 LazyColumn 里出现重复 key 必须复现崩溃（否则这个测试没有意义）",
            crashed != null,
        )
        val msg = generateSequence(crashed) { it.cause }.joinToString(" | ") { it.message.orEmpty() }
        assertTrue(
            "异常信息应该指向重复 key，实际是：$msg",
            msg.contains("Key", ignoreCase = true) || msg.contains("already", ignoreCase = true),
        )
    }

    /** 修复后的写法：两段 items 用不同的命名空间前缀 */
    @Test
    fun namespaced_keys_render_without_crash() {
        var crashed: Throwable? = null
        try {
            compose.setContent {
                Column {
                    LazyColumn {
                        items(listOf(4469944130L), key = { folderListKey(it, mirrored = true) }) {
                            Text("mirror $it")
                        }
                        items(listOf(4469944130L), key = { folderListKey(it, mirrored = false) }) {
                            Text("account $it")
                        }
                    }
                }
            }
            compose.waitForIdle()
        } catch (e: Throwable) {
            crashed = e
        }
        assertTrue("加了命名空间之后不应再崩：${crashed?.message}", crashed == null)
    }

    @Test
    fun same_folder_in_both_lists_yields_distinct_keys() {
        val id = 4469944130L
        assertNotEquals(folderListKey(id, mirrored = true), folderListKey(id, mirrored = false))
    }
}
