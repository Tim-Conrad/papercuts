package dev.t7d.papercuts

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
    fun flush(relayUrl: String, token: String?): Int {
        if (token.isNullOrBlank() || relayUrl.isBlank()) {
            lastError = if (token.isNullOrBlank()) "no token" else "no relay"
            return 0
        }
        var filed = 0
        for (f in pending()) {
            val (code, body) = post(relayUrl.trimEnd('/') + "/app-report", token, f.readText())
            val retry = try { if (body.isNullOrBlank()) null else JSONObject(body).optBoolean("retry", true) } catch (_: Exception) { null }
            when (outcomeOf(code, retry)) {
                SendOutcome.DONE -> { f.delete(); filed++; lastError = null }
                SendOutcome.DROP -> { f.delete(); lastError = "refused ($code): ${errorOf(body)}" }
                SendOutcome.KEEP -> { lastError = if (code == 0) "relay not reachable" else "relay $code: ${errorOf(body)}"; return filed }
            }
        }
        return filed
    }

    private fun errorOf(body: String?) = try { JSONObject(body ?: "").optString("error").take(120) } catch (_: Exception) { "" }

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
