package com.bilimusic.player.ui

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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

/**
 * 「我的库」：直接躺在库里的全部曲目。
 *
 * ## 这个页面是怎么来的
 *
 * 用户报「链接收藏导入之后没有显示」。查下来曲目确实进了 tracks 表
 * （[BiliViewModel.importLink] 里 `lib.upsertTrack(...)`），但首页只渲染
 * 「我喜欢的歌」和自建歌单 —— 导入的曲目两边都不属于，于是在界面上
 * 完全不可见，只有一句「已导入 N 首」的提示。
 *
 * 桌面端有对应的「我的库」列表（侧边栏直接列 `biliTracks()`），
 * 安卓端之前漏了这一块，这里补上，并让导入后自动跳进来。
 */
@Composable
fun LibraryTracksScreen(
    vm: BiliViewModel,
    onBack: () -> Unit,
    onOpenPlayer: () -> Unit,
) {
    val player by vm.player.collectAsState()
    val libRev by vm.libRevision.collectAsState()
    var revision by remember { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }

    val all = remember(libRev, revision) { vm.libraryTracks() }
    val shown = remember(all, query) {
        if (query.isBlank()) all
        else all.filter {
            it.title.contains(query, ignoreCase = true) ||
                it.artist.contains(query, ignoreCase = true)
        }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar("我的库", onBack = onBack) {
            IconButton(onClick = { searching = !searching; if (!searching) query = "" }) {
                Icon(Icons.Filled.Search, contentDescription = "搜索", tint = TextSecondary)
            }
        }
        if (searching) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("搜标题或 UP 主", fontSize = 13.sp) },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp)
                    .padding(bottom = 6.dp),
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = { vm.playAll(shown, 0); onOpenPlayer() },
                colors = ButtonDefaults.buttonColors(containerColor = Brand),
                shape = RoundedCornerShape(20.dp),
                enabled = shown.isNotEmpty(),
            ) {
                Icon(Icons.Filled.PlayArrow, null, tint = Color.White, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("播放全部", color = Color.White, fontSize = 13.sp)
            }
            Spacer(Modifier.weight(1f))
            Text(
                if (query.isBlank()) "${shown.size} 首" else "${shown.size} / ${all.size} 首",
                color = TextSecondary,
                fontSize = 12.sp,
            )
        }
        if (shown.isEmpty()) {
            if (all.isEmpty()) {
                Empty("库里还没有歌", "用「我的 → 链接收藏」导入 BV 号或链接")
            } else {
                Empty("没有匹配的歌", "换个关键词试试")
            }
        } else {
            LazyColumn(Modifier.weight(1f)) {
                itemsIndexed(shown, key = { _, t -> t.key }) { i, t ->
                    TrackRow(
                        index = i,
                        track = t,
                        loved = vm.isLoved(t.key),
                        playing = player.current?.key == t.key,
                        onClick = { vm.playAll(shown, i); onOpenPlayer() },
                        onToggleLoved = { vm.toggleLoved(t.key); revision++ },
                    )
                }
                item { Spacer(Modifier.height(90.dp)) }
            }
        }
    }
}
