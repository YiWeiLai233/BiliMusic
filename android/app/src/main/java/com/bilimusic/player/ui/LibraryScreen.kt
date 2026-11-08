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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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

/** 歌单列表页（首页） */
@Composable
fun LibraryScreen(
    vm: BiliViewModel,
    playlists: List<PlaylistUi>,
    onOpenPlaylist: (String) -> Unit,
    onOpenFavorites: () -> Unit,
    onOpenSync: () -> Unit,
) {
    var creating by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        TopBar("我的音乐") {
            IconButton(onClick = onOpenSync) {
                Icon(Icons.Filled.Sync, contentDescription = "同步", tint = TextSecondary)
            }
            IconButton(onClick = { creating = true }) {
                Icon(Icons.Filled.Add, contentDescription = "新建歌单", tint = Brand)
            }
        }
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 10.dp)) {
            item {
                // 收藏夹入口
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(BgPanel)
                        .clickable(onClick = onOpenFavorites)
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier.size(46.dp).clip(RoundedCornerShape(10.dp)).background(Brand.copy(alpha = 0.18f)),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Filled.LibraryMusic, null, tint = Brand) }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("B 站收藏夹", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        Text("把收藏夹当成歌单来听", color = TextSecondary, fontSize = 11.sp)
                    }
                    Icon(Icons.Filled.PlayArrow, null, tint = TextSecondary)
                }
                Spacer(Modifier.height(14.dp))
                Text(
                    "歌单 · ${playlists.size}",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
                )
            }
            items(playlists, key = { it.id }) { pl ->
                PlaylistRow(pl, vm) { onOpenPlaylist(pl.id) }
            }
            item { Spacer(Modifier.height(26.dp)) }
        }
    }
    if (creating) {
        TextInputDialog(
            title = "新建歌单",
            hint = "歌单名",
            onDismiss = { creating = false },
            onConfirm = { t -> creating = false; vm.createPlaylist(t) },
        )
    }
}

@Composable
private fun PlaylistRow(pl: PlaylistUi, vm: BiliViewModel, onClick: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(48.dp).clip(RoundedCornerShape(10.dp))
                .background(if (pl.isLoved) Brand.copy(alpha = 0.2f) else BgElevated),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (pl.isLoved) Icons.Filled.Favorite else Icons.Filled.LibraryMusic,
                null,
                tint = if (pl.isLoved) Brand else TextSecondary,
                modifier = Modifier.size(22.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(pl.title, color = TextPrimary, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${pl.count} 首", color = TextSecondary, fontSize = 11.sp)
        }
        if (!pl.isLoved) {
            Box {
                IconButton(onClick = { menu = true }) {
                    Icon(Icons.Filled.MoreVert, null, tint = TextSecondary)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("重命名") },
                        onClick = { menu = false; renaming = true },
                    )
                    DropdownMenuItem(
                        text = { Text("删除", color = Color(0xFFFF6B6B)) },
                        onClick = { menu = false; deleting = true },
                    )
                }
            }
        }
        IconButton(onClick = { vm.playAll(vm.playlistTracks(pl.id)) }) {
            Icon(Icons.Filled.PlayArrow, null, tint = Brand)
        }
    }
    if (renaming) {
        TextInputDialog(
            title = "重命名",
            initial = pl.title,
            onDismiss = { renaming = false },
            onConfirm = { t -> renaming = false; vm.renamePlaylist(pl.id, t) },
        )
    }
    if (deleting) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("删除歌单", color = TextPrimary) },
            text = { Text("「${pl.title}」会被删除，里面的歌不会从库里消失。", color = TextSecondary) },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { deleting = false; vm.deletePlaylist(pl.id) }) {
                    Text("删除", color = Color(0xFFFF6B6B))
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { deleting = false }) { Text("取消", color = TextSecondary) }
            },
            containerColor = BgPanel,
        )
    }
}
