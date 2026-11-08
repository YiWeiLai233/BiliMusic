package com.bilimusic.player

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bilimusic.player.ui.BgDeep
import com.bilimusic.player.ui.BgPanel
import com.bilimusic.player.ui.BiliTheme
import com.bilimusic.player.ui.BiliViewModel
import com.bilimusic.player.ui.Brand
import com.bilimusic.player.ui.FavoritesScreen
import com.bilimusic.player.ui.FolderScreen
import com.bilimusic.player.ui.LibraryScreen
import com.bilimusic.player.ui.LibraryTracksScreen
import com.bilimusic.player.ui.MeScreen
import com.bilimusic.player.ui.NowPlayingScreen
import com.bilimusic.player.ui.PlayerBar
import com.bilimusic.player.ui.PlaylistScreen
import com.bilimusic.player.ui.SyncScreen
import com.bilimusic.player.ui.TextPrimary
import com.bilimusic.player.ui.TextSecondary
import com.bilimusic.player.ui.Toast

/**
 * 单 Activity + 手写路由。
 *
 * 不用 Navigation-Compose 的原因：页面只有六七个，而且「歌单详情」这类页面
 * 需要携带简单参数（id/title），用一个 sealed class 栈比 navArgs 更好读，
 * 也省掉一条依赖。
 */
sealed interface Route {
    data object Library : Route

    /** 「我的库」：库里全部曲目（链接收藏导入的歌只能从这里看到） */
    data object LibraryTracks : Route
    data class Playlist(val id: String, val title: String) : Route
    data object Favorites : Route
    data class Folder(val id: Long, val title: String) : Route
    data object Me : Route
    data object Sync : Route
    data object NowPlaying : Route
}

/**
 * 顶层页连按两次退出的时间窗口（毫秒）。
 * 2 秒是 Android 上的惯例值（Toast 展示时长同量级），太短容易反复误触。
 */
private const val EXIT_WINDOW_MS = 2000L

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            BiliTheme {
                AppRoot()
            }
        }
    }
}

