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
    data class Strings(
        val title: String = "Report a papercut",
        val hint: String = "What is wrong? One sentence is enough.",
        val attachState: String = "Attach the app state",
        val send: String = "Send",
        val cancel: String = "Cancel",
        val queued: String = "Saved. It is sent when the relay is reachable.",
        val draftTitle: String = "Papercut: what happened?",
        val draftText: String = "The state is saved. Tap to add a sentence.",
        val channel: String = "Papercuts",
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
            val finish = { shot: ByteArray? -> main.post { done(Draft(where = where, context = context, attachments = s.attachments, shot = shot)) } }
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
    fun send(draft: Draft, text: String, withState: Boolean, kind: String = "other") {
        outbox.add(draft.id, ReportPayload.build(draft, config.repo, text, kind, withState))
        dropDraft(draft)
        event("papercut_sent", "state" to withState)
        flush()
    }

    /** The report dialog. Without a [draft] it captures one first (screenshot before the dialog covers the screen). */
    fun showDialog(activity: Activity, where: String, state: StateProvider, hide: List<View> = emptyList(), draft: Draft? = null) {
        if (draft != null) ReportDialog.show(activity, draft, config) { text, withState -> send(draft, text, withState); toast(activity) }
        else capture(activity, where, state, hide) { d -> if (!activity.isFinishing) showDialog(activity, where, state, hide, d) }
    }

    private fun toast(activity: Activity) {
        android.widget.Toast.makeText(activity, config.strings.queued, android.widget.Toast.LENGTH_LONG).show()
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
