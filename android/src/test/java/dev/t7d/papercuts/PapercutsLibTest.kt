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
