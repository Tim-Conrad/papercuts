package dev.t7d.papercuts

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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

/** Reports that are sent but not yet filed. One file each; the relay is often out of reach (home network only). */
class Outbox(private val dir: File) {
    @Volatile var lastError: String? = null
        private set

    fun add(id: String, payload: JSONObject) {
        dir.mkdirs()
        val tmp = File(dir, "$id.tmp")
        tmp.writeText(payload.toString())
        tmp.renameTo(File(dir, "$id.json"))
    }

    fun pending(): List<File> = (dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()).sortedBy { it.lastModified() }

    /** Sends every waiting report; blocking, call it off the main thread. Returns how many were filed. */
    fun flush(relayUrl: String, token: String?): Int = send(relayUrl, token).values.count { it.outcome == SendOutcome.DONE }

    /**
     * Sends every waiting report and answers what became of each, by id. A report that was not tried (the relay
     * stopped answering before it) is missing from the answer: it still waits.
     */
    fun send(relayUrl: String, token: String?): Map<String, Sent> {
        if (token.isNullOrBlank() || relayUrl.isBlank()) {
            lastError = if (token.isNullOrBlank()) "no token" else "no relay"
            return emptyMap()
        }
        val out = linkedMapOf<String, Sent>()
        for (f in pending()) {
            val (code, body) = post(relayUrl.trimEnd('/') + "/app-report", token, f.readText())
            val sent = Sent.of(code, body)
            out[f.name.removeSuffix(".json")] = sent
            when (sent.outcome) {
                SendOutcome.DONE -> { f.delete(); lastError = null }
                SendOutcome.DROP -> { f.delete(); lastError = "refused ($code): ${sent.error}" }
                SendOutcome.KEEP -> { lastError = if (code == 0) "relay not reachable" else "relay $code: ${sent.error}"; return out }
            }
        }
        return out
    }

    private fun post(url: String, token: String, body: String): Pair<Int, String?> {
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = "POST"
            c.connectTimeout = 10_000
            c.readTimeout = 30_000
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
}
