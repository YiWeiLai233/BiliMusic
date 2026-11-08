package com.bilimusic.player.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** B 站粉（#FB7299）作为主色，和桌面端 CSS 里的 --brand 保持一致 */
val Brand = Color(0xFFFB7299)
val BrandDark = Color(0xFFD45C7E)
val BgDeep = Color(0xFF0E0F13)
val BgPanel = Color(0xFF171920)
val BgElevated = Color(0xFF22242E)
val TextPrimary = Color(0xFFEDEFF5)
val TextSecondary = Color(0xFF9AA0AE)

private val scheme = darkColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    primaryContainer = BrandDark,
    secondary = Color(0xFF7FB3FF),
    background = BgDeep,
    onBackground = TextPrimary,
    surface = BgPanel,
    onSurface = TextPrimary,
    surfaceVariant = BgElevated,
    onSurfaceVariant = TextSecondary,
    error = Color(0xFFFF6B6B),
)

private val typo = Typography(
    headlineSmall = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
    bodyMedium = TextStyle(fontSize = 14.sp),
    bodySmall = TextStyle(fontSize = 12.sp),
    labelSmall = TextStyle(fontSize = 11.sp),
)

@Composable
fun BiliTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typo, content = content)
}
