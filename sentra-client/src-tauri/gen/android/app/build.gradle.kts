import java.io.FileInputStream
import java.util.Properties

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

fun resolveSigningProp(propKey: String, envKey: String): String? {
    val fromFile = keystoreProperties.getProperty(propKey)?.trim()
    if (!fromFile.isNullOrEmpty()) return fromFile
    val fromEnv = System.getenv(envKey)?.trim()
    if (!fromEnv.isNullOrEmpty()) return fromEnv
    return null
}

val releaseStoreFilePath = resolveSigningProp("storeFile", "ANDROID_KEYSTORE_PATH")
val releaseStorePassword = resolveSigningProp("storePassword", "ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = resolveSigningProp("keyAlias", "ANDROID_KEY_ALIAS")
val releaseKeyPassword = resolveSigningProp("keyPassword", "ANDROID_KEY_PASSWORD")
val hasReleaseSigning = !releaseStoreFilePath.isNullOrEmpty()
    && file(releaseStoreFilePath).exists()
    && !releaseStorePassword.isNullOrEmpty()
    && !releaseKeyAlias.isNullOrEmpty()
    && !releaseKeyPassword.isNullOrEmpty()

val resolvedVersionName = (findProperty("versionName") as? String)?.trim()?.removePrefix("v")?.ifEmpty { null } ?: "1.0.0"
val resolvedVersionCode = (findProperty("versionCode") as? String)?.trim()?.toIntOrNull() ?: 10000

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

android {
    namespace = "com.sentra.connect"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sentra.connect"
        minSdk = 24
        targetSdk = 34
        versionCode = resolvedVersionCode
        versionName = resolvedVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFilePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
        }
        getByName("release") {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
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

    // Optional Sing-box core Android library (libbox.aar if placed in app/libs/)
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar", "*.jar"))))
}

rust {
    rootDirRel = "../../.."
}

if (file("tauri.build.gradle.kts").exists()) {
    apply(from = "tauri.build.gradle.kts")
}
