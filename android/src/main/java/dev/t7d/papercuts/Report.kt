package dev.t7d.papercuts

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/** A text attachment: one comment of the issue. The app removes private content before. */
data class Attachment(val name: String, val text: String)

/** What the app knows right now, without private content. */
data class State(val context: Map<String, Any?> = emptyMap(), val attachments: List<Attachment> = emptyList())

/** Collects the state; may answer later (for example after JavaScript in a WebView). */
fun interface StateProvider {
    fun collect(done: (State) -> Unit)
}

/**
 * The state of one moment, waiting for the text of the person. Saved as a file, so a report captured in the car
 * can be finished on the phone later.
 */
data class Draft(
    val id: String = UUID.randomUUID().toString(),
    val time: Long = System.currentTimeMillis(),
    val where: String = "",
    val context: JSONObject = JSONObject(),
    val attachments: List<Attachment> = emptyList(),
    val shot: ByteArray? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("time", time).put("where", where).put("context", context)
        .put("attachments", JSONArray().apply { attachments.forEach { put(JSONObject().put("name", it.name).put("text", it.text)) } })
        .put("shot", shot?.let { Base64.getEncoder().encodeToString(it) } ?: JSONObject.NULL)

    override fun equals(other: Any?) = other is Draft && other.id == id
    override fun hashCode() = id.hashCode()

    companion object {
        private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun fromJson(o: JSONObject): Draft? = try {
            val id = o.getString("id")
            if (!ID.matches(id)) null else Draft(
                id = id,
                time = o.optLong("time"),
                where = o.optString("where"),
                context = o.optJSONObject("context") ?: JSONObject(),
                attachments = o.optJSONArray("attachments")?.let { a ->
                    (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { Attachment(it.optString("name"), it.optString("text")) } }
                } ?: emptyList(),
                shot = if (o.isNull("shot")) null else Base64.getDecoder().decode(o.getString("shot")),
            )
        } catch (_: Exception) {
            null
        }
    }
}

/** The body of POST /app-report, as the relay of papercuts expects it. */
object ReportPayload {
    const val MAX_TEXT = 3000

    fun build(draft: Draft, repo: String, text: String, kind: String = "other", withState: Boolean = true): JSONObject {
        val r = JSONObject()
            .put("id", draft.id)
            .put("kind", kind)
            .put("text", text.trim().take(MAX_TEXT))
            .put("repo", repo)
            .put("where", draft.where.take(120))
        if (withState) {
            r.put("context", draft.context)
            if (draft.attachments.isNotEmpty()) {
                r.put("attachments", JSONArray().apply { draft.attachments.take(3).forEach { put(JSONObject().put("name", it.name).put("text", it.text)) } })
            }
            draft.shot?.let { r.put("shot", "data:image/png;base64," + Base64.getEncoder().encodeToString(it)) }
        }
        return JSONObject().put("from", "human").put("report", r)
    }

    /** Context values JSON can hold; everything else becomes its string. */
    fun context(state: State, events: List<String>, base: Map<String, Any?>): JSONObject {
        val o = JSONObject()
        (base + state.context).forEach { (k, v) -> o.put(k, jsonValue(v)) }
        if (events.isNotEmpty()) o.put("events", JSONArray(events))
        return o
    }

    private fun jsonValue(v: Any?): Any = when (v) {
        null -> JSONObject.NULL
        is Boolean, is Int, is Long, is Double, is String -> v
        is Map<*, *> -> JSONObject().apply { v.forEach { (k, x) -> put(k.toString(), jsonValue(x)) } }
        is Collection<*> -> JSONArray().apply { v.forEach { put(jsonValue(it)) } }
        else -> v.toString()
    }
}

/** What the outbox does with a report after the relay answered [code] (0 = no answer). */
enum class SendOutcome { DONE, KEEP, DROP }

fun outcomeOf(code: Int, retryFlag: Boolean?): SendOutcome = when {
    code in 200..299 -> SendOutcome.DONE
    code == 0 || code == 429 || code >= 500 -> SendOutcome.KEEP
    // A redirect (a login page) or 404 (the route is not there yet): the setup is wrong, the report is not.
    code in 300..399 || code == 404 -> SendOutcome.KEEP
    // A wrong token can be fixed in the settings: keep the report until then.
    code == 401 -> SendOutcome.KEEP
    retryFlag == true -> SendOutcome.KEEP
    else -> SendOutcome.DROP
}
