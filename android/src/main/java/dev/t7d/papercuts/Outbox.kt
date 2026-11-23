package dev.t7d.papercuts

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** What the relay answered to one report: the issue when it was filed, else the error and the help. */
data class Sent(val outcome: SendOutcome, val code: Int, val issue: Int? = null, val url: String? = null, val error: String = "", val help: String = "") {
    companion object {
        fun of(code: Int, body: String?): Sent {
            val o = try { if (body.isNullOrBlank()) null else JSONObject(body) } catch (_: Exception) { null }
            val retry = o?.optBoolean("retry", true)
            return Sent(
                outcome = outcomeOf(code, retry),
                code = code,
                issue = o?.optInt("issue", 0)?.takeIf { it > 0 },
                url = o?.optString("url", "")?.takeIf { it.startsWith("https://") },
                error = o?.optString("error", "").orEmpty().take(120),
                help = o?.optString("help", "").orEmpty().take(200),
            )
        }
    }
}

/** The state of the outbox, for a settings summary: waiting reports, the last error and the time of the last try. */
data class OutboxStatus(val waiting: Int, val lastError: String?, val lastTry: Long?)

/**
 * Reports that are sent but not yet filed. One file each; the relay is often out of reach (home network only).
 * Blocking: call [send] off the main thread. The relay files a report once per id, so a second send is safe.
 */
class Outbox(private val dir: File, private val timeouts: Timeouts = Timeouts()) {
    /**
     * [probeMs]: the limit for DNS, connect and answer of the reachability probe, so an unreachable relay fails in
     * about that time. [connectMs] and [readMs] hold for the report itself (the relay uploads the picture to GitHub).
     */
    data class Timeouts(val probeMs: Int = 1500, val connectMs: Int = 5_000, val readMs: Int = 30_000)

    /** One report the relay answered. The [text] of the person goes with it, for a notification. */
    data class Delivered(val id: String, val sent: Sent, val text: String)

    private val stateFile = File(dir, ".state")

    /** The last send error. It survives a restart of the app (the background job can run in a new process). */
    val lastError: String? get() = state().optString("error").ifEmpty { null }
    val lastTry: Long? get() = state().optLong("try").takeIf { it > 0 }

    /** Failed tries in a row while reports wait. The delay of the next try grows with it. */
    val attempts: Int get() = state().optInt("attempts")

    fun status() = OutboxStatus(pending().size, lastError, lastTry)

    fun add(id: String, payload: JSONObject) {
        dir.mkdirs()
        val tmp = File(dir, "$id.tmp")
        tmp.writeText(payload.toString())
        tmp.renameTo(File(dir, "$id.json"))
    }

    fun pending(): List<File> = (dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()).sortedBy { it.lastModified() }

    /** Sends every waiting report. Returns how many were filed. */
    fun flush(relayUrl: String, token: String?): Int = send(relayUrl, token).count { it.sent.outcome == SendOutcome.DONE }

    /**
     * Sends every waiting report, [first] before the others, and answers what became of each. A short probe comes
     * first: when the relay does not answer, nothing is posted. A report that was not tried (the relay stopped
     * answering before it) is missing from the answer: it still waits.
     */
    fun send(relayUrl: String, token: String?, first: String? = null): List<Delivered> {
        val files = pending().sortedBy { if (it.name == "$first.json") 0 else 1 }
        if (files.isEmpty()) {
            if (lastError != null || attempts != 0) save(null, tried = false, attempts = 0)
            return emptyList()
        }
        if (token.isNullOrBlank() || relayUrl.isBlank()) {
            save(if (token.isNullOrBlank()) "no token" else "no relay", tried = false)
            return emptyList()
        }
        val base = relayUrl.trimEnd('/')
        if (!reachable(base)) {
            save("relay not reachable", attempts = attempts + 1)
            return emptyList()
        }
        val out = mutableListOf<Delivered>()
        for (f in files) {
            val body = try { f.readText() } catch (_: Exception) { continue } // filed by another run meanwhile
            val (code, answer) = post("$base/app-report", token, body)
            val sent = Sent.of(code, answer)
            out += Delivered(f.name.removeSuffix(".json"), sent, textOf(body))
            when (sent.outcome) {
                SendOutcome.DONE, SendOutcome.DROP -> f.delete()
                SendOutcome.KEEP -> {
                    save(if (code == 0) "relay not reachable" else "relay $code: ${sent.error}", attempts = attempts + 1)
                    return out
                }
            }
        }
        val dropped = out.lastOrNull { it.sent.outcome == SendOutcome.DROP }
        save(dropped?.let { "refused (${it.sent.code}): ${it.sent.error}" }, attempts = 0)
        return out
    }

    private fun state(): JSONObject = try { JSONObject(stateFile.readText()) } catch (_: Exception) { JSONObject() }

    private fun save(error: String?, tried: Boolean = true, attempts: Int = this.attempts) {
        val o = state()
        o.put("error", error ?: "").put("attempts", attempts)
        if (tried) o.put("try", System.currentTimeMillis())
        try {
            dir.mkdirs()
            val tmp = File(dir, ".state.tmp")
            tmp.writeText(o.toString())
            tmp.renameTo(stateFile)
        } catch (_: Exception) {
            // The state is only a summary. The reports themselves are safe.
        }
    }

    /**
     * Any HTTP answer counts (a login redirect too): the relay host is there. DNS gets its own limit, because
     * HttpURLConnection waits for the system resolver without one.
     */
    internal fun reachable(base: String): Boolean = try {
        val url = URL("$base/healthz")
        dns.submit<Unit> { InetAddress.getAllByName(url.host) }.get(timeouts.probeMs.toLong(), TimeUnit.MILLISECONDS)
        val c = url.openConnection() as HttpURLConnection
        c.connectTimeout = timeouts.probeMs
        c.readTimeout = timeouts.probeMs
        c.instanceFollowRedirects = false
        try { c.responseCode > 0 } finally { c.disconnect() }
    } catch (_: Exception) {
        false
    }

    private fun post(url: String, token: String, body: String): Pair<Int, String?> {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = "POST"
            c.connectTimeout = timeouts.connectMs
            c.readTimeout = timeouts.readMs
            c.instanceFollowRedirects = false // a login page is no answer
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("authorization", "Bearer $token")
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }
            c.disconnect()
            code to text
        } catch (_: Exception) {
            0 to null
        }
    }

    private fun textOf(body: String): String = try { JSONObject(body).getJSONObject("report").optString("text") } catch (_: Exception) { "" }

    private companion object {
        // A lookup that hangs keeps its thread. The next probe gets a new one.
        val dns = Executors.newCachedThreadPool { r -> Thread(r, "papercuts-dns").apply { isDaemon = true } }
    }
}
