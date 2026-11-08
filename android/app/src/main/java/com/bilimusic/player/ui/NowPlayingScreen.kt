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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bilimusic.player.sync.TrackCore

/** 底部播放条，贴在导航栏上方 */
@Composable
fun PlayerBar(
    player: PlayerUi,
    onOpen: () -> Unit,
    onToggle: () -> Unit,
    onNext: () -> Unit,
    onPrev: () -> Unit,
) {
    val t = player.current ?: return
    Column(
        Modifier.fillMaxWidth().background(BgPanel).clickable(onClick = onOpen),
    ) {
        // 进度细线
        val pct = if (player.durationMs > 0) player.positionMs.toFloat() / player.durationMs else 0f
        Box(
            Modifier.fillMaxWidth().height(2.dp).background(BgElevated),
        ) {
            Box(
                Modifier.fillMaxWidth(pct.coerceIn(0f, 1f)).height(2.dp).background(Brand),
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Cover(t.cover, Modifier.size(42.dp).clip(RoundedCornerShape(8.dp)))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    t.title, color = TextPrimary, fontSize = 13.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    t.artist.ifBlank { "未知 UP 主" }, color = TextSecondary, fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (player.loading) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Brand, strokeWidth = 2.dp)
            } else {
                IconButton(onClick = onToggle) {
                    Icon(
                        if (player.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = "播放/暂停", tint = TextPrimary, modifier = Modifier.size(26.dp),
                    )
                }
            }
            IconButton(onClick = onNext) {
                Icon(Icons.Filled.SkipNext, "下一首", tint = TextPrimary, modifier = Modifier.size(24.dp))
            }
        }
    }
}

/** 全屏播放页 */
@Composable
fun NowPlayingScreen(
    vm: BiliViewModel,
    player: PlayerUi,
    onBack: () -> Unit,
) {
    val t = player.current
    var dragging by remember { mutableStateOf(false) }
    var sliderPos by remember { mutableFloatStateOf(0f) }

    LaunchedEffect(player.positionMs, dragging) {
        if (!dragging) sliderPos = player.positionMs.toFloat()
    }

    Column(
        Modifier.fillMaxSize().background(BgDeep).padding(horizontal = 20.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.KeyboardArrowDown, "收起", tint = TextPrimary, modifier = Modifier.size(28.dp))
            }
            Spacer(Modifier.weight(1f))
            Text(
                when (vm.settings.playMode) {
                    "loop-one" -> "单曲循环"
                    "shuffle" -> "随机播放"
                    "sequential" -> "顺序播放"
                    else -> "列表循环"
                },
                color = TextSecondary, fontSize = 12.sp,
            )
        }

        Spacer(Modifier.height(20.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Cover(
                t?.cover ?: "",
                Modifier.size(280.dp).clip(RoundedCornerShape(20.dp)),
                placeholder = "♪",
            )
        }
        Spacer(Modifier.height(26.dp))

        Text(
            t?.title ?: "未在播放",
            color = TextPrimary, fontSize = 18.sp, fontWeight = FontWeight.SemiBold,
            maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            t?.artist?.ifBlank { "未知 UP 主" } ?: "",
            color = TextSecondary, fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        if (player.error != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                player.error ?: "", color = Color(0xFFFF8A8A), fontSize = 12.sp,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.height(18.dp))
        // 进度
        var pending by remember { mutableStateOf(0L) }
        Slider(
            value = sliderPos,
            onValueChange = { dragging = true; sliderPos = it; pending = it.toLong() },
            onValueChangeFinished = {
                dragging = false
                vm.seekTo(pending)
            },
            valueRange = 0f..(player.durationMs.coerceAtLeast(1L)).toFloat(),
            colors = SliderDefaults.colors(
                thumbColor = Brand,
                activeTrackColor = Brand,
                inactiveTrackColor = BgElevated,
            ),
        )
        Row(Modifier.fillMaxWidth()) {
            Text(fmtTime(if (dragging) pending else player.positionMs), color = TextSecondary, fontSize = 11.sp)
            Spacer(Modifier.weight(1f))
            Text(fmtTime(player.durationMs), color = TextSecondary, fontSize = 11.sp)
        }

        Spacer(Modifier.height(6.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { vm.cyclePlayMode() }) {
                Icon(
                    when (vm.settings.playMode) {
                        "loop-one" -> Icons.Filled.RepeatOne
                        "shuffle" -> Icons.Filled.Shuffle
                        else -> Icons.Filled.Repeat
                    },
                    "播放模式", tint = Brand, modifier = Modifier.size(22.dp),
                )
            }
            IconButton(onClick = { vm.prev() }) {
                Icon(Icons.Filled.SkipPrevious, "上一首", tint = TextPrimary, modifier = Modifier.size(34.dp))
            }
            Box(
                Modifier.size(64.dp).clip(RoundedCornerShape(32.dp)).background(Brand)
                    .clickable { vm.togglePlayPause() },
                contentAlignment = Alignment.Center,
            ) {
                if (player.loading) {
                    CircularProgressIndicator(Modifier.size(24.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Icon(
                        if (player.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        "播放/暂停", tint = Color.White, modifier = Modifier.size(34.dp),
                    )
                }
            }
            IconButton(onClick = { vm.next() }) {
                Icon(Icons.Filled.SkipNext, "下一首", tint = TextPrimary, modifier = Modifier.size(34.dp))
            }
            IconButton(onClick = { t?.let { vm.toggleLoved(it.key) } }) {
                val loved = t?.let { vm.isLoved(it.key) } == true
                Icon(
                    if (loved) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    "喜欢", tint = if (loved) Brand else TextSecondary, modifier = Modifier.size(24.dp),
                )
            }
        }
        Spacer(Modifier.height(10.dp))

        // 队列
        if (player.queue.isNotEmpty()) {
            Text("播放队列 · ${player.queue.size}", color = TextSecondary, fontSize = 12.sp,
                modifier = Modifier.padding(start = 2.dp, bottom = 4.dp))
            LazyColumn(Modifier.weight(1f)) {
                itemsIndexed(player.queue, key = { _, x -> x.key }) { i, item ->
                    Row(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { vm.seekToQueue(i) }
                            .background(if (i == player.index) Brand.copy(alpha = 0.12f) else Color.Transparent)
                            .padding(vertical = 7.dp, horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (i == player.index) "▶" else "${i + 1}",
                            color = if (i == player.index) Brand else TextSecondary,
                            fontSize = 11.sp, modifier = Modifier.width(26.dp),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                item.title, color = if (i == player.index) Brand else TextPrimary,
                                fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(item.artist, color = TextSecondary, fontSize = 10.sp, maxLines = 1)
                        }
                        Text(fmtTime(item.duration * 1000), color = TextSecondary, fontSize = 10.sp)
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        } else {
            Spacer(Modifier.weight(1f))
        }
    }
}
