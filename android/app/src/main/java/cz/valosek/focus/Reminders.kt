package cz.valosek.focus

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build

// Připomínky jako budíky systému: zazvoní přesně i se zavřenou appkou a v úsporném režimu.
object Reminders {
    class Item(val key: String, val at: Long, val title: String, val text: String)

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences("focus", Context.MODE_PRIVATE)

    // Naplánuje nové, přeplánuje změněné a zruší ty, které z Googlu zmizely (smazaná nebo přesunutá událost, splněný úkol).
    fun schedule(ctx: Context, items: List<Item>) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val p = prefs(ctx)
        val now = System.currentTimeMillis()
        val fresh = items.filter { it.at > now }
        val keep = fresh.map { it.key }.toSet()
        for (k in (p.getStringSet("keys", emptySet()) ?: emptySet()) - keep)
            pending(ctx, k, null, PendingIntent.FLAG_NO_CREATE)?.let { am.cancel(it); it.cancel() }
        for (item in fresh) {
            val pi = pending(ctx, item.key, item, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms())
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.at, pi)
        }
        p.edit().putStringSet("keys", keep).apply()
    }

    private fun pending(ctx: Context, key: String, item: Item?, flag: Int): PendingIntent? {
        val i = Intent(ctx, ReminderReceiver::class.java).setData(Uri.parse("focus://reminder/" + Uri.encode(key)))
        if (item != null) i.putExtra("title", item.title).putExtra("text", item.text)
        return PendingIntent.getBroadcast(ctx, 0, i, flag or PendingIntent.FLAG_IMMUTABLE)
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val title = intent.getStringExtra("title") ?: return
        Notify.show(ctx, title, intent.getStringExtra("text") ?: "", (intent.data?.toString() ?: title).hashCode())
    }
}

// Po restartu telefonu a po aktualizaci appky systém budíky zapomene – hned je naplánovat znovu.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Sync.periodic(ctx)
        Sync.now(ctx)
    }
}