@Composable
fun AppRoot() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val vm: BiliViewModel = viewModel()
    val stack = remember { mutableStateOf<List<Route>>(listOf(Route.Library)) }
    val player by vm.player.collectAsState()
    val toast by vm.toast.collectAsState()
    val playlists by vm.playlists.collectAsState()

    // 有歌在播放时底部留出播放条的高度
    val hasBar = player.current != null

    fun push(r: Route) {
        stack.value = stack.value + r
    }

    fun pop() {
        if (stack.value.size > 1) stack.value = stack.value.dropLast(1)
    }

    // ---- 系统返回键 ----
    // 之前整个工程没有一处 BackHandler，按返回键直接退出 Activity，
    // 表现就是「在二级页面按返回，整个 App 没了」。
    //
    // 现在的规则（按返回键）：
    //   1. 栈里有上一页（歌单详情 / 收藏夹 / 同步页 / 播放页）→ 回到上一页；
    //   2. 停在「收藏夹」「我的」这两个顶层标签页 → 回到「我的音乐」；
    //   3. 已在「我的音乐」（首页）→ 连按两次才退出到桌面，
    //      第一次只提示「再按一次退出」，避免手滑把 App 关掉。
    //
    // 用 LocalActivity 而不是 `context as Activity`：context 可能是 ContextWrapper，
    // 直接强转在部分机型上会 ClassCastException。
    val activity = androidx.activity.compose.LocalActivity.current
    var lastBackAt by remember { androidx.compose.runtime.mutableLongStateOf(0L) }

    BackHandler {
        val cur = stack.value.last()
        when {
            stack.value.size > 1 -> pop()
            cur !is Route.Library -> {
                // 顶层标签页之间返回首页，并刷新一下首页数据
                stack.value = listOf(Route.Library)
                vm.refreshLibrary()
            }
            else -> {
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - lastBackAt <= EXIT_WINDOW_MS) {
                    activity?.finish()
                } else {
                    lastBackAt = now
                    vm.toast("再按一次退出")
                }
            }
        }
    }

    Box(Modifier.fillMaxSize().background(BgDeep).statusBarsPadding().navigationBarsPadding()) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                when (val cur = stack.value.last()) {
                    is Route.Library -> LibraryScreen(
                        vm = vm,
                        playlists = playlists,
                        onOpenPlaylist = { id ->
                            val pl = playlists.firstOrNull { it.id == id }
                            push(Route.Playlist(id, pl?.title ?: "歌单"))
                        },
                        onOpenFavorites = { push(Route.Favorites); vm.loadFolders() },
                        onOpenSync = { push(Route.Sync) },
                        onOpenLibrary = { push(Route.LibraryTracks) },
                    )

                    is Route.LibraryTracks -> LibraryTracksScreen(
                        vm = vm,
                        onBack = { pop() },
                        onOpenPlayer = { push(Route.NowPlaying) },
                    )

                    is Route.Playlist -> PlaylistScreen(
                        vm = vm,
                        playlistId = cur.id,
                        title = cur.title,
                        onBack = { pop() },
                        onOpenPlayer = { push(Route.NowPlaying) },
                    )

                    is Route.Favorites -> FavoritesScreen(
                        vm = vm,
                        onBack = { pop() },
                        onOpenFolder = { id, title -> push(Route.Folder(id, title)) },
                    )

                    is Route.Folder -> FolderScreen(
                        vm = vm,
                        folderId = cur.id,
                        title = cur.title,
                        onBack = { pop() },
                        onOpenPlayer = { push(Route.NowPlaying) },
                    )

                    is Route.Me -> MeScreen(
                        vm = vm,
                        onOpenSync = { push(Route.Sync) },
                        onOpenLibrary = { push(Route.LibraryTracks) },
                    )

                    is Route.Sync -> SyncScreen(vm = vm, onBack = { pop() })

                    is Route.NowPlaying -> NowPlayingScreen(
                        vm = vm,
                        player = player,
                        onBack = { pop() },
                    )
                }
            }

            // 底部播放条（全屏播放页不显示）
            if (hasBar && stack.value.last() !is Route.NowPlaying) {
                PlayerBar(
                    player = player,
                    onOpen = { push(Route.NowPlaying) },
                    onToggle = { vm.togglePlayPause() },
                    onNext = { vm.next() },
                    onPrev = { vm.prev() },
                )
            }

            // 底部导航（只在顶层三个页面显示）
            val top = stack.value.last()
            if (top is Route.Library || top is Route.Favorites || top is Route.Me) {
                BottomBar(
                    current = top,
                    onSelect = { r ->
                        stack.value = listOf(r)
                        if (r is Route.Favorites) vm.loadFolders()
                        if (r is Route.Me) vm.refreshNavSuspend()
                    },
                )
            }
        }

        // 轻提示
        if (toast != null) {
            Toast(toast ?: "") { vm.clearToast() }
        }
    }
}

@Composable
private fun BottomBar(current: Route, onSelect: (Route) -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(56.dp).background(BgPanel),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BottomItem("我的音乐", Icons.Filled.LibraryMusic, current is Route.Library) { onSelect(Route.Library) }
        BottomItem("收藏夹", Icons.Filled.Favorite, current is Route.Favorites) { onSelect(Route.Favorites) }
        BottomItem("我的", Icons.Filled.Person, current is Route.Me) { onSelect(Route.Me) }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.BottomItem(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Column(
        Modifier.weight(1f).fillMaxSize().clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
    ) {
        Icon(
            icon, contentDescription = label,
            tint = if (selected) Brand else TextSecondary,
            modifier = Modifier.size(22.dp),
        )
        Text(
            label,
            color = if (selected) Brand else TextSecondary,
            fontSize = 10.sp,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
        )
    }
}
