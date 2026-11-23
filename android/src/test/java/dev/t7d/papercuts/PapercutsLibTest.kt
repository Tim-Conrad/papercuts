package dev.t7d.papercuts

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Locale
import java.util.TimeZone

class PapercutsLibTest {
    private fun tmp(): File = Files.createTempDirectory("pc").toFile()

    @Test fun eventLogKeepsRecentAndCutsValues() {
        var now = 1_000_000L
        val f = File(tmp(), "e.jsonl")
        val log = EventLog(f, maxAgeMs = 10_000, maxCount = 3, clock = { now })
        log.add("start", mapOf("source" to "aa", "long" to "x".repeat(500), "n" to 3))
        assertEquals(EventLog.MAX_VALUE, log.recent()[0].fields["long"]!!.length)
        assertEquals("3", log.recent()[0].fields["n"])
        repeat(4) { log.add("e$it", emptyMap()) }
        assertEquals(listOf("e1", "e2", "e3"), log.recent().map { it.name })
        // survives a restart, drops what is too old
        assertEquals(3, EventLog(f, maxAgeMs = 10_000, clock = { now }).recent().size)
        now += 20_000
        assertEquals(0, EventLog(f, maxAgeMs = 10_000, clock = { now }).recent().size)
    }

    @Test fun eventLogKeepsTheWholeDayAndRewritesRarely() {
        var now = 1_000_000L
        val f = File(tmp(), "e.jsonl")
        val log = EventLog(f, maxAgeMs = 24 * 3600_000L, maxCount = 100, clock = { now })
        repeat(250) { log.add("e$it", emptyMap()); now += 60_000 }
        // exact limits on read, the file keeps at most a tenth more
        assertEquals(100, log.all().size)
        assertEquals("e249", log.all().last().name)
        assertTrue(f.readLines().size in 100..110)
        assertEquals(100, EventLog(f, maxAgeMs = 24 * 3600_000L, maxCount = 100, clock = { now }).all().size)
    }

    private val utc = TimeZone.getTimeZone("UTC")
    private fun ev(sec: Int, name: String, vararg f: Pair<String, String>) = EventLog.Event(sec * 1000L, name, linkedMapOf(*f))

    @Test fun compactCountsRepeatsAndMarksCalls() {
        val events = listOf(
            ev(10, "aa_list", "folder" to "start"), ev(11, "aa_list", "folder" to "start"), ev(12, "aa_list", "folder" to "chats"),
            ev(20, "call_start", "source" to "aa_chat", "audio" to "hfp"),
            ev(21, "net", "n" to "wlan"), ev(25, "net", "n" to "wlan"), ev(26, "net", "n" to "mobil"),
            ev(30, "start_try", "n" to "1"), ev(31, "start_try", "n" to "2"),
            ev(40, "aa_list", "folder" to "start"),
            ev(50, "call_start", "source" to "aa_play", "audio" to "media"),
        )
        val lines = EventLog.compact(events, quiet = setOf("aa_list"), sections = setOf("call_start"), zone = utc)
        assertEquals(
            listOf(
                "-- 1970-01-01 --",
                "00:00:10 aa_list ×3 until 00:00:12: folder=start ×2, folder=chats",
                "",
                "## 00:00:20 call_start source=aa_chat audio=hfp",
                "00:00:21 net n=wlan ×2 until 00:00:25",
                "00:00:26 net n=mobil",
                // not quiet: different fields stay separate lines
                "00:00:30 start_try n=1",
                "00:00:31 start_try n=2",
                "00:00:40 aa_list folder=start",
                "",
                "## 00:00:50 call_start source=aa_play audio=media",
            ),
            lines,
        )
        // a new day gets its own line
        val two = EventLog.compact(listOf(ev(10, "a"), ev(86_400 + 5, "b")), zone = utc)
        assertEquals(listOf("-- 1970-01-01 --", "00:00:10 a", "-- 1970-01-02 --", "00:00:05 b"), two)
    }

    @Test fun reportKeepsTheNewestLinesWhenTooLong() {
        val lines = (1..5000).map { "12:00:00 event n=$it with some text" }
        val text = EventLog.report(lines, 5000, 60_000)
        assertTrue(text.length <= 60_000)
        assertTrue(text.contains("Cut: the "))
        assertTrue(text.trimEnd().endsWith("n=5000 with some text"))
        assertFalse(text.contains("n=1 with"))
        val short = EventLog.report(listOf("a", "b"), 2, 60_000)
        assertEquals("# 2 events of the last 24 h on this device, oldest first. Repeats are counted (×n).\na\nb\n", short)
    }

    @Test fun eventFormat() {
        val e = EventLog.Event(0, "call_start", linkedMapOf("source" to "aa_chat", "page" to "chat"))
        assertTrue(EventLog.format(e, Locale.ROOT).endsWith(" call_start source=aa_chat page=chat"))
        assertNull(EventLog.parse("kaputt"))
    }

    @Test fun payloadWithAndWithoutState() {
        val d = Draft(id = "abc", where = "MainActivity", context = JSONObject().put("phase", "READY"),
            attachments = listOf(Attachment("dom.html", "<main></main>")), shot = byteArrayOf(1, 2))
        val full = ReportPayload.build(d, "Tim-Conrad/x", "  Menü geht nicht ", withState = true)
        assertEquals("human", full.getString("from"))
        val r = full.getJSONObject("report")
        assertEquals("Menü geht nicht", r.getString("text"))
        assertEquals("other", r.getString("kind"))
        assertEquals("READY", r.getJSONObject("context").getString("phase"))
        assertEquals("dom.html", r.getJSONArray("attachments").getJSONObject(0).getString("name"))
        assertTrue(r.getString("shot").startsWith("data:image/png;base64,"))
        val bare = ReportPayload.build(d, "Tim-Conrad/x", "t", withState = false).getJSONObject("report")
        assertFalse(bare.has("context") || bare.has("attachments") || bare.has("shot"))
    }

