plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cz.valosek.focus"
    compileSdk = 34

    defaultConfig {
        applicationId = "cz.valosek.focus"
        minSdk = 26
        targetSdk = 34
        // číslo sestavení dodá GitHub Actions (run_number), lokálně 1
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1"
    }

    // Podpisový klíč přichází z tajných proměnných repozitáře (ANDROID_KEYSTORE, ANDROID_KEYSTORE_PASSWORD).
    // Musí být pořád stejný: podle jeho otisku SHA-1 pozná Google přihlášení appku a Android povolí aktualizaci.
    signingConfigs {
        create("focus") {
            storeFile = file(System.getenv("KS_FILE") ?: "chybi-klic.p12")
            storePassword = System.getenv("KS_PASSWORD")
            keyAlias = System.getenv("KS_ALIAS")
            keyPassword = System.getenv("KS_PASSWORD")
            storeType = "pkcs12"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("focus")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("com.google.android.gms:play-services-auth:21.2.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
