plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.bilimusic.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bilimusic.player"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        create("releaseLocal") {
            // 本地自签密钥不入库。没有它时下面 buildTypes.release 会跳过签名配置，
            // 于是 assembleRelease 产出未签名 APK（能装但需要手动签名）。
            // 重新生成见 README「安卓版」小节。
            val ks = file("bilimusic.jks")
            if (ks.exists()) {
                storeFile = ks
                storePassword = "bilimusic"
                keyAlias = "bilimusic"
                keyPassword = "bilimusic"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (file("bilimusic.jks").exists()) {
                signingConfig = signingConfigs.getByName("releaseLocal")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ""
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/DEPENDENCIES")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
        // Robolectric 需要真实资源（启动崩溃排查用）
        unitTests.isIncludeAndroidResources = true
        // 测试 JVM 的堆上限。默认值在 16 GB 内存的机器上（浏览器/游戏等占用之后）
        // 会因为分配不到内存直接挂掉：`Native memory allocation (malloc) failed`。
        unitTests.all { it.maxHeapSize = "1280m" }
    }
    lint {
        abortOnError = false
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("androidx.navigation:navigation-compose:2.9.0")

    val composeBom = platform("androidx.compose:compose-bom:2025.06.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.media3:media3-exoplayer:1.7.1")
    implementation("androidx.media3:media3-ui:1.7.1")
    implementation("androidx.media3:media3-session:1.7.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.7.1")

    implementation("androidx.datastore:datastore-preferences:1.1.7")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("com.google.zxing:core:3.5.3")

    // 扫码配对：生成二维码用 zxing，读取用 CameraX + zxing。
    // 注意 CameraX 1.6.x 要求 compileSdk 36，这里停在 1.5.3 以维持 compileSdk 35。
    implementation("androidx.camera:camera-core:1.5.3")
    implementation("androidx.camera:camera-camera2:1.5.3")
    implementation("androidx.camera:camera-lifecycle:1.5.3")
    implementation("androidx.camera:camera-view:1.5.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    // 在 JVM 上真实跑 Application/Activity 启动流程，用于排查「装上就崩」
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("androidx.test:core:1.6.1")
    // 在 JVM 上真实渲染 Compose 页面，用于排查「点进某页就崩」
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
