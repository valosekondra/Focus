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
    fun token(ctx: Context): String? {
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

    // Splnění úkolu z oznámení (tlačítko Hotovo). HttpURLConnection neumí PATCH – Google bere POST s přepisem metody.
    fun completeTask(ctx: Context, listId: String, taskId: String) {
        val token = token(ctx) ?: throw RuntimeException("Přihlášení vypršelo")
        val c = URL("$TASKS/lists/${enc(listId)}/tasks/${enc(taskId)}").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.setRequestProperty("X-HTTP-Method-Override", "PATCH")
        c.setRequestProperty("Authorization", "Bearer $token")
        c.setRequestProperty("Content-Type", "application/json")
        c.connectTimeout = 20000; c.readTimeout = 20000; c.doOutput = true
        try {
            c.outputStream.use { it.write("{\"status\":\"completed\"}".toByteArray()) }
            if (c.responseCode !in 200..299) throw RuntimeException("Google ${c.responseCode}")
        } finally { c.disconnect() }
    }

    // Denní rutina: seznam {title, time "HH:mm", days "1234567" (po=1 … ne=7)}; dá se přepsat v nastavení (cfg.routine).
    const val ROUTINE_LIST = "Daily routine"
    private val DEFAULT_ROUTINE = """[
        {"title":"Wake up","time":"04:30","days":"12345"},
        {"title":"Namazat mast","time":"05:00","days":"1234567"},
        {"title":"Namazat mast","time":"20:00","days":"1234567"},
        {"title":"Wind down, no screens","time":"20:00","days":"12347"},
        {"title":"Go to sleep","time":"21:00","days":"12347"}]"""

    private fun send(token: String, method: String, url: String, json: String?): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = if (method == "PATCH") "POST" else method
        if (method == "PATCH") c.setRequestProperty("X-HTTP-Method-Override", "PATCH")
        c.setRequestProperty("Authorization", "Bearer $token")
        c.connectTimeout = 20000; c.readTimeout = 20000
        try {
            if (json != null) {
                c.setRequestProperty("Content-Type", "application/json"); c.doOutput = true
                c.outputStream.use { it.write(json.toByteArray()) }
            }
            if (c.responseCode !in 200..299) throw RuntimeException("Google ${c.responseCode}")
            val body = c.inputStream.bufferedReader().use { it.readText() }
            return if (body.isBlank()) JSONObject() else JSONObject(body)
        } finally { c.disconnect() }
    }

    // Založí úkoly rutiny na dnešek a zítřek (s časem „⏰ HH:mm“ v poznámce → oznámení v ten čas).
    // Co už v seznamu na ten den je (i splněné), znovu nezakládá.
    private fun ensureRoutine(ctx: Context, token: String, cfg: JSONObject, today: LocalDate) {
        val p = Reminders.prefs(ctx)
        val routine = cfg.optJSONArray("routine") ?: org.json.JSONArray(DEFAULT_ROUTINE)
        if (routine.length() == 0) return
        if (p.getString("routineDone", "") == today.toString()) return
        val lists = get(token, "$TASKS/users/@me/lists?maxResults=100").optJSONArray("items")
        var listId: String? = null
        if (lists != null) for (i in 0 until lists.length()) {
            val l = lists.getJSONObject(i)
            if (l.optString("title") == ROUTINE_LIST) listId = l.optString("id")
        }
        if (listId == null) listId = send(token, "POST", "$TASKS/users/@me/lists", JSONObject().put("title", ROUTINE_LIST).toString()).optString("id")
        // nesplněná rutina z minulých dnů se neodkládá – smazat, ať nevisí „po termínu“
        val old = get(token, "$TASKS/lists/${enc(listId!!)}/tasks?showCompleted=false&maxResults=100&dueMax=${enc(today.toString() + "T00:00:00.000Z")}").optJSONArray("items")
        if (old != null) for (k in 0 until old.length())
            try { send(token, "DELETE", "$TASKS/lists/${enc(listId)}/tasks/${enc(old.getJSONObject(k).optString("id"))}", null) } catch (_: Exception) { }
        for (day in listOf(today, today.plusDays(1))) {
            val dueMin = day.toString() + "T00:00:00.000Z"; val dueMax = day.plusDays(1).toString() + "T00:00:00.000Z"
            val have = HashSet<String>()
            val arr = get(token, "$TASKS/lists/${enc(listId!!)}/tasks?showCompleted=true&showHidden=true&maxResults=100&dueMin=${enc(dueMin)}&dueMax=${enc(dueMax)}").optJSONArray("items")
            if (arr != null) for (k in 0 until arr.length()) {
                val t = arr.getJSONObject(k)
                have.add(t.optString("title").trim() + "|" + (TIME_RE.find(t.optString("notes"))?.value ?: ""))
            }
            val dow = day.dayOfWeek.value.toString()
            for (i in 0 until routine.length()) {
                val r = routine.getJSONObject(i)
                if (!r.optString("days", "1234567").contains(dow)) continue
                val title = r.optString("title").trim(); val time = r.optString("time")
                val mark = "⏰ $time"
                if ("$title|$mark" in have || title.isEmpty()) continue
                send(token, "POST", "$TASKS/lists/${enc(listId)}/tasks", JSONObject().put("title", title).put("notes", mark).put("due", dueMin).toString())
                have.add("$title|$mark")
            }
        }
        p.edit().putString("routineDone", today.toString()).apply()
    }

    // Spustí synchronizaci a výsledek (nebo chybu) uloží pro Nastavení v appce – ať je vidět, co se děje.
    @Synchronized
    fun runLogged(ctx: Context): Boolean {
        val p = Reminders.prefs(ctx)
        return try {
            val info = run(ctx)
            p.edit().putString("lastInfo", info).remove("lastError").apply()
            true
        } catch (e: Throwable) {
            p.edit().putString("lastError", (e.javaClass.simpleName + ": " + (e.message ?: "")).take(300))
                .putLong("lastErrorAt", System.currentTimeMillis()).apply()
            false
        }
    }

    fun status(ctx: Context): String {
        val p = Reminders.prefs(ctx)
        return JSONObject()
            .put("last", p.getLong("lastSync", 0))
            .put("info", p.getString("lastInfo", "") ?: "")
            .put("error", p.getString("lastError", "") ?: "")
            .put("errorAt", p.getLong("lastErrorAt", 0))
            .toString()
    }

    private fun run(ctx: Context): String {
        val cfg = config(ctx)
        val token = token(ctx) ?: throw RuntimeException("Google chce znovu potvrdit přístup – v appce se odhlas a přihlas.")
        val p = Reminders.prefs(ctx)
        val items = ArrayList<Reminders.Item>()
        val zone = ZoneId.systemDefault()
        val now = OffsetDateTime.now()
        val nowMs = System.currentTimeMillis()

        // ----- události: připomínka X min předem; když už je na ni pozdě (a událost ještě nezačala), hned -----
        val eventMin = cfg.optInt("eventMin", 10)
        val cals = cfg.optJSONArray("calendars")
        val eventKeys = HashSet<String>()
        val immediate = ArrayList<Reminders.Item>()
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
                    val startMs = s.toInstant().toEpochMilli()
                    if (startMs <= nowMs) continue   // už běží
                    val end = e.optJSONObject("end")?.optString("dateTime").orEmpty()
                    val at = startMs - eventMin * 60000L
                    val time = s.atZoneSameInstant(zone).format(HM) +
                        (if (end.isNotEmpty()) "–" + OffsetDateTime.parse(end).atZoneSameInstant(zone).format(HM) else "")
                    val loc = e.optString("location").trim()
                    val title = e.optString("summary").ifBlank { "(bez názvu)" }
                    val key = "ev|$calId|${e.optString("id")}|$startMs|$eventMin"
                    eventKeys.add(key)
                    if (at > nowMs) {
                        val text = (if (eventMin == 0) "Teď začíná" else "Za $eventMin min") + " · " + time + (if (loc.isNotEmpty()) " · $loc" else "")
                        items.add(Reminders.Item(key, at, title, text))
                    } else {
                        val mins = ((startMs - nowMs + 59999) / 60000).toInt()
                        immediate.add(Reminders.Item(key, nowMs, title, "Za $mins min · " + time + (if (loc.isNotEmpty()) " · $loc" else "")))
                    }
                }
            }
        }
        // „shown“ = připomínky, které už zazněly (budíkem nebo hned) – ať se neopakují
        val shown = (p.getStringSet("shown", emptySet()) ?: emptySet()).filter { it in eventKeys }.toMutableSet()
        for (it in immediate) if (shown.add(it.key)) Notify.show(ctx, it.title, it.text, it.key.hashCode())
        p.edit().putStringSet("shown", shown).apply()

        // ----- denní rutina: Google úkoly neumí opakování, tak ji appka zakládá sama na dnešek a zítřek -----
        try { ensureRoutine(ctx, token, cfg, LocalDate.now(zone)) } catch (_: Exception) { }

        // ----- úkoly: každý dnešní a zpožděný úkol jako oznámení, dokud ho neodklikneš nebo nesplníš -----
        val today = LocalDate.now(zone)
        val taskHour = cfg.optInt("taskHour", 8)
        val morning = if (taskHour >= 0) today.atTime(taskHour, 0).atZone(zone).toInstant().toEpochMilli() else null
        val show = ArrayList<TaskNotify.Task>()
        val lists = get(token, "$TASKS/users/@me/lists?maxResults=100").optJSONArray("items")
        if (lists != null) for (i in 0 until lists.length()) {
            val list = lists.getJSONObject(i)
            val listId = list.optString("id")
            val dueMax = today.plusDays(2).toString() + "T00:00:00.000Z"
            val arr = try {
                get(token, "$TASKS/lists/${enc(listId)}/tasks?showCompleted=false&showHidden=false&maxResults=100&dueMax=${enc(dueMax)}").optJSONArray("items")
            } catch (_: Exception) { null } ?: continue
            for (k in 0 until arr.length()) {
                val t = arr.getJSONObject(k)
                val due = t.optString("due"); val title = t.optString("title").trim()
                if (due.length < 10 || title.isEmpty() || t.optString("status") == "completed") continue
                val d = LocalDate.parse(due.substring(0, 10))
                // čas úkolu je v poznámce „⏰ 14:30“ (Google Tasks API čas neumí)
                val m = TIME_RE.find(t.optString("notes"))
                val hm = if (m != null && m.groupValues[1].toInt() < 24 && m.groupValues[2].toInt() < 60) "%02d:%02d".format(m.groupValues[1].toInt(), m.groupValues[2].toInt()) else null
                val timeMs = if (hm != null) d.atTime(m!!.groupValues[1].toInt(), m.groupValues[2].toInt()).atZone(zone).toInstant().toEpochMilli() else null
                // od kdy úkol ukázat: s časem v ten čas, jinak od rána (nastavení „od kolika“)
                val from = if (timeMs != null && !d.isBefore(today)) timeMs else if (d.isAfter(today)) null else morning
                if (from == null) continue
                if (from <= nowMs) show.add(TaskNotify.Task(listId, t.optString("id"), title, listName = list.optString("title"), due = d, time = hm, overdue = d.isBefore(today)))
                else items.add(Reminders.Item("wake|$from", from, "", "", wake = true))
            }
        }
        // ráno (dnes, pokud ještě nebylo, a zítra) se úkoly ukážou samy
        if (taskHour >= 0) for (day in listOf(today, today.plusDays(1))) {
            val at = day.atTime(taskHour, 0).atZone(zone).toInstant().toEpochMilli()
            if (at > nowMs) items.add(Reminders.Item("wake|$at", at, "", "", wake = true))
        }
        TaskNotify.sync(ctx, show, today)

        val planned = items.distinctBy { it.key }
        Reminders.schedule(ctx, planned)
        p.edit().putLong("lastSync", System.currentTimeMillis()).apply()
        val ev = planned.count { !it.wake }
        return "úkoly v oznámeních: ${show.size} · připomínky událostí: $ev · kalendářů: ${cals?.length() ?: 0}"
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
        if (Sync.runLogged(applicationContext)) Result.success() else Result.retry()
}
