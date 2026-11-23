package dev.t7d.papercuts

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** The outbox against a relay on 127.0.0.1: one that answers, one that refuses, and one that never answers. */
class OutboxTest {
    private val servers = mutableListOf<ServerSocket>()
    private val held = Collections.synchronizedList(mutableListOf<Socket>())

    @After fun stop() {
        servers.forEach { it.close() }
        held.forEach { runCatching { it.close() } }
    }

    private fun tmp(): File = Files.createTempDirectory("pc").toFile()

    private fun report(id: String, text: String) = JSONObject().put("from", "human").put("report", JSONObject().put("id", id).put("text", text))

    /** A relay that answers each POST with [answer] (status and JSON) and records the ids in order. */
    private fun relay(posts: MutableList<String>, answer: (String) -> Pair<Int, String>): String {
        val ss = ServerSocket(0, 50, InetAddress.getLoopbackAddress()).also { servers += it }
        thread(isDaemon = true) {
            while (!ss.isClosed) {
                val s = try { ss.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) {
                    s.use {
                        val input = it.getInputStream().bufferedReader()
                        val first = input.readLine() ?: return@use
                        var length = 0
                        while (true) {
                            val h = input.readLine() ?: break
                            if (h.isEmpty()) break
                            if (h.lowercase().startsWith("content-length:")) length = h.substringAfter(':').trim().toInt()
                        }
                        val body = CharArray(length).also { b -> var n = 0; while (n < length) n += input.read(b, n, length - n) }
                        val (code, json) = if (first.startsWith("POST /app-report")) {
                            val id = JSONObject(String(body)).getJSONObject("report").getString("id")
                            posts += id
                            answer(id)
                        } else 302 to "" // /healthz behind a login: still an answer
                        val bytes = json.toByteArray()
                        it.getOutputStream().write(("HTTP/1.1 $code X\r\ncontent-type: application/json\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n").toByteArray() + bytes)
                    }
                }
            }
        }
        return "http://127.0.0.1:${ss.localPort}"
    }

    /** Takes the connection and says nothing, like a relay behind a network that drops the packets. */
    private fun silentRelay(): String {
        val ss = ServerSocket(0, 50, InetAddress.getLoopbackAddress()).also { servers += it }
        thread(isDaemon = true) { while (!ss.isClosed) held += try { ss.accept() } catch (_: Exception) { break } }
        return "http://127.0.0.1:${ss.localPort}"
    }

    @Test fun unreachableRelayFailsFastAndKeepsTheReports() {
        val dir = tmp()
        val o = Outbox(dir)
        o.add("r1", report("r1", "eins"))
        o.add("r2", report("r2", "zwei"))
        val t0 = System.nanoTime()
        val out = o.send(silentRelay(), "token")
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("took $ms ms", ms < 3_000)
        assertTrue(out.isEmpty())
        assertEquals(2, o.pending().size)
        assertEquals("relay not reachable", o.lastError)
        assertEquals(1, o.attempts)
        // The error and the count survive a restart (the job runs in a new process).
        val again = Outbox(dir)
        assertEquals("relay not reachable", again.lastError)
        assertTrue(again.lastTry!! > 0)
        assertEquals(OutboxStatus(2, "relay not reachable", again.lastTry), again.status())
    }

