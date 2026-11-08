package com.bilimusic.player.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/** 自动消失的提示条，点一下也能关 */
@Composable
fun Toast(message: String, onDismiss: () -> Unit) {
    LaunchedEffect(message) {
        delay(2600)
        onDismiss()
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Box(
            Modifier.padding(bottom = 130.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(Color(0xE62A2C36))
                .clickable(onClick = onDismiss)
                .padding(horizontal = 16.dp, vertical = 9.dp),
        ) {
            Text(message, color = TextPrimary, fontSize = 12.sp)
        }
    }
}
