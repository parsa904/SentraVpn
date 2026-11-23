plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.sentra.connect"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.sentra.connect"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        ndk {
            abiFilters.add("arm64-v8a")
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            storeFile = file("release-keystore.jks")
            storePassword = "sentra1234"
            keyAlias = "sentra"
            keyPassword = "sentra1234"
        }
    }

    buildTypes {
        getByName("debug") { }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    splits {
        abi {
            isEnable = false
            isUniversalApk = false
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.0")
    implementation("com.google.android.material:material:1.12.0")
    
    // Sing-box core Android library (libbox.aar when placed in app/libs/)
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))
}

apply(from = "tauri.build.gradle.kts")

tasks.register("copyReleaseApkToDist") {
    doLast {
        val distDir = file("C:/SentraVpn/release-dist")
        if (!distDir.exists()) {
            distDir.mkdirs()
        }
        val releaseDir = layout.buildDirectory.dir("outputs/apk/release").get().asFile
        val candidate = releaseDir.listFiles()?.firstOrNull { it.extension == "apk" }
        if (candidate != null && candidate.exists()) {
            val target = File(distDir, "SentraVPN-Android.apk")
            candidate.copyTo(target, overwrite = true)
            println(">>> Successfully deployed ${candidate.name} to ${target.absolutePath} (${target.length()} bytes)")
        } else {
            println(">>> Warning: No release APK found in ${releaseDir.absolutePath}")
        }
    }
}

afterEvaluate {
    tasks.findByName("assembleRelease")?.finalizedBy("copyReleaseApkToDist")
}