    @Test fun closedPortFailsFast() {
        val port = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        val o = Outbox(tmp())
        o.add("r1", report("r1", "eins"))
        val t0 = System.nanoTime()
        assertTrue(o.send("http://127.0.0.1:$port", "token").isEmpty())
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 3_000)
        assertEquals(1, o.pending().size)
    }

    @Test fun filesTheNewReportFirstAndClearsTheError() {
        val dir = tmp()
        val o = Outbox(dir)
        o.send(silentRelay(), "token") // nothing waits: no probe, no error
        assertNull(o.lastError)
        o.add("old", report("old", "alt"))
        File(dir, "old.json").setLastModified(System.currentTimeMillis() - 60_000)
        o.add("new", report("new", "neu"))
        o.send(silentRelay(), "token")
        assertEquals(1, o.attempts)
        val posts = Collections.synchronizedList(mutableListOf<String>())
        var n = 0
        val out = o.send(relay(posts) { id -> 201 to """{"ok":true,"issue":${++n + 10},"url":"https://github.com/o/r/issues/$id"}""" }, "token", first = "new")
        assertEquals(listOf("new", "old"), posts)
        assertEquals(listOf("new", "old"), out.map { it.id })
        assertEquals(11, out[0].sent.issue)
        assertEquals("neu", out[0].text)
        assertEquals(0, o.pending().size)
        assertNull(o.lastError)
        assertEquals(0, o.attempts)
    }

    @Test fun refusedReportIsDroppedAndNamed() {
        val o = Outbox(tmp())
        o.add("bad", report("bad", "x"))
        val out = o.send(relay(mutableListOf()) { 403 to """{"ok":false,"retry":false,"error":"repo not allowed","help":"ask the owner"}""" }, "token")
        assertEquals(SendOutcome.DROP, out.single().sent.outcome)
        assertEquals("ask the owner", out.single().sent.help)
        assertEquals(0, o.pending().size)
        assertEquals("refused (403): repo not allowed", o.lastError)
    }

    @Test fun busyRelayKeepsTheRestForLater() {
        val o = Outbox(tmp())
        o.add("a", report("a", "a"))
        o.add("b", report("b", "b"))
        val posts = mutableListOf<String>()
        val out = o.send(relay(posts) { 502 to """{"ok":false,"error":"GitHub down"}""" }, "token")
        assertEquals(listOf(SendOutcome.KEEP), out.map { it.sent.outcome })
        assertEquals(1, posts.size)
        assertEquals(2, o.pending().size)
        assertEquals("relay 502: GitHub down", o.lastError)
    }

    @Test fun backoffGrowsToFifteenMinutes() {
        assertEquals(30_000L, Delivery.backoffMs(0))
        assertEquals(30_000L, Delivery.backoffMs(1))
        assertEquals(60_000L, Delivery.backoffMs(2))
        assertEquals(240_000L, Delivery.backoffMs(4))
        assertEquals(15 * 60_000L, Delivery.backoffMs(7))
        assertEquals(15 * 60_000L, Delivery.backoffMs(500))
    }

    @Test fun deliveryJoinsRequestsAndPlansTheNextTry() {
        val dir = tmp()
        val o = Outbox(dir)
        o.add("r1", report("r1", "eins"))
        val plans = Collections.synchronizedList(mutableListOf<Delivery.Next?>())
        val got = Collections.synchronizedList(mutableListOf<String>())
        val ran = CountDownLatch(1)
        var url = silentRelay()
        val d = Delivery(o, { url }, { "token" }, delivered = { got += it.id }, plan = { plans += it })
        // The request returns at once, whatever the network does.
        val t0 = System.nanoTime()
        d.request(first = "r1") { ran.countDown() }
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 50)
        assertTrue(ran.await(5, TimeUnit.SECONDS))
        Thread.sleep(50) // the plan comes right after the finisher
        assertEquals(listOf(Delivery.Next(30_000)), plans.toList())
        // Home again: filed, nothing waits, no next try.
        url = relay(mutableListOf()) { 201 to """{"ok":true,"issue":5,"url":"https://github.com/o/r/issues/5"}""" }
        val done = CountDownLatch(1)
        d.request { done.countDown() }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        Thread.sleep(50)
        assertEquals(listOf("r1"), got.toList())
        assertNull(plans.last())
    }

    @Test fun deliveryWithoutTokenPlansNothing() {
        val o = Outbox(tmp())
        o.add("r1", report("r1", "eins"))
        val plans = Collections.synchronizedList(mutableListOf<Delivery.Next?>())
        val done = CountDownLatch(1)
        Delivery(o, { "https://relay.invalid" }, { null }, delivered = {}, plan = { plans += it }).request { done.countDown() }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        Thread.sleep(50)
        assertEquals(listOf<Delivery.Next?>(null), plans.toList())
        assertEquals("no token", o.lastError)
    }
}
