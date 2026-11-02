package cz.valosek.focus

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import org.json.JSONObject

// Obal kolem telefonní appky Focus (GitHub Pages). Stránka je stejná jako v Chromu, appka k ní přidává
// nativní přihlášení Googlem (v WebView Google přihlášení nepovolí) a oznámení.
class MainActivity : ComponentActivity() {

    companion object {
        const val URL = "https://valosekondra.github.io/Focus/"
        val SCOPES = listOf(
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/tasks"
        )
    }

    private lateinit var web: WebView
    private var consentId: String? = null
    private var notifyAfterPermission: Pair<String, String>? = null

    private val consent = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
        val id = consentId; consentId = null
        try {
            val r = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(res.data)
            reply(id, r.accessToken, null)
        } catch (e: Exception) {
            reply(id, null, "Přihlášení se nepovedlo.")
        }
    }

    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val n = notifyAfterPermission; notifyAfterPermission = null
        if (granted && n != null) Notify.show(this, n.first, n.second)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.bg))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "FocusAndroid")
        web.webViewClient = object : WebViewClient() {
            // Uvnitř appky jen Focus; ostatní odkazy (např. událost v Google kalendáři) do prohlížeče.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(URL)) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) { }
                return true
            }
        }
        setContentView(web)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(URL)

        Sync.periodic(this)
        // o povolení oznámení požádat jednou hned po prvním spuštění
        val p = Reminders.prefs(this)
        if (Build.VERSION.SDK_INT >= 33 && !p.getBoolean("askedNotify", false) &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            p.edit().putBoolean("askedNotify", true).apply()
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onResume() {
        super.onResume()
        Sync.now(this)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // Odpověď stránce: window.__focusNative(id, token, chyba)
    private fun reply(id: String?, token: String?, error: String?) {
        if (id == null) return
        val js = "window.__focusNative && window.__focusNative(${q(id)}, ${q(token)}, ${q(error)})"
        runOnUiThread { web.evaluateJavascript(js, null) }
    }

    private fun q(s: String?) = if (s == null) "null" else JSONObject.quote(s)

    // Token jen pro naši stránku – kdyby se do WebView dostala cizí, nic nedostane.
    private fun ours() = (web.url ?: "").startsWith(URL)

    private fun authorize(interactive: Boolean, id: String) {
        if (!ours()) { reply(id, null, "Nepovolená stránka."); return }
        val req = AuthorizationRequest.Builder().setRequestedScopes(SCOPES.map { Scope(it) }).build()
        Identity.getAuthorizationClient(this).authorize(req)
            .addOnSuccessListener { r ->
                val pi = r.pendingIntent
                if (r.hasResolution() && pi != null) {
                    if (!interactive) reply(id, null, "consent")
                    else { consentId = id; consent.launch(IntentSenderRequest.Builder(pi.intentSender).build()) }
                } else reply(id, r.accessToken, null)
            }
            .addOnFailureListener { e -> reply(id, null, e.message ?: "Přihlášení se nepovedlo.") }
    }

    private fun notifyNow(title: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifyAfterPermission = title to text
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else Notify.show(this, title, text)
    }

    // Barva stavové a navigační lišty podle pozadí stránky (stránka ji hlásí při změně tématu).
    private fun setBars(color: String) {
        try {
            val c = Color.parseColor(color)
            window.statusBarColor = c
            window.navigationBarColor = c
            val light = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000 > 140
            val ctl = WindowCompat.getInsetsController(window, window.decorView)
            ctl.isAppearanceLightStatusBars = light
            ctl.isAppearanceLightNavigationBars = light
            web.setBackgroundColor(c)
        } catch (_: Exception) { }
    }

    inner class Bridge {
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun getToken(interactive: Boolean, id: String) { runOnUiThread { authorize(interactive, id) } }
        @JavascriptInterface fun testNotification(title: String, text: String) { runOnUiThread { if (ours()) notifyNow(title, text) } }
        @JavascriptInterface fun setBars(color: String) { runOnUiThread { this@MainActivity.setBars(color) } }
        @JavascriptInterface fun getConfig(): String = Sync.config(this@MainActivity).toString()
        @JavascriptInterface fun setConfig(json: String) { runOnUiThread { if (ours()) try { Sync.setConfig(this@MainActivity, json) } catch (_: Exception) { } } }
        @JavascriptInterface fun lastSync(): Long = Reminders.prefs(this@MainActivity).getLong("lastSync", 0)
        @JavascriptInterface fun notificationsAllowed(): Boolean =
            Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        @JavascriptInterface fun openExternal(url: String) {
            runOnUiThread { try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { } }
        }
    }
}
