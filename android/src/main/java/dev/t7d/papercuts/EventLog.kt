package dev.t7d.papercuts

import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What the app did lately, kept only on the device. Events leave it only inside a report that a person sends.
 * Append-only JSON lines; old lines are dropped by age and count. Not thread-safe: call from one thread.
 */
class EventLog(
    private val file: File,
    private val maxAgeMs: Long = 24 * 3600_000L,
    private val maxCount: Int = 300,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    data class Event(val time: Long, val name: String, val fields: Map<String, String>)

    private val events = ArrayList<Event>()

    init {
        try {
            if (file.exists()) file.readLines().mapNotNullTo(events, ::parse)
        } catch (_: Exception) {
        }
        prune()
    }

    fun add(name: String, fields: Map<String, Any?>) {
        val e = Event(clock(), clip(name, MAX_NAME), fields.entries.take(MAX_FIELDS).associate { (k, v) -> clip(k, MAX_NAME) to clip(v.toString(), MAX_VALUE) })
        events.add(e)
        val pruned = prune()
        try {
            file.parentFile?.mkdirs()
            if (pruned) file.writeText(events.joinToString("") { line(it) + "\n" }) else file.appendText(line(e) + "\n")
        } catch (_: Exception) {
        }
    }

    /** The events of the last [windowMs], newest last, at most [max]. */
    fun recent(windowMs: Long = 30 * 60_000L, max: Int = 80): List<Event> {
        val from = clock() - windowMs
        return events.filter { it.time >= from }.takeLast(max)
    }

    fun clear() {
        events.clear()
        file.delete()
    }

    private fun prune(): Boolean {
        val before = events.size
        val from = clock() - maxAgeMs
        events.removeAll { it.time < from }
        while (events.size > maxCount) events.removeAt(0)
        return events.size != before
    }

    companion object {
        const val MAX_NAME = 40
        const val MAX_VALUE = 120
        const val MAX_FIELDS = 8

        private fun clip(s: String, max: Int) = s.replace(Regex("\\s+"), " ").trim().take(max)

        fun line(e: Event): String = JSONObject().put("t", e.time).put("n", e.name).put("f", JSONObject(e.fields)).toString()

        fun parse(line: String): Event? = try {
            val o = JSONObject(line)
            val f = o.optJSONObject("f")
            val fields = LinkedHashMap<String, String>()
            f?.keys()?.forEach { k -> fields[k] = f.optString(k) }
            Event(o.getLong("t"), o.getString("n"), fields)
        } catch (_: Exception) {
            null
        }

        /** One line per event for the report, for example `14:02:11 call_start source=aa_chat`. */
        fun format(e: Event, locale: Locale = Locale.ROOT): String {
            val time = SimpleDateFormat("HH:mm:ss", locale).format(Date(e.time))
            val f = e.fields.entries.joinToString(" ") { (k, v) -> "$k=$v" }
            return if (f.isEmpty()) "$time ${e.name}" else "$time ${e.name} $f"
        }
    }
}
