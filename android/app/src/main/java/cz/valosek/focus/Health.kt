package cz.valosek.focus

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Zdraví z Health Connect (Pixel Watch 3 → appka Fitbit → Health Connect → Focus). Jen čtení, data zůstávají v telefonu.
object Health {
    val PERMISSIONS = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class)
    )
    private val HM = DateTimeFormatter.ofPattern("H:mm")

    // "unavailable" (telefon Health Connect nemá), "update" (je potřeba aktualizovat), "ok"
    fun sdk(ctx: Context): String = when (HealthConnectClient.getSdkStatus(ctx)) {
        HealthConnectClient.SDK_AVAILABLE -> "ok"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update"
        else -> "unavailable"
    }

    fun granted(ctx: Context): Set<String> = runBlocking {
        HealthConnectClient.getOrCreate(ctx).permissionController.getGrantedPermissions()
    }

    // Souhrn pro záložku Zdraví: dnešek + tento týden (po–ne).
    fun read(ctx: Context): JSONObject = runBlocking {
        val hc = HealthConnectClient.getOrCreate(ctx)
        val have = hc.permissionController.getGrantedPermissions()
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val dayStart = today.atStartOfDay(zone).toInstant()
        val now = Instant.now()
        val monday = today.minusDays((today.dayOfWeek.value - 1).toLong())
        val out = JSONObject()
        fun has(c: kotlin.reflect.KClass<out androidx.health.connect.client.records.Record>) = HealthPermission.getReadPermission(c) in have

        if (has(StepsRecord::class)) {
            val r = hc.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), TimeRangeFilter.between(dayStart, now)))
            out.put("steps", r[StepsRecord.COUNT_TOTAL] ?: 0L)
            val week = JSONArray()
            val groups = hc.aggregateGroupByPeriod(AggregateGroupByPeriodRequest(
                setOf(StepsRecord.COUNT_TOTAL),
                TimeRangeFilter.between(monday.atStartOfDay(), monday.plusDays(7).atStartOfDay()),
                Period.ofDays(1)))
            val byDay = groups.associate { it.startTime.toLocalDate() to (it.result[StepsRecord.COUNT_TOTAL] ?: 0L) }
            for (i in 0 until 7) week.put(byDay[monday.plusDays(i.toLong())] ?: 0L)
            out.put("weekSteps", week)
        }
        if (has(TotalCaloriesBurnedRecord::class)) {
            val r = hc.aggregate(AggregateRequest(setOf(TotalCaloriesBurnedRecord.ENERGY_TOTAL), TimeRangeFilter.between(dayStart, now)))
            r[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { out.put("kcal", Math.round(it.inKilocalories)) }
        }
        if (has(SleepSessionRecord::class)) {
            // spánek patří ke dni, kdy skončil (noc na pondělí = pondělí)
            val from = monday.minusDays(1).atStartOfDay(zone).toInstant()
            val sessions = hc.readRecords(ReadRecordsRequest(SleepSessionRecord::class, TimeRangeFilter.between(from, now))).records
            val mins = LongArray(7)
            var lastNight = 0L
            for (s in sessions) {
                val end = s.endTime.atZone(zone).toLocalDate()
                val m = Duration.between(s.startTime, s.endTime).toMinutes()
                val idx = java.time.temporal.ChronoUnit.DAYS.between(monday, end).toInt()
                if (idx in 0..6) mins[idx] += m
                if (end == today) lastNight += m
            }
            out.put("sleepMin", lastNight)
            out.put("weekSleep", JSONArray(mins.toList()))
        }
        if (has(RestingHeartRateRecord::class)) {
            val r = hc.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class,
                TimeRangeFilter.between(now.minus(Duration.ofDays(3)), now))).records
            r.maxByOrNull { it.time }?.let { out.put("rhr", it.beatsPerMinute) }
        }
        if (has(ExerciseSessionRecord::class)) {
            val r = hc.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(dayStart, now))).records
            val list = JSONArray()
            var total = 0L
            for (e in r.sortedBy { it.startTime }) {
                val m = Duration.between(e.startTime, e.endTime).toMinutes()
                total += m
                list.put(JSONObject().put("name", e.title ?: exerciseName(e.exerciseType)).put("min", m).put("at", e.startTime.atZone(zone).format(HM)))
            }
            out.put("workouts", list)
            out.put("azm", total)
        }
        out.put("granted", have.size).put("needed", PERMISSIONS.size)
        out
    }

    private fun exerciseName(t: Int) = when (t) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "Běh"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "Chůze"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "Kolo"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "Turistika"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "Posilování"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "Plavání"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "Jóga"
        else -> "Cvičení"
    }
}
