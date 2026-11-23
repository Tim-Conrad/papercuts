package dev.t7d.papercuts

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

/**
 * Papercuts for Android apps: a person reports a problem on purpose, the app attaches its state.
 * The app never files a papercut by itself. Events stay on the device unless they go with a report.
 *
 * Call [init] once (Application.onCreate), [event] from the main thread.
 */
object Papercuts {
    /** All words of the sheet. The defaults follow the English words of the web widget. */
    data class Strings(
        val title: String = "Report a papercut",
        val hint: String = "What is wrong? One sentence is enough.",
        val attachState: String = "Attach the app state",
        val send: String = "Send",
        val cancel: String = "Cancel",
        /** After a send while the relay is out of reach: the report waits on the phone. */
        val queued: String = "Saved on the phone. It goes out when the relay is reachable.",
        val queuedToken: String = "Saved on the phone. Set the papercuts token, then it goes out.",
        val draftTitle: String = "Papercut: what happened?",
        val draftText: String = "The state is saved. Tap to add a sentence.",
        val channel: String = "Papercuts",
        val close: String = "Close",
        val sending: String = "Sending…",
        val thanks: String = "Thank you. Sent as ",
        val another: String = "Report another",
        val notSent: String = "Not sent: ",
        val writeFirst: String = "Write one sentence first.",
        val speak: String = "Tap to speak",
        val listening: String = "Listening… tap to stop",
        val typeInstead: String = "or type below",
        val mic: String = "Speak",
        val micStop: String = "Stop",
        val micAsk: String = "Allow the microphone, then tap again.",
        val micBlocked: String = "Microphone blocked. Allow it in the settings, or type instead.",
        val noSpeech: String = "I heard nothing. Tap and speak again, or type instead.",
        val micNetwork: String = "Speech input needs a network connection. Type instead.",
        val micFailed: String = "Speech input failed. Type instead.",
        val picture: String = "Screen picture",
        val markHint: String = "Tap to mark it",
        val pins: (Int) -> String = { n -> if (n == 1) "1 pin" else "$n pins" },
        val markScreen: String = "Mark screen",
        val removePic: String = "Remove picture",
        val pen: String = "Pen",
        val pin: String = "Pin",
        val undo: String = "Undo",
        val clear: String = "Clear",
        val done: String = "Done",
        val pinText: String = "What is at this pin?",
        val pinLabel: (Int) -> String = { n -> "Pin $n: what is here?" },
    )

    data class Config(
        /** owner/name of the repo for the issues. */
        val repo: String,
        /** For example https://papercuts.lab.example (the relay); the app posts to /app-report. */
        val relayUrl: () -> String,
        /** The app token from the relay's PAPERCUTS_APP_TOKENS_FILE; null = reports wait in the outbox. */
        val token: () -> String?,
        /** Default of the "attach the app state" box. Off for a published build. */
        val attachStateDefault: Boolean = true,
        /** Fields every report carries, for example the app and Android version. */
        val base: () -> Map<String, Any?> = { emptyMap() },
        val strings: Strings = Strings(),
        val notificationIcon: Int = android.R.drawable.stat_notify_error,
        /** The one color of the sheet, like data-accent of the web widget. */
        val accent: Int = 0xFFD13438.toInt(),
        /** The first language of speech input, for example "de-DE", until the person picks DE or EN; null = the phone. */
        val speechLang: String? = null,
    )

    private lateinit var app: Context
    private lateinit var config: Config
    private lateinit var log: EventLog
    private lateinit var outbox: Outbox
    private lateinit var drafts: File
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var started = false

    val ready get() = started

