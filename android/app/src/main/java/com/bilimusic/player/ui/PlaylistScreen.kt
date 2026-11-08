package com.bilimusic.player.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 歌单详情：曲目列表 + 播放全部 */
@Composable
fun PlaylistScreen(
    vm: BiliViewModel,
    playlistId: String,
    title: String,
    onBack: () -> Unit,
    onOpenPlayer: () -> Unit,
) {
    val player by vm.player.collectAsState()
    val libRev by vm.libRevision.collectAsState()
    var revision by remember { mutableIntStateOf(0) }
    // libRev 让「同步合并完」这种后台变化也能刷新已经打开的列表
    val tracks = remember(playlistId, revision, libRev) { vm.playlistTracks(playlistId) }
    var adding by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        TopBar(title, onBack = onBack) {
            IconButton(onClick = { adding = true }) {
                Icon(Icons.Filled.Add, contentDescription = "添加曲目", tint = TextSecondary)
            }
        }
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
            Empty("这个歌单还是空的", "点右上角「+」把库里的歌加进来")
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
                        trailing = {
                            if (playlistId != BiliViewModel.LOVE_ID) {
                                IconButton(onClick = {
                                    vm.removeFromPlaylist(playlistId, t.key)
                                    revision++
                                }) {
                                    Icon(Icons.Filled.Delete, "移出", tint = TextSecondary, modifier = Modifier.size(18.dp))
                                }
                            }
                        },
                    )
                }
                item { Spacer(Modifier.height(90.dp)) }
            }
        }
    }
    if (adding) {
        AddTracksDialog(
            vm = vm,
            already = tracks.map { it.key }.toSet(),
            onDismiss = { adding = false },
            onConfirm = { keys ->
                vm.addToPlaylist(playlistId, keys)
                adding = false
                revision++
            },
        )
    }
}

/**
 * 从库里挑曲目。曲目量通常几百首，加个搜索框足够，不需要分页。
 */
@Composable
fun AddTracksDialog(
    vm: BiliViewModel,
    already: Set<String>,
    onDismiss: () -> Unit,
    onConfirm: (List<String>) -> Unit,
) {
    val all = remember { vm.lib.liveTracks().sortedBy { it.title } }
    var picked by remember { mutableStateOf<Set<String>>(emptySet()) }
    var query by remember { mutableStateOf("") }
    val shown = remember(query, all) {
        val q = query.trim()
        if (q.isEmpty()) all else all.filter { it.title.contains(q, true) || it.artist.contains(q, true) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择曲目", color = TextPrimary) },
        text = {
            Column(Modifier.height(420.dp)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("搜索标题 / UP 主") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                if (shown.isEmpty()) {
                    Empty("库里还没有曲目", "先去收藏夹同步一批")
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(shown, key = { it.key }) { t ->
                            val inAlready = already.contains(t.key)
                            val checked = picked.contains(t.key)
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = !inAlready) {
                                        picked = if (checked) picked - t.key else picked + t.key
                                    }
                                    .padding(vertical = 6.dp, horizontal = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(checked = checked || inAlready, onCheckedChange = null, enabled = !inAlready)
                                Spacer(Modifier.width(6.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        t.title,
                                        color = if (inAlready) TextSecondary else TextPrimary,
                                        fontSize = 13.sp,
                                        maxLines = 1,
                                    )
                                    Text(t.artist, color = TextSecondary, fontSize = 11.sp, maxLines = 1)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(picked.toList()) }) {
                Text(if (picked.isEmpty()) "关闭" else "加入 ${picked.size} 首", color = Brand)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消", color = TextSecondary) } },
        containerColor = BgPanel,
    )
}