    @Test fun contextMergesBaseStateAndEvents() {
        val c = ReportPayload.context(State(mapOf("phase" to "ACTIVE", "n" to 2, "list" to listOf("a"))), listOf("e1"), mapOf("app" to "1.0", "phase" to "old"))
        assertEquals("ACTIVE", c.getString("phase"))
        assertEquals("1.0", c.getString("app"))
        assertEquals(2, c.getInt("n"))
        assertEquals("e1", c.getJSONArray("events").getString(0))
    }

    @Test fun draftRoundTripAndBadId() {
        val d = Draft(where = "car", attachments = listOf(Attachment("dom.html", "x")), shot = byteArrayOf(9))
        val back = Draft.fromJson(JSONObject(d.toJson().toString()))!!
        assertEquals(d.id, back.id)
        assertEquals("car", back.where)
        assertEquals(9, back.shot!![0].toInt())
        assertNull(Draft.fromJson(JSONObject(d.toJson().put("id", "../x").toString())))
    }

    @Test fun sendOutcomes() {
        assertEquals(SendOutcome.DONE, outcomeOf(200, null))
        assertEquals(SendOutcome.KEEP, outcomeOf(0, null))
        assertEquals(SendOutcome.KEEP, outcomeOf(502, true))
        assertEquals(SendOutcome.KEEP, outcomeOf(401, false))
        assertEquals(SendOutcome.KEEP, outcomeOf(302, null))
        assertEquals(SendOutcome.KEEP, outcomeOf(404, null))
        assertEquals(SendOutcome.DROP, outcomeOf(400, false))
        assertEquals(SendOutcome.DROP, outcomeOf(403, false))
    }

    @Test fun outboxWithoutTokenKeepsReports() {
        val o = Outbox(tmp())
        o.add("r1", JSONObject().put("x", 1))
        assertEquals(0, o.flush("https://relay.invalid", null))
        assertEquals(1, o.pending().size)
        assertEquals("no token", o.lastError)
    }

    @Test fun shotAndPinsGoWhenKeptEvenWithoutState() {
        val d = Draft(id = "abc", context = JSONObject().put("phase", "READY"), shot = byteArrayOf(1))
        val r = ReportPayload.build(d, "Tim-Conrad/x", "t", withState = false, shot = byteArrayOf(7), pins = listOf("Menü", "")).getJSONObject("report")
        assertFalse(r.has("context"))
        assertTrue(r.getString("shot").startsWith("data:image/png;base64,"))
        assertEquals(2, r.getJSONArray("pins").length())
        assertEquals(1, r.getJSONArray("pins").getJSONObject(0).getInt("nr"))
        assertEquals("Menü", r.getJSONArray("pins").getJSONObject(0).getString("text"))
        // removed in the sheet: no picture and no pins
        val none = ReportPayload.build(d, "Tim-Conrad/x", "t", withState = true, shot = null, pins = listOf("x")).getJSONObject("report")
        assertFalse(none.has("shot") || none.has("pins"))
    }

    @Test fun sentReadsTheRelayAnswer() {
        val ok = Sent.of(200, """{"ok":true,"issue":42,"url":"https://github.com/o/r/issues/42"}""")
        assertEquals(SendOutcome.DONE, ok.outcome)
        assertEquals(42, ok.issue)
        assertEquals("https://github.com/o/r/issues/42", ok.url)
        val bad = Sent.of(400, """{"ok":false,"retry":false,"error":"text is empty","help":"write one sentence"}""")
        assertEquals(SendOutcome.DROP, bad.outcome)
        assertEquals("text is empty", bad.error)
        assertEquals("write one sentence", bad.help)
        assertNull(Sent.of(200, """{"ok":true,"issue":1,"url":"javascript:x"}""").url)
        assertEquals(SendOutcome.KEEP, Sent.of(0, null).outcome)
    }

    @Test fun outboxSendWithoutTokenAnswersNothing() {
        val o = Outbox(tmp())
        o.add("r1", JSONObject().put("x", 1))
        assertTrue(o.send("https://relay.invalid", null).isEmpty())
        assertEquals("no token", o.lastError)
    }

    @Test fun speechLanguageChoice() {
        // The kept choice wins; then the app config; then the phone.
        assertEquals("en", SpeechLang.initial("en", "de-DE", Locale.GERMANY))
        assertEquals("de", SpeechLang.initial(null, "de-AT", Locale.US))
        assertEquals("en", SpeechLang.initial(null, null, Locale.US))
        assertEquals("de", SpeechLang.initial(null, "", Locale.GERMANY))
        assertEquals("en", SpeechLang.initial("fr", "fr-FR", Locale.FRANCE))
        // The configured tag when it fits the choice, else a plain one.
        assertEquals("de-AT", SpeechLang.tag("de", "de-AT"))
        assertEquals("en-US", SpeechLang.tag("en", "de-AT"))
        assertEquals("de-DE", SpeechLang.tag("de", null))
        assertEquals("en_GB", SpeechLang.tag("en", "en_GB"))
    }
}
