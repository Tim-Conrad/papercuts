package dev.t7d.papercuts

import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * What the app did lately, kept only on the device. Events leave it only inside a report that a person sends.
 * Append-only JSON lines; old lines are dropped by age and count. Not thread-safe: call from one thread.
 */
class EventLog(
    private val file: File,
    private val maxAgeMs: Long = 24 * 3600_000L,
    private val maxCount: Int = 5000,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    data class Event(val time: Long, val name: String, val fields: Map<String, String>)

    private val events = ArrayList<Event>()

    init {
        try {
            if (file.exists()) file.readLines().mapNotNullTo(events, ::parse)
        } catch (_: Exception) {
        }
        prune(force = true)
    }

    fun add(name: String, fields: Map<String, Any?>) {
        val e = Event(clock(), clip(name, MAX_NAME), fields.entries.take(MAX_FIELDS).associate { (k, v) -> clip(k, MAX_NAME) to clip(v.toString(), MAX_VALUE) })
        events.add(e)
        val pruned = prune(force = false)
        try {
            file.parentFile?.mkdirs()
            if (pruned) file.writeText(events.joinToString("") { line(it) + "\n" }) else file.appendText(line(e) + "\n")
        } catch (_: Exception) {
        }
    }

    /** The events of the last [windowMs], newest last, at most [max]. */
    fun recent(windowMs: Long = 30 * 60_000L, max: Int = 80): List<Event> {
        val from = clock() - windowMs
        return events.filter { it.time >= from }.takeLast(minOf(max, maxCount))
    }

    /** Every event the device keeps (the last 24 h, at most maxCount), oldest first. */
    fun all(): List<Event> = recent(maxAgeMs, maxCount)

    fun clear() {
        events.clear()
        file.delete()
    }

    /**
     * Drops what is too old or too many. A rewrite of the file for every event costs a full write per event once the
     * log is full. So a normal add drops only when a tenth of maxCount or of maxAgeMs (at most an hour) piled up.
     * [all] and [recent] apply the exact limits.
     */
    private fun prune(force: Boolean): Boolean {
        val before = events.size
        val now = clock()
        val slackCount = if (force) 0 else maxOf(1, maxCount / 10)
        val slackAge = if (force) 0L else minOf(3600_000L, maxAgeMs / 10)
        if (events.isNotEmpty() && events[0].time < now - maxAgeMs - slackAge) events.removeAll { it.time < now - maxAgeMs }
        if (events.size > maxCount + slackCount) events.subList(0, events.size - maxCount).clear()
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
        fun format(e: Event, locale: Locale = Locale.ROOT, zone: TimeZone = TimeZone.getDefault()): String {
            val time = dateFormat("HH:mm:ss", locale, zone).format(Date(e.time))
            val f = fieldText(e)
            return if (f.isEmpty()) "$time ${e.name}" else "$time ${e.name} $f"
        }

        private fun fieldText(e: Event) = e.fields.entries.joinToString(" ") { (k, v) -> "$k=$v" }

        private fun dateFormat(pattern: String, locale: Locale, zone: TimeZone) =
            SimpleDateFormat(pattern, locale).apply { timeZone = zone }

        /**
         * The events as lines that a person reads, oldest first. Repeats become one line with a count:
         * - a run of equal events (same name and fields): `14:02:11 net n=wlan ×3 until 14:05:40`;
         * - a run of [quiet] events with any fields: `14:02:11 aa_list ×4 until 14:02:13: folder=a ×3, folder=b`.
         *
         * An event in [sections] (for example `call_start`) opens a block: an empty line, then its line with `## `.
         * A line `-- 2026-11-23 --` starts each day.
         */
        fun compact(
            events: List<Event>,
            quiet: Set<String> = emptySet(),
            sections: Set<String> = emptySet(),
            locale: Locale = Locale.ROOT,
            zone: TimeZone = TimeZone.getDefault(),
        ): List<String> {
            val out = ArrayList<String>()
            val time = dateFormat("HH:mm:ss", locale, zone)
            val day = dateFormat("yyyy-MM-dd", locale, zone)
            var lastDay: String? = null
            var i = 0
            while (i < events.size) {
                val e = events[i]
                val isQuiet = e.name in quiet
                var j = i + 1
                while (j < events.size && events[j].name == e.name && (isQuiet || events[j].fields == e.fields)) j++
                val d = day.format(Date(e.time))
                if (d != lastDay) {
                    out.add("-- $d --")
                    lastDay = d
                }
                val run = events.subList(i, j)
                val until = "until ${time.format(Date(run.last().time))}"
                val text = when {
                    run.size == 1 -> format(e, locale, zone)
                    run.all { it.fields == e.fields } -> "${format(e, locale, zone)} ×${run.size} $until"
                    else -> {
                        val counts = LinkedHashMap<String, Int>()
                        run.forEach { val f = fieldText(it); counts[f] = (counts[f] ?: 0) + 1 }
                        val parts = counts.entries.joinToString(", ") { (f, c) -> if (c == 1) f else "$f ×$c" }
                        "${time.format(Date(e.time))} ${e.name} ×${run.size} $until: $parts"
                    }
                }
                if (e.name in sections) {
                    if (out.last().isNotEmpty() && !out.last().startsWith("-- ")) out.add("")
                    out.add("## $text")
                } else {
                    out.add(text)
                }
                i = j
            }
            return out
        }

        /**
         * The text of the attachment `events.log`: a head line, then [lines]. If the text is longer than [maxChars],
         * the oldest lines go, and the head says how many.
         */
        fun report(lines: List<String>, events: Int, maxChars: Int): String {
            val head = "# $events events of the last 24 h on this device, oldest first. Repeats are counted (×n)."
            val room = maxChars - head.length - 120
            var from = 0
            var size = lines.sumOf { it.length + 1 }
            while (from < lines.size && size > room) size -= lines[from++].length + 1
            val cut = if (from > 0) "\n# Cut: the $from oldest lines are missing, so that the text stays under $maxChars characters." else ""
            return head + cut + "\n" + lines.subList(from, lines.size).joinToString("\n") + "\n"
        }
    }
}
