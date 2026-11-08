package com.bilimusic.player

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 启动冒烟：在 JVM 上真实执行 Application.onCreate 与 MainActivity.onCreate。
 *
 * 手机上「装完点开就崩」这类问题，静态审查很难定位（真正的异常发生在
 * framework 初始化、主题解析、Compose 首次组合里）。这里用 Robolectric
 * 把那两条路径原样跑一遍，异常会以堆栈形式暴露出来。
 */
@RunWith(RobolectricTestRunner::class)
// 覆盖 minSdk(24) 到 targetSdk(35)：同一个启动路径在不同系统版本上的
// framework 行为差别很大，只测一个版本容易漏掉只在特定 SDK 上出现的崩溃。
@Config(sdk = [24, 34, 35])
class StartupTest {

    @Test
    fun application_onCreate_succeeds() {
        val app = ApplicationProvider.getApplicationContext<App>()
        assertNotNull("App.library 应在 onCreate 后可用", app.library)
        assertNotNull("App.bili 应在 onCreate 后可用", app.bili)
        assertNotNull("App.favStore 应在 onCreate 后可用", app.favStore)
        assertTrue("设备 id 应已生成", app.library.deviceId.isNotEmpty())
    }

    @Test
    fun settings_are_readable() {
        val app = ApplicationProvider.getApplicationContext<App>()
        // 这些属性在 UI 首帧就会被读到，取不到值同样会崩
        assertTrue(app.settings.playMode.isNotEmpty())
        assertTrue(app.settings.deviceName.isNotEmpty())
        app.settings.quality
        app.settings.volume
        app.settings.syncEnabled
    }

    @Test
    fun sync_coordinator_constructs() {
        val app = ApplicationProvider.getApplicationContext<App>()
        // SyncCoordinator 是 by lazy，UI 上点同步面板才会构造
        assertNotNull(app.sync)
        // 服务没启动时 pairingPayload() 返回空串（二维码区显示「先启动服务」），启动后才是配对串
        assertTrue(app.sync.pairingPayload().isEmpty())
        assertNotNull(app.sync.server)
    }

    @Test
    fun mainActivity_launches_without_crash() {
        Robolectric.buildActivity(MainActivity::class.java).setup()
    }
}
