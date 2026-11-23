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
import java.util.Locale

/**
 * Speech input like the web widget: the words show live, a pause to think does not end it. The input starts again
 * until the person taps stop or stays silent for [SILENCE_MS].
 */
internal class Voice(
    private val activity: Activity,
    private val strings: Papercuts.Strings,
    lang: String,
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
    private var relang = false

    /** The language tag of the input, for example "de-DE". */
    var lang = lang
        private set

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

    /** A new language: the words so far stay, a running input goes on in the new language. */
    fun relang(tag: String) {
        lang = tag
        if (stopped) return
        relang = true
        rec?.stopListening()
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
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
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
        if (relang && !stopped) {
            relang = false
            lastWords = SystemClock.elapsedRealtime()
        }
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

/**
 * The language of speech input: German or English, picked next to the speak button and kept on the device.
 * Until the person picks one: the app's [Papercuts.Config.speechLang], else the language of the phone.
 */
internal object SpeechLang {
    const val PREFS = "papercuts"
    const val KEY = "speech_lang"
    val CHOICES = listOf("de" to "Deutsch", "en" to "English")

    private fun base(tag: String) = tag.lowercase(Locale.ROOT).substringBefore('-').substringBefore('_')

    fun initial(stored: String?, configured: String?, system: Locale): String {
        if (stored == "de" || stored == "en") return stored
        val from = configured?.takeIf { it.isNotBlank() } ?: system.toLanguageTag()
        return if (base(from) == "de") "de" else "en"
    }

    /** The configured tag when it is the chosen language (for example "de-AT"), else a plain one. */
    fun tag(choice: String, configured: String?): String =
        configured?.takeIf { it.isNotBlank() && base(it) == choice } ?: if (choice == "de") "de-DE" else "en-US"
}
