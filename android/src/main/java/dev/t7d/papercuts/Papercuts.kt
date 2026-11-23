package dev.t7d.papercuts

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Papercuts for Android apps: a person reports a problem on purpose, the app attaches its state.
 * The app never files a papercut by itself. Events stay on the device unless they go with a report.
 *
 * Call [init] once (Application.onCreate), [event] from the main thread.
 */
object Papercuts {
    /** The name of the attachment with the whole event log. */
    const val EVENTS_LOG = "events.log"
    /** The relay takes at most this many characters per attachment. */
    private const val MAX_ATTACHMENT = 60_000
    /** Lines of the log in the context of a report (readable in the issue itself). */
    private const val TAIL = 40

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
        /** Right after Send: the report is safe on the phone, the send runs in the background. */
        val saved: String = "Saved. It is sent in the background.",
        /** After [saved] or [queued] when more than one report waits. */
        val waiting: (Int) -> String = { n -> "$n reports wait." },
        /** The silent notification when a report is filed after the sheet closed. */
        val filed: (Int) -> String = { n -> "Papercut filed as #$n" },
        /** The notification when the relay refused a report after the sheet closed; the error follows. */
        val refused: String = "Papercut not taken: ",
        val sentChannel: String = "Papercuts sent",
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
        /** The job ids of the background send ([jobId] and [jobId] + 1). Change them only if the app uses them. */
        val jobId: Int = 0x50430000,
        /** Event names that come in bursts (for example a list the car asks for): a run of them is one line with a count. */
        val quietEvents: Set<String> = emptySet(),
        /** Event names that open a block in events.log (for example `call_start`): a reader sees each call. */
        val sectionEvents: Set<String> = emptySet(),
    )

    private lateinit var app: Context
    private lateinit var config: Config
    private lateinit var log: EventLog
    private lateinit var outbox: Outbox
    private lateinit var delivery: Delivery
    private lateinit var drafts: File
    /** The open sheets: they show what became of their report. Every other answer becomes a notification. */
    private val watchers = ConcurrentHashMap<String, (Sent) -> Unit>()
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
        delivery = Delivery(outbox, config.relayUrl, config.token, delivered = { d -> main.post { delivered(d) } }, plan = ::plan)
        drafts = File(root, "drafts")
        started = true
        try {
            val cm = app.getSystemService(ConnectivityManager::class.java)
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = flush()
            })
        } catch (_: Exception) {
            // Without ACCESS_NETWORK_STATE: send on start, on Send and from the background job.
        }
        flush()
    }

    /** Records one event on the device. Values are cut to 120 characters, at most 8 fields. No private content. */
    fun event(name: String, vararg fields: Pair<String, Any?>) {
        if (!started) return
        log.add(name, fields.toMap())
    }

    /** The last [TAIL] lines of the compacted log: the `events` of the context. events.log has all of them. */
    fun recentEvents(): List<String> = if (started) tail(lines(log.all())) else emptyList()

    private fun lines(events: List<EventLog.Event>) = EventLog.compact(events, config.quietEvents, config.sectionEvents)

    private fun tail(lines: List<String>) = lines.filter { it.isNotEmpty() && !it.startsWith("-- ") }.takeLast(TAIL)

    /** The whole log of the device (24 h, every call), compacted, newest kept if it is too long. */
    private fun eventsAttachment(events: List<EventLog.Event>, lines: List<String>): Attachment? =
        if (events.isEmpty()) null else Attachment(EVENTS_LOG, EventLog.report(lines, events.size, MAX_ATTACHMENT))

    fun clearEvents() {
        if (started) log.clear()
    }

    /** Number of waiting reports and the last send error, for a settings summary. */
    fun outboxStatus(): Pair<Int, String?> = status().let { it.waiting to it.lastError }

    /** Waiting reports, the last send error and the time of the last try. Reads files: not on the main thread in a loop. */
    fun status(): OutboxStatus = if (started) outbox.status() else OutboxStatus(0, null, null)

    /** Sends the waiting reports in the background, for example after the token was set. Never blocks. */
    fun flush() {
        if (started) delivery.request()
    }

    internal fun deliverNow(finished: () -> Unit) = delivery.request(finished = finished)

    /** Plans the background job for the next try, or cancels it when nothing waits. */
    private fun plan(next: Delivery.Next?) {
        val js = app.getSystemService(JobScheduler::class.java) ?: return
        if (next == null) {
            js.cancel(config.jobId)
            js.cancel(config.jobId + 1)
            return
        }
        val persist = app.checkSelfPermission(Manifest.permission.RECEIVE_BOOT_COMPLETED) == PackageManager.PERMISSION_GRANTED
        fun job(id: Int) = JobInfo.Builder(id, ComponentName(app, OutboxJob::class.java)).setPersisted(persist)
        try {
            js.schedule(job(config.jobId).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(next.delayMs).build())
            // On mobile data the relay is out of reach. A network without a meter (the home WLAN) tries at once,
            // also while the app is closed. Not on a WLAN already: there that job would start again and again.
            val metered = try { app.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered } catch (_: Exception) { false }
            if (metered) js.schedule(job(config.jobId + 1).setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED).build())
            else js.cancel(config.jobId + 1)
        } catch (_: Exception) {
            // OutboxJob is not in the manifest of the app: send only while it runs.
        }
    }

    /** An open sheet hears the answer. Without one, a filed or refused report becomes a silent notification. */
    private fun delivered(d: Outbox.Delivered) {
        watchers[d.id]?.let { return it(d.sent) }
        if (d.sent.outcome == SendOutcome.KEEP) return
        val nm = app.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("papercuts_sent", config.strings.sentChannel, NotificationManager.IMPORTANCE_LOW))
        if (Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) return
        val filed = d.sent.outcome == SendOutcome.DONE
        val title = if (filed) config.strings.filed(d.sent.issue ?: 0) else config.strings.refused + d.sent.error
        val text = d.text.take(200) + if (filed || d.sent.help.isEmpty()) "" else " (${d.sent.help})"
        val b = NotificationCompat.Builder(app, "papercuts_sent")
            .setSmallIcon(config.notificationIcon)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
        d.sent.url?.let { url ->
            val open = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            b.setContentIntent(PendingIntent.getActivity(app, d.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        nm.notify("papercuts-sent", d.id.hashCode(), b.build())
    }

    /**
     * Captures the moment: the state of the app, the recent events and, with an [activity], a screenshot in which
     * the [hide] views are painted over (for example a WebView with a conversation). Answers on the main thread.
     */
    fun capture(activity: Activity?, where: String, state: StateProvider, hide: List<View> = emptyList(), done: (Draft) -> Unit) {
        val all = if (started) log.all() else emptyList()
        val lines = lines(all)
        val log = eventsAttachment(all, lines)
        state.collect { s ->
            val context = ReportPayload.context(s, tail(lines), config.base())
            // The relay takes 3 attachments: events.log always goes, the app keeps 2.
            val attachments = s.attachments.filter { it.name != EVENTS_LOG }.take(if (log == null) 3 else 2) + listOfNotNull(log)
            val finish: (ByteArray?) -> Unit = { shot -> main.post { done(Draft(where = where, context = context, attachments = attachments, shot = shot)) } }
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

    /** Puts the report into the outbox and sends it in the background as soon as the relay answers. */
    fun send(draft: Draft, text: String, withState: Boolean, kind: String = "other") =
        send(draft, text, withState, kind, if (withState) draft.shot else null, emptyList(), null, null)

    /**
     * Puts the report into the outbox and sends it in the background; nothing here waits for the network.
     * [saved] runs on the main thread as soon as the report is safe on the phone (a few milliseconds).
     * Until [unwatch], [done] hears on the main thread what became of it: filed (with the issue), refused (with the
     * error) or still waiting (KEEP, [Sent.error] says why). An answer after [unwatch] becomes a notification.
     */
    fun send(
        draft: Draft,
        text: String,
        withState: Boolean,
        kind: String,
        shot: ByteArray?,
        pins: List<String>,
        saved: (() -> Unit)?,
        done: ((Sent) -> Unit)?,
    ) {
        event("papercut_sent", "state" to withState, "shot" to (shot != null))
        if (done != null) watchers[draft.id] = done
        io.execute {
            outbox.add(draft.id, ReportPayload.build(draft, config.repo, text, kind, withState, shot, pins))
            main.post {
                dropDraft(draft)
                saved?.invoke()
            }
            // A fallback while this process lives: if it dies during the first try, the job sends the report.
            plan(Delivery.Next(60_000))
            delivery.request(first = draft.id)
        }
    }

    /** The sheet of [id] closed: a later answer becomes a notification. */
    fun unwatch(id: String) {
        watchers.remove(id)
    }

    /** True when a send now has a token and a relay; without them the report waits on the phone. */
    fun canSend(): Boolean = started && !config.token().isNullOrBlank() && config.relayUrl().isNotBlank()

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
