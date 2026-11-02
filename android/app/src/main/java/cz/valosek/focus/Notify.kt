package cz.valosek.focus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

// Zobrazení oznámení v kanálu „Připomínky“.
object Notify {
    private const val CHANNEL = "reminders"

    fun show(ctx: Context, title: String, text: String, id: Int = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Připomínky", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF7C5CD6.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        nm.notify(id, n)
    }
}
