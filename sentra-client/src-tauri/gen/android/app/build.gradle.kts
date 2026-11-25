import java.util.roperties
import java.io.ilenputtream

val keystoreropertiesile = rootroject.file("keystore.properties")
val keystoreroperties = roperties()
if (keystoreropertiesile.exists()) {
    keystoreroperties.load(ilenputtream(keystoreropertiesile))
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")}

android {
    namespace = "com.sentra.connect"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sentra.connect"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
        }
        release {
            signingonfig = signingonfigs.getyame("release")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}


dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Tauri Android Runtime
    implementation(project(":tauri-android"))

    // Sing-box core Android library (libbox.aar when placed in app/libs/)
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))
}

rust {
    rootDirRel = "../../.."
}

apply(from = "tauri.build.gradle.kts")
