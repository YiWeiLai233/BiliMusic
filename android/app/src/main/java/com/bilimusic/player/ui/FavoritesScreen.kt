package com.bilimusic.player.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bilimusic.player.net.FavFolder
import com.bilimusic.player.sync.TrackCore

/**
 * 收藏夹页：上面是已关注（有本地镜像）的收藏夹，下面是账号里全部收藏夹。
 * 关注 = 建立本地镜像并可以随时增量同步；这一点和桌面端的「跟随收藏夹」一致。
 */
@Composable
fun FavoritesScreen(
    vm: BiliViewModel,
    onBack: () -> Unit,
    onOpenFolder: (Long, String) -> Unit,
) {
    val nav by vm.nav.collectAsState()
    val folders by vm.folders.collectAsState()
    val busy by vm.busy.collectAsState()
    var revision by remember { mutableIntStateOf(0) }
    val libRev by vm.libRevision.collectAsState()
    val followed = remember(revision, libRev) { vm.favStore.all() }

    LaunchedEffect(nav?.mid) {
        if (nav?.mid != null && folders.isEmpty()) vm.loadFolders()
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("B 站收藏夹", onBack = onBack)
        if (nav?.isLogin != true) {
            Empty("还没有登录", "去「我的 → 扫码登录」用 B 站账号登录")
        } else {
            if (busy != null) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = Brand, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(busy ?: "", color = TextSecondary, fontSize = 12.sp)
                }
            }
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 10.dp)) {
                if (followed.isNotEmpty()) {
                    item {
                        Text(
                            "已同步 · ${followed.size}",
                            color = TextSecondary,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(start = 4.dp, top = 6.dp, bottom = 6.dp),
                        )
                    }
                    items(followed, key = { it.folderId.toString() }) { s ->
                        Row(
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .clickable { onOpenFolder(s.folderId, s.title) }
                                .padding(vertical = 8.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier.size(44.dp).clip(RoundedCornerShape(10.dp))
                                    .background(Brand.copy(alpha = 0.18f)),
                                contentAlignment = Alignment.Center,
                            ) { Icon(Icons.Filled.LibraryMusic, null, tint = Brand, modifier = Modifier.size(20.dp)) }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(s.title, color = TextPrimary, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("${s.count} 首 · 镜像已就绪", color = TextSecondary, fontSize = 11.sp)
                            }
                            Icon(Icons.Filled.PlayArrow, null, tint = TextSecondary)
                        }
                    }
                    item { Spacer(Modifier.height(14.dp)) }
                }

                item {
                    Text(
                        if (folders.isEmpty()) "账号里的收藏夹" else "账号里的收藏夹 · ${folders.size}",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
                    )
                }
                items(folders, key = { it.id.toString() }) { f ->
                    FolderRow(f, vm) {
                        vm.syncFolder(f)
                        revision++
                    }
                }
                item { Spacer(Modifier.height(90.dp)) }
            }
        }
    }
}

@Composable
private fun FolderRow(f: FavFolder, vm: BiliViewModel, onSync: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(BgElevated),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.LibraryMusic, null, tint = TextSecondary, modifier = Modifier.size(20.dp)) }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(f.title, color = TextPrimary, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${f.mediaCount} 首", color = TextSecondary, fontSize = 11.sp)
        }
        Button(
            onClick = onSync,
            colors = ButtonDefaults.buttonColors(containerColor = BgElevated),
            shape = RoundedCornerShape(16.dp),
        ) {
            Icon(Icons.Filled.CloudDownload, null, tint = Brand, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
            Text("同步", color = Brand, fontSize = 12.sp)
        }
    }
}

/** 某个收藏夹的镜像曲目列表 */
@Composable
fun FolderScreen(
    vm: BiliViewModel,
    folderId: Long,
    title: String,
    onBack: () -> Unit,
    onOpenPlayer: () -> Unit,
) {
    val player by vm.player.collectAsState()
    var revision by remember { mutableIntStateOf(0) }
    val libRev by vm.libRevision.collectAsState()
    val tracks: List<TrackCore> = remember(folderId, revision, libRev) {
        vm.favStore.tracksOf(folderId)
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(title, onBack = onBack)
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = { vm.playAll(tracks, 0); onOpenPlayer() },
                colors = ButtonDefaults.buttonColors(containerColor = Brand),
                shape = RoundedCornerShape(20.dp),
            ) {
                Icon(Icons.Filled.PlayArrow, null, tint = Color.White, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("播放全部", color = Color.White, fontSize = 13.sp)
            }
            Spacer(Modifier.weight(1f))
            Text("${tracks.size} 首", color = TextSecondary, fontSize = 12.sp)
        }
        if (tracks.isEmpty()) {
            Empty("这个收藏夹还没有镜像", "回上一页点「同步」")
        } else {
            LazyColumn(Modifier.weight(1f)) {
                itemsIndexed(tracks, key = { _, t -> t.key }) { i, t ->
                    TrackRow(
                        index = i,
                        track = t,
                        loved = vm.isLoved(t.key),
                        playing = player.current?.key == t.key,
                        onClick = { vm.playAll(tracks, i); onOpenPlayer() },
                        onToggleLoved = { vm.toggleLoved(t.key); revision++ },
                    )
                }
                item { Spacer(Modifier.height(90.dp)) }
            }
        }
    }
}
