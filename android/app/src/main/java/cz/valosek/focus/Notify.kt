package cz.valosek.focus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.time.LocalDate
import kotlin.concurrent.thread

// Zobrazení oznámení: kanál „Připomínky“ (události) a „Úkoly“.
object Notify {
    private const val CHANNEL = "reminders"
    const val TASKS = "tasks"

    fun channels(nm: NotificationManager) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Připomínky", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(TASKS, "Úkoly na dnes", NotificationManager.IMPORTANCE_HIGH))
    }

    fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 0,
        Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    fun show(ctx: Context, title: String, text: String, id: Int = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        channels(nm)
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF7C5CD6.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .build()
        nm.notify(id, n)
    }
}

// Dnešní (a zpožděné) úkoly jako oznámení s tlačítkem Hotovo. Zůstanou, dokud je neodklikneš nebo nesplníš;
// odkliknutý se ten den už neukáže, splněný (kdekoli) zmizí při další synchronizaci.
object TaskNotify {
    class Task(val listId: String, val id: String, val title: String, val listName: String, val due: LocalDate, val time: String?, val overdue: Boolean)

    private fun nid(taskId: String) = ("task:$taskId").hashCode()

    fun sync(ctx: Context, tasks: List<Task>, today: LocalDate) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        Notify.channels(nm)
        val p = Reminders.prefs(ctx)
        val dismissed = (p.getStringSet("dismissed", emptySet()) ?: emptySet()).filter { it.endsWith("|$today") }.toSet()
        val posted = HashSet<String>()
        for (t in tasks.sortedWith(compareBy({ it.due }, { it.time ?: "99" }))) {
            if ("${t.id}|$today" in dismissed) continue
            post(ctx, nm, t)
            posted.add(t.id)
        }
        for (old in (p.getStringSet("posted", emptySet()) ?: emptySet()) - posted) nm.cancel(nid(old))
        p.edit().putStringSet("posted", posted).putStringSet("dismissed", dismissed).apply()
    }

    private fun post(ctx: Context, nm: NotificationManager, t: Task) {
        fun action(act: String) = PendingIntent.getBroadcast(
            ctx, 0,
            Intent(ctx, TaskActionReceiver::class.java).setAction(act)
                .setData(Uri.parse("focus://task/" + Uri.encode(t.id)))
                .putExtra("list", t.listId).putExtra("task", t.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = (if (t.overdue) "Po termínu · ${t.due.dayOfMonth}. ${t.due.monthValue}." else if (t.time != null) "Dnes v ${t.time}" else "Dnes") +
            (if (t.listName.isNotEmpty()) " · ${t.listName}" else "")
        val n = Notification.Builder(ctx, Notify.TASKS)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF7C5CD6.toInt())
            .setContentTitle(t.title)
            .setContentText(text)
            .setOnlyAlertOnce(true)          // při každé synchronizaci se aktualizuje, ale nezvoní znovu
            .setSortKey(t.due.toString() + (t.time ?: "99"))
            .setContentIntent(Notify.openApp(ctx))
            .setDeleteIntent(action("dismiss"))
            .addAction(Notification.Action.Builder(null, "Hotovo", action("done")).build())
            .build()
        nm.notify(nid(t.id), n)
    }

    fun dismissed(ctx: Context, taskId: String) {
        val p = Reminders.prefs(ctx)
        val s = (p.getStringSet("dismissed", emptySet()) ?: emptySet()).toMutableSet()
        s.add("$taskId|${LocalDate.now()}")
        val posted = (p.getStringSet("posted", emptySet()) ?: emptySet()) - taskId
        p.edit().putStringSet("dismissed", s).putStringSet("posted", posted).apply()
    }

    fun cancel(ctx: Context, taskId: String) = ctx.getSystemService(NotificationManager::class.java).cancel(nid(taskId))
}

class TaskActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val taskId = intent.getStringExtra("task") ?: return
        val listId = intent.getStringExtra("list") ?: return
        if (intent.action == "dismiss") { TaskNotify.dismissed(ctx, taskId); return }
        if (intent.action != "done") return
        TaskNotify.cancel(ctx, taskId)
        TaskNotify.dismissed(ctx, taskId)   // ať se do potvrzení z Googlu znovu neukáže
        val pending = goAsync()
        thread {
            try {
                Sync.completeTask(ctx, listId, taskId)
            } catch (e: Exception) {
                Notify.show(ctx, "Úkol se nepodařilo splnit", e.message ?: "Zkus to v appce.", ("done:$taskId").hashCode())
            } finally { pending.finish() }
        }
    }
}