    fun init(context: Context, config: Config) {
        app = context.applicationContext
        this.config = config
        val root = File(app.filesDir, "papercuts")
        log = EventLog(File(root, "events.jsonl"))
        outbox = Outbox(File(root, "outbox"))
        drafts = File(root, "drafts")
        started = true
        try {
            val cm = app.getSystemService(ConnectivityManager::class.java)
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = flush()
            })
        } catch (_: Exception) {
            // without ACCESS_NETWORK_STATE: flush only on start and on send
        }
        flush()
    }

    /** Records one event on the device. Values are cut to 120 characters, at most 8 fields. No private content. */
    fun event(name: String, vararg fields: Pair<String, Any?>) {
        if (!started) return
        log.add(name, fields.toMap())
    }

    fun recentEvents(): List<String> = if (started) log.recent().map { EventLog.format(it) } else emptyList()

    fun clearEvents() {
        if (started) log.clear()
    }

    /** Number of waiting reports and the last send error, for a settings summary. */
    fun outboxStatus(): Pair<Int, String?> = if (started) outbox.pending().size to outbox.lastError else 0 to null

    fun flush() {
        if (!started) return
        val url = config.relayUrl()
        val token = config.token()
        io.execute { outbox.flush(url, token) }
    }

    /**
     * Captures the moment: the state of the app, the recent events and, with an [activity], a screenshot in which
     * the [hide] views are painted over (for example a WebView with a conversation). Answers on the main thread.
     */
    fun capture(activity: Activity?, where: String, state: StateProvider, hide: List<View> = emptyList(), done: (Draft) -> Unit) {
        val events = recentEvents()
        state.collect { s ->
            val context = ReportPayload.context(s, events, config.base())
            val finish: (ByteArray?) -> Unit = { shot -> main.post { done(Draft(where = where, context = context, attachments = s.attachments, shot = shot)) } }
            if (activity == null) finish(null) else screenshot(activity, hide, finish)
        }
    }

    /** Keeps a draft for later (the car), and shows a notification that opens [open] to finish it. */
    fun keepDraft(draft: Draft, open: PendingIntent) {
        drafts.mkdirs()
        File(drafts, "${draft.id}.json").writeText(draft.toJson().toString())
        val nm = app.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("papercuts", config.strings.channel, NotificationManager.IMPORTANCE_DEFAULT))
        if (Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        nm.notify(draft.id.hashCode(), NotificationCompat.Builder(app, "papercuts")
            .setSmallIcon(config.notificationIcon)
            .setContentTitle(config.strings.draftTitle)
            .setContentText(config.strings.draftText)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build())
    }

    fun draft(id: String?): Draft? {
        if (id == null || !Regex("^[A-Za-z0-9_-]{1,64}$").matches(id)) return null
        return try { Draft.fromJson(JSONObject(File(drafts, "$id.json").readText())) } catch (_: Exception) { null }
    }

    private fun dropDraft(d: Draft) {
        File(drafts, "${d.id}.json").delete()
        app.getSystemService(NotificationManager::class.java).cancel(d.id.hashCode())
    }

    /** Puts the report into the outbox and sends it as soon as the relay answers. */
    fun send(draft: Draft, text: String, withState: Boolean, kind: String = "other") =
        send(draft, text, withState, kind, if (withState) draft.shot else null, emptyList(), null)

    /**
     * Puts the report into the outbox and tries to send it now. [done] hears on the main thread what became of it:
     * filed (with the issue), refused (with the error) or waiting (KEEP; [Sent.error] says why).
     */
    fun send(draft: Draft, text: String, withState: Boolean, kind: String, shot: ByteArray?, pins: List<String>, done: ((Sent) -> Unit)?) {
        val payload = ReportPayload.build(draft, config.repo, text, kind, withState, shot, pins)
        event("papercut_sent", "state" to withState, "shot" to (shot != null))
        val url = config.relayUrl()
        val token = config.token()
        io.execute {
            outbox.add(draft.id, payload)
            main.post { dropDraft(draft) }
            val sent = outbox.send(url, token)[draft.id] ?: Sent(SendOutcome.KEEP, 0, error = outbox.lastError.orEmpty())
            if (done != null) main.post { done(sent) }
        }
    }

    /**
     * The report sheet. Without a [draft] it captures one first (screenshot before the sheet covers the screen).
     * "Report another" captures the screen again.
     */
    fun showDialog(activity: Activity, where: String, state: StateProvider, hide: List<View> = emptyList(), draft: Draft? = null) {
        if (draft != null) ReportSheet.show(activity, draft, config, again = { showDialog(activity, where, state, hide) })
        else capture(activity, where, state, hide) { d -> if (!activity.isFinishing) showDialog(activity, where, state, hide, d) }
    }

    private fun screenshot(activity: Activity, hide: List<View>, done: (ByteArray?) -> Unit) {
        val window = activity.window
        val root = window.decorView
        if (root.width == 0 || root.height == 0) return done(null)
        val bmp = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        val rects = hide.filter { it.isShown }.map { v ->
            val loc = IntArray(2)
            v.getLocationInWindow(loc)
            Rect(loc[0], loc[1], loc[0] + v.width, loc[1] + v.height)
        }
        try {
            PixelCopy.request(window, bmp, { result ->
                if (result != PixelCopy.SUCCESS) return@request done(null)
                val c = Canvas(bmp)
                val fill = Paint().apply { color = Color.rgb(120, 120, 120) }
                rects.forEach { c.drawRect(it, fill) }
                io.execute {
                    val out = ByteArrayOutputStream()
                    val scaled = if (bmp.width > 1080) Bitmap.createScaledBitmap(bmp, 1080, bmp.height * 1080 / bmp.width, true) else bmp
                    scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
                    done(out.toByteArray())
                }
            }, main)
        } catch (_: Exception) {
            done(null)
        }
    }
}
