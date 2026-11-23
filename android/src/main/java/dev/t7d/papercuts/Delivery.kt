package dev.t7d.papercuts

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Sends the outbox in the background, never on the path of the UI. One worker: two runs never post the same file,
 * and a request while a run waits joins that run. After each run it says when to try again ([plan]).
 */
internal class Delivery(
    private val outbox: Outbox,
    private val relayUrl: () -> String,
    private val token: () -> String?,
    /** What became of each report the relay answered. Called on the worker thread. */
    private val delivered: (Outbox.Delivered) -> Unit,
    /** The next try: null = nothing waits (or the token is missing: the app calls flush when it is set). */
    private val plan: (Next?) -> Unit,
) {
    /** The next background try, after [delayMs]. Papercuts adds a try on the next network without a meter. */
    data class Next(val delayMs: Long)

    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "papercuts-send").apply { isDaemon = true } }
    private val queued = AtomicBoolean(false)
    private val finishers = ConcurrentLinkedQueue<() -> Unit>()
    @Volatile private var first: String? = null

    /** Sends what waits, [first] before the rest. [finished] runs after the run, before the next try is planned. */
    fun request(first: String? = null, finished: (() -> Unit)? = null) {
        if (first != null) this.first = first
        finished?.let(finishers::add)
        if (queued.compareAndSet(false, true)) worker.execute {
            queued.set(false)
            run()
        }
    }

    private fun run() {
        var next: Next? = null
        try {
            val url = relayUrl()
            val tok = token()
            val f = first
            first = null
            outbox.send(url, tok, f).forEach { d -> runCatching { delivered(d) } }
            val waiting = outbox.pending().isNotEmpty()
            next = if (waiting && !tok.isNullOrBlank() && url.isNotBlank()) Next(backoffMs(outbox.attempts)) else null
        } catch (_: Throwable) {
            next = Next(backoffMs(outbox.attempts))
        } finally {
            // A job ends before the next one is planned: planning the same job id would stop the running one.
            while (true) (finishers.poll() ?: break).let { runCatching { it() } }
            runCatching { plan(next) }
        }
    }

    companion object {
        const val FIRST_MS = 30_000L
        const val MAX_MS = 15 * 60_000L

        /** 30 s after the first failed try, then doubled, at most 15 minutes. */
        fun backoffMs(attempts: Int): Long = if (attempts <= 1) FIRST_MS else minOf(MAX_MS, FIRST_MS shl minOf(attempts - 1, 10))
    }
}

/**
 * Sends the outbox while the app is closed. The app declares it in its manifest (see the README). Papercuts plans
 * it with a network constraint after each failed try, and once more on a network without a meter.
 */
class OutboxJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        // Application.onCreate runs Papercuts.init before a job starts. Without it there is nothing to send.
        if (!Papercuts.ready) return false
        Papercuts.deliverNow { jobFinished(params, false) }
        return true
    }

    // The worker goes on. The next try is planned at the end of its run.
    override fun onStopJob(params: JobParameters) = false
}
