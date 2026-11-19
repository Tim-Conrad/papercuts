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
}
