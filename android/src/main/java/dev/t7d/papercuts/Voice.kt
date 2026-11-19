package dev.t7d.papercuts

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Speech input like the web widget: the words show live, a pause to think does not end it. The input starts again
 * until the person taps stop or stays silent for [SILENCE_MS].
 */
internal class Voice(
    private val activity: Activity,
    private val strings: Papercuts.Strings,
    private val lang: String?,
    /** The text before the speech started. */
    private val current: () -> String,
    private val show: (String) -> Unit,
    private val listening: (Boolean) -> Unit,
    private val problem: (String) -> Unit,
) {
    private var rec: SpeechRecognizer? = null
    private var stopped = true
    private var heard = false
    private var lastWords = 0L
    private var base = ""
    private var done = ""

    val active get() = !stopped

    fun toggle() = if (active) stop() else start()

    fun start() {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST)
            problem(strings.micAsk)
            return
        }
        base = current().trim()
        done = ""
        heard = false
        stopped = false
        lastWords = SystemClock.elapsedRealtime()
        listening(true)
        listen()
    }

    fun stop() {
        if (stopped) return
        stopped = true
        rec?.stopListening()
        listening(false)
    }

    fun destroy() {
        stopped = true
        rec?.destroy()
        rec = null
    }

    private fun listen() {
        val r = rec ?: SpeechRecognizer.createSpeechRecognizer(activity).also { rec = it; it.setRecognitionListener(listener) }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        if (!lang.isNullOrBlank()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
        try {
            r.startListening(intent)
        } catch (_: Exception) {
            fail(strings.micFailed)
        }
    }

    private fun words(b: Bundle?) = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

    private fun render(live: String) {
        show(listOf(base, done, live).filter { it.isNotEmpty() }.joinToString(" ").take(ReportPayload.MAX_TEXT))
    }

    /** One round ended: listen again unless the person stopped or was silent too long. */
    private fun ended() {
        if (!stopped && SystemClock.elapsedRealtime() - lastWords < SILENCE_MS) return listen()
        val silent = !stopped && !heard
        stopped = true
        listening(false)
        if (silent) problem(strings.noSpeech)
    }

    private fun fail(message: String) {
        stopped = true
        listening(false)
        problem(message)
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResults(b: Bundle?) {
            val live = words(b)
            if (live.isEmpty()) return
            heard = true
            lastWords = SystemClock.elapsedRealtime()
            render(live)
        }

        override fun onResults(b: Bundle?) {
            val said = words(b)
            if (said.isNotEmpty()) {
                heard = true
                lastWords = SystemClock.elapsedRealtime()
                done = "$done $said".trim()
            }
            render("")
            ended()
        }

        override fun onError(error: Int) {
            when (error) {
                // A pause: ended() decides if the input goes on.
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> ended()
                SpeechRecognizer.ERROR_CLIENT -> if (!stopped) ended()
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS, SpeechRecognizer.ERROR_AUDIO -> fail(strings.micBlocked)
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> fail(strings.micNetwork)
                else -> fail(strings.micFailed)
            }
        }

        override fun onReadyForSpeech(p: Bundle?) {}
        override fun onBeginningOfSpeech() { lastWords = SystemClock.elapsedRealtime() }
        override fun onRmsChanged(v: Float) {}
        override fun onBufferReceived(b: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(t: Int, b: Bundle?) {}
    }

    companion object {
        const val SILENCE_MS = 10_000L
        private const val REQUEST = 7401

        /** Speech needs a recognizer on the device and RECORD_AUDIO in the app's manifest. */
        fun available(activity: Activity): Boolean = try {
            val asked = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions
            SpeechRecognizer.isRecognitionAvailable(activity) && asked?.contains(Manifest.permission.RECORD_AUDIO) == true
        } catch (_: Exception) {
            false
        }
    }
}
