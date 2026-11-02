package cz.valosek.focus

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

// Synchronizace na pozadí: každých 30 minut stáhne z Googlu nejbližší události a nesplněné úkoly
// a naplánuje z nich připomínky (Reminders). Funguje i se zavřenou appkou a bez PC.
object Sync {
    private const val CAL = "https://www.googleapis.com/calendar/v3"
    private const val TASKS = "https://tasks.googleapis.com/tasks/v1"
    private val HM = DateTimeFormatter.ofPattern("H:mm")
    private val TIME_RE = Regex("⏰\\s*(\\d{1,2}):(\\d{2})\\s*$")

    // Nastavení z telefonní appky: {calendars:[id…], eventMin: 10 (-1 = vypnuto), taskHour: 8 (-1 = vypnuto)}
    fun config(ctx: Context): JSONObject =
        try { JSONObject(Reminders.prefs(ctx).getString("cfg", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }

    fun setConfig(ctx: Context, json: String) {
        Reminders.prefs(ctx).edit().putString("cfg", JSONObject(json).toString()).apply()
        now(ctx)
    }

    fun periodic(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun now(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("sync-now", ExistingWorkPolicy.REPLACE, req)
    }

    // Token bez okna – když by Google chtěl souhlas, vrátí null (souhlas se dá jen v appce).
    private fun token(ctx: Context): String? {
        val req = AuthorizationRequest.Builder().setRequestedScopes(MainActivity.SCOPES.map { Scope(it) }).build()
        val r = Tasks.await(Identity.getAuthorizationClient(ctx).authorize(req), 30, TimeUnit.SECONDS)
        return if (r.hasResolution()) null else r.accessToken
    }

    private fun get(token: String, url: String): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        c.setRequestProperty("Authorization", "Bearer $token")
        c.connectTimeout = 20000; c.readTimeout = 20000
        try {
            if (c.responseCode !in 200..299) throw RuntimeException("Google ${c.responseCode}")
            return JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        } finally { c.disconnect() }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    fun run(ctx: Context) {
        val cfg = config(ctx)
        val token = token(ctx) ?: return
        val items = ArrayList<Reminders.Item>()
        val zone = ZoneId.systemDefault()
        val now = OffsetDateTime.now()

        val eventMin = cfg.optInt("eventMin", 10)
        val cals = cfg.optJSONArray("calendars")
        if (eventMin >= 0 && cals != null) {
            val from = now.minusMinutes(eventMin.toLong()).toString()
            val to = now.plusHours(36).toString()
            for (i in 0 until cals.length()) {
                val calId = cals.optString(i)
                val j = try {
                    get(token, "$CAL/calendars/${enc(calId)}/events?singleEvents=true&orderBy=startTime&maxResults=100&timeMin=${enc(from)}&timeMax=${enc(to)}")
                } catch (_: Exception) { continue }
                val arr = j.optJSONArray("items") ?: continue
                for (k in 0 until arr.length()) {
                    val e = arr.getJSONObject(k)
                    if (e.optString("status") == "cancelled") continue
                    val start = e.optJSONObject("start")?.optString("dateTime").orEmpty()
                    if (start.isEmpty()) continue   // celodenní události bez připomínky
                    if (declined(e)) continue
                    val s = OffsetDateTime.parse(start)
                    val end = e.optJSONObject("end")?.optString("dateTime").orEmpty()
                    val at = s.minusMinutes(eventMin.toLong()).toInstant().toEpochMilli()
                    val time = s.atZoneSameInstant(zone).format(HM) +
                        (if (end.isNotEmpty()) "–" + OffsetDateTime.parse(end).atZoneSameInstant(zone).format(HM) else "")
                    val loc = e.optString("location").trim()
                    val text = (if (eventMin == 0) "Teď začíná" else "Za $eventMin min") + " · " + time + (if (loc.isNotEmpty()) " · $loc" else "")
                    val title = e.optString("summary").ifBlank { "(bez názvu)" }
                    items.add(Reminders.Item("ev|$calId|${e.optString("id")}|${s.toInstant().toEpochMilli()}|$eventMin", at, title, text))
                }
            }
        }

        // nesplněné úkoly s termínem do pozítří (ranní přehled + úkoly s časem)
        val today = LocalDate.now(zone)
        val open = ArrayList<Triple<String, LocalDate, JSONObject>>()
        val lists = get(token, "$TASKS/users/@me/lists?maxResults=100").optJSONArray("items")
        if (lists != null) for (i in 0 until lists.length()) {
            val list = lists.getJSONObject(i)
            val dueMax = today.plusDays(2).toString() + "T00:00:00.000Z"
            val arr = try {
                get(token, "$TASKS/lists/${enc(list.optString("id"))}/tasks?showCompleted=false&showHidden=false&maxResults=100&dueMax=${enc(dueMax)}").optJSONArray("items")
            } catch (_: Exception) { null } ?: continue
            for (k in 0 until arr.length()) {
                val t = arr.getJSONObject(k)
                val due = t.optString("due")
                if (due.length < 10 || t.optString("title").isBlank() || t.optString("status") == "completed") continue
                open.add(Triple(list.optString("title"), LocalDate.parse(due.substring(0, 10)), t))
            }
        }

        // úkol s časem (v poznámce „⏰ 14:30“ – Google Tasks API čas neumí) připomenout přesně v ten čas
        for ((listName, d, t) in open) {
            val m = TIME_RE.find(t.optString("notes")) ?: continue
            val h = m.groupValues[1].toInt(); val min = m.groupValues[2].toInt()
            if (h > 23 || min > 59) continue
            val at = d.atTime(h, min).atZone(zone).toInstant().toEpochMilli()
            val hm = "%d:%02d".format(h, min)
            items.add(Reminders.Item("task|${t.optString("id")}|$d|$hm", at, t.optString("title").trim(), "Úkol · $hm · $listName"))
        }

        val taskHour = cfg.optInt("taskHour", 8)
        if (taskHour >= 0) {
            // ranní přehled: nejbližší taskHour (dnes, nebo zítra, když už je po něm)
            var day = today
            var at = day.atTime(taskHour, 0).atZone(zone)
            if (at.toInstant().toEpochMilli() <= System.currentTimeMillis()) { day = day.plusDays(1); at = day.atTime(taskHour, 0).atZone(zone) }
            val dueToday = ArrayList<String>(); var overdue = 0
            for ((_, d, t) in open) {
                if (d == day) dueToday.add(t.optString("title").trim()) else if (d.isBefore(day)) overdue++
            }
            if (dueToday.isNotEmpty() || overdue > 0) {
                val title = if (dueToday.isEmpty()) "Úkoly po termínu: $overdue"
                            else "Dnes " + dueToday.size + " " + plural(dueToday.size) + (if (overdue > 0) " · $overdue po termínu" else "")
                val text = if (dueToday.isEmpty()) "Podívej se do Focusu, co dohnat." else dueToday.joinToString(" · ")
                items.add(Reminders.Item("tasks|$day|$taskHour", at.toInstant().toEpochMilli(), title, text))
            }
        }

        Reminders.schedule(ctx, items)
        Reminders.prefs(ctx).edit().putLong("lastSync", System.currentTimeMillis()).apply()
    }

    private fun declined(e: JSONObject): Boolean {
        val att = e.optJSONArray("attendees") ?: return false
        for (i in 0 until att.length()) {
            val a = att.getJSONObject(i)
            if (a.optBoolean("self") && a.optString("responseStatus") == "declined") return true
        }
        return false
    }

    private fun plural(n: Int) = when { n == 1 -> "úkol"; n in 2..4 -> "úkoly"; else -> "úkolů" }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result =
        try { Sync.run(applicationContext); Result.success() } catch (_: Exception) { Result.retry() }
}
