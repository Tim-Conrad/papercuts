package dev.t7d.papercuts

import android.animation.ValueAnimator
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

/**
 * The report sheet: the phone layout of the web widget. A bottom sheet with a large speak button, one text field,
 * the screen picture (tap it to draw and pin), the state switch and Send. After Send it says what happened:
 * the issue number, or that the report waits on the phone, or why the relay refused it.
 */
internal object ReportSheet {
    private const val TEXT_MAX = ReportPayload.MAX_TEXT

    fun show(activity: Activity, draft: Draft, config: Papercuts.Config, again: () -> Unit) {
        val s = config.strings
        val k = Tokens(activity, config.accent)
        val main = Handler(Looper.getMainLooper())
        val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)

        // The picture as it goes out: the screenshot, or the marked one. null = removed.
        var shot: ByteArray? = draft.shot
        var pins: List<String> = emptyList()
        var finished = false

        // ---- head ----
        val grab = View(activity).apply { background = k.round(k.line, 2) }
        val title = k.text(activity, s.title, 15f, k.ink, 650).apply {
            setCompoundDrawablesRelative(IconDrawable(Icon.LOGO, k.accent, k.dp(18)), null, null, null)
            compoundDrawablePadding = k.dp(8)
            layoutParams = lp(0, WRAP, 1f)
        }
        lateinit var close: () -> Unit
        val head = k.row(activity, 6).apply {
            setPadding(k.dp(16), k.dp(6), k.dp(10), k.dp(6))
            addView(title)
            addView(k.iconButton(activity, Icon.X, s.close) { close() })
        }

        // ---- the sentence ----
        val text = EditText(activity).apply {
            hint = s.hint
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            filters = arrayOf(InputFilter.LengthFilter(TEXT_MAX))
            gravity = Gravity.TOP or Gravity.START
            background = null
            setTextColor(k.ink)
            setHintTextColor(ColorUtils.setAlphaComponent(k.muted, 217))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setLineSpacing(0f, 1.35f)
            minHeight = k.dp(88)
            maxHeight = k.dp(220)
            isVerticalScrollBarEnabled = true
            setPadding(k.dp(14), k.dp(12), k.dp(14), k.dp(2))
            contentDescription = s.title
        }
        val counter = k.text(activity, "", 12f, k.muted).apply { visibility = View.GONE }
        val mic = k.iconButton(activity, Icon.MIC, s.mic) {}
        val fieldBar = k.row(activity, 2).apply {
            setPadding(k.dp(6), 0, k.dp(12), k.dp(6))
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
            addView(mic)
            addView(View(activity), lp(0, k.dp(1), 1f))
            addView(counter)
        }
        val field = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = k.round(k.bg, 14, k.line)
            addView(text, lp(MATCH, WRAP))
            addView(fieldBar, lp(MATCH, WRAP))
        }
        text.setOnFocusChangeListener { _, has -> field.background = k.round(k.bg, 14, if (has) k.focus else k.line, if (has) 1.5f else 1) }

        // ---- voice first: a large round button leads the sheet ----
        val speakIcon = IconDrawable(Icon.MIC, k.onAccent, k.dp(32))
        val ring = View(activity).apply { background = k.round(ColorUtils.setAlphaComponent(k.accent, 115), 999); alpha = 0f }
        val speak = ImageView(activity).apply {
            setImageDrawable(speakIcon)
            scaleType = ImageView.ScaleType.CENTER
            background = k.pressable(k.round(k.accent, 999))
            elevation = k.dpf(6)
            outlineAmbientShadowColor = k.accent
            outlineSpotShadowColor = k.accent
            contentDescription = s.speak
        }
        val speakBox = FrameLayout(activity).apply {
            clipChildren = false
            addView(ring, FrameLayout.LayoutParams(k.dp(76), k.dp(76), Gravity.CENTER))
            addView(speak, FrameLayout.LayoutParams(k.dp(76), k.dp(76), Gravity.CENTER))
        }
        // DE or EN beside the speak button, like the web widget. One tap; the phone keeps the choice.
        val prefs = activity.getSharedPreferences(SpeechLang.PREFS, Context.MODE_PRIVATE)
        var lang = SpeechLang.initial(prefs.getString(SpeechLang.KEY, null), config.speechLang, Locale.getDefault())
        val langButtons = SpeechLang.CHOICES.map { (l, name) ->
            l to k.text(activity, l.uppercase(Locale.ROOT), 13f, k.muted, 650).apply {
                gravity = Gravity.CENTER
                minWidth = k.dp(44)
                setPadding(k.dp(8), 0, k.dp(8), 0)
                letterSpacing = 0.02f
                contentDescription = name
                isClickable = true
            }
        }
        fun showLang() = langButtons.forEach { (l, b) ->
            val on = l == lang
            b.isSelected = on
            b.setTextColor(if (on) k.bg else k.muted)
            b.background = k.pressable(k.round(if (on) k.ink else Color.TRANSPARENT, 999))
        }
        val langs = k.row(activity, 2).apply {
            setPadding(k.dp(2), k.dp(2), k.dp(2), k.dp(2))
            background = k.round(k.bg, 999, k.line)
            langButtons.forEach { (_, b) -> addView(b, lp(WRAP, k.dp(40))) }
        }
        showLang()
        val speakRow = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            addView(View(activity), lp(0, k.dp(1), 1f))
            addView(speakBox, LinearLayout.LayoutParams(k.dp(120), k.dp(96)))
            addView(FrameLayout(activity).apply {
                addView(langs, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.START or Gravity.CENTER_VERTICAL))
            }, lp(0, WRAP, 1f))
        }
        val speakLabel = k.text(activity, s.speak, 13f, k.ink, 600).apply { gravity = Gravity.CENTER }
        val speakWrap = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            clipChildren = false
            setPadding(0, k.dp(6), 0, k.dp(2))
            addView(speakRow, lp(MATCH, WRAP))
            addView(speakLabel)
            addView(k.text(activity, s.typeInstead, 12f, k.muted).apply { gravity = Gravity.CENTER; setPadding(0, k.dp(4), 0, 0) })
        }
        val pulse = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1400
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener {
                val f = it.animatedValue as Float
                ring.scaleX = 1f + 0.58f * f
                ring.scaleY = 1f + 0.58f * f
                ring.alpha = 1f - f
            }
        }

        // ---- the picture ----
        val preview = ImageView(activity).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(k.surface)
            clipRound(k.dpf(9))
        }
        val shotMeta = k.text(activity, s.markHint, 13f, k.muted)
        lateinit var showShot: () -> Unit
        val shotRow = k.row(activity, 12).apply {
            setPadding(k.dp(8), k.dp(8), k.dp(4), k.dp(8))
            background = k.pressable(k.round(k.bg, 14, k.line))
            addView(preview, lp(k.dp(84), k.dp(60)))
            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                addView(k.text(activity, s.picture, 13f, k.ink, 600))
                addView(shotMeta.apply { setPadding(0, k.dp(3), 0, 0) })
            }, lp(0, WRAP, 1f))
            addView(k.iconButton(activity, Icon.PEN, s.markScreen) {})
            addView(k.iconButton(activity, Icon.X, s.removePic) { shot = null; pins = emptyList(); showShot() })
        }
        val markPill = k.pill(activity, Icon.SCREEN, s.markScreen) {}
        val markRow = LinearLayout(activity).apply { addView(markPill, lp(WRAP, WRAP)) }
        fun openMarkup() {
            val source = draft.shot ?: return
            Markup.show(activity, k, s, source) { m -> shot = m.png; pins = m.pins; showShot() }
        }
        shotRow.setOnClickListener { openMarkup() }
        shotRow.getChildAt(2).setOnClickListener { openMarkup() }
        markPill.setOnClickListener { openMarkup() }
        showShot = {
            val bytes = shot
            shotRow.visibility = if (bytes != null) View.VISIBLE else View.GONE
            markRow.visibility = if (bytes == null && draft.shot != null) View.VISIBLE else View.GONE
            if (bytes != null) {
                preview.setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                shotMeta.text = if (pins.isNotEmpty()) s.pins(pins.size) else s.markHint
            }
        }

        // ---- the state switch ----
        val stateSwitch = Switch(activity).apply {
            isChecked = config.attachStateDefault
            val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
            thumbTintList = ColorStateList(states, intArrayOf(k.accent, if (k.dark) k.muted else Color.WHITE))
            trackTintList = ColorStateList(states, intArrayOf(ColorUtils.setAlphaComponent(k.accent, 110), k.hover))
        }
        val stateRow = k.row(activity, 12).apply {
            setPadding(k.dp(12), k.dp(6), k.dp(8), k.dp(6))
            background = k.round(k.surface, 14)
            minimumHeight = k.dp(48)
            addView(k.text(activity, s.attachState, 13f, k.muted), lp(0, WRAP, 1f))
            addView(stateSwitch)
            setOnClickListener { stateSwitch.toggle() }
        }

        val form = k.column(activity, 12).apply {
            setPadding(k.dp(16), k.dp(2), k.dp(16), k.dp(14))
            clipChildren = false
            clipToPadding = false
        }
        val voiceOn = Voice.available(activity)
        if (voiceOn) form.addView(speakWrap, lp(MATCH, WRAP))
        form.addView(field, lp(MATCH, WRAP))
        form.addView(shotRow, lp(MATCH, WRAP))
        form.addView(markRow, lp(MATCH, WRAP))
        form.addView(stateRow, lp(MATCH, WRAP))
        // A large speak button on top already: the small one in the field is not needed.
        mic.visibility = View.GONE
        if (!voiceOn) fieldBar.getChildAt(0).visibility = View.GONE
        val scroll = ScrollView(activity).apply {
            isFillViewport = false
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            clipChildren = false
            addView(form)
        }

        // ---- foot ----
        val statusIcon = ImageView(activity)
        val statusText = k.text(activity, "", 13f, k.ink).apply { movementMethod = LinkMovementMethod.getInstance(); setLineSpacing(0f, 1.4f) }
        val status = k.row(activity, 9).apply {
            gravity = Gravity.TOP
            setPadding(k.dp(12), k.dp(10), k.dp(12), k.dp(10))
            visibility = View.GONE
            addView(statusIcon, lp(k.dp(17), k.dp(17)))
            addView(statusText, lp(0, WRAP, 1f))
        }
        fun setStatus(kind: String?, msg: CharSequence = "") {
            if (kind == null) { status.visibility = View.GONE; return }
            val (icon, color) = when (kind) {
                "ok" -> Icon.CHECK to k.ok
                "warn" -> Icon.CLOCK to k.warn
                "err" -> Icon.ALERT to k.err
                else -> Icon.CLOCK to k.muted
            }
            status.background = k.round(if (kind == "info") k.surface else k.tint(color, if (kind == "err") 0.11f else 0.12f), 12)
            statusIcon.setImageDrawable(IconDrawable(icon, color, k.dp(17)))
            statusText.text = msg
            status.visibility = View.VISIBLE
        }
        val spinner = ProgressBar(activity).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(k.onAccent)
            visibility = View.GONE
        }
        val sendLabel = k.text(activity, s.send, 15f, k.onAccent, 650)
        val send = k.row(activity, 8).apply {
            gravity = Gravity.CENTER
            background = k.pressable(k.round(k.accent, 12))
            elevation = k.dpf(3)
            outlineSpotShadowColor = k.accent
            isClickable = true
            contentDescription = s.send
            addView(spinner, lp(k.dp(16), k.dp(16)))
            addView(sendLabel)
        }
        val another = k.pill(activity, null, s.another, fill = k.ink, stroke = 0, color = k.bg, heightDp = 48, radiusDp = 12) { close(); main.postDelayed({ again() }, 400) }
            .apply { textSize = 15f; typeface = android.graphics.Typeface.create(typeface, 650, false) }
        val shut = k.pill(activity, null, s.close, fill = k.bg, stroke = k.line, heightDp = 48, radiusDp = 12) { close() }
            .apply { textSize = 15f; typeface = android.graphics.Typeface.create(typeface, 650, false) }
        val doneRow = k.row(activity, 8).apply {
            visibility = View.GONE
            addView(another, lp(0, WRAP, 1f))
            addView(shut, lp(0, WRAP, 1f))
        }
        val foot = k.column(activity, 10).apply {
            setPadding(k.dp(16), k.dp(12), k.dp(16), k.dp(16))
            addView(status, lp(MATCH, WRAP))
            addView(send, lp(MATCH, k.dp(48)))
            addView(doneRow, lp(MATCH, WRAP))
        }
        val footLine = View(activity).apply { setBackgroundColor(k.line) }

        val sheet = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable22(k)
            elevation = k.dpf(16)
            isClickable = true // a tap on the sheet does not reach the scrim
            addView(grab, LinearLayout.LayoutParams(k.dp(38), k.dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = k.dp(8) })
            addView(head, lp(MATCH, WRAP))
            addView(scroll, lp(MATCH, 0, 1f))
            addView(footLine, lp(MATCH, k.dp(1)))
            addView(foot, lp(MATCH, WRAP))
        }
        // The sheet takes what it needs, at most 88 % of the screen; the scrim around it closes it.
        val scrim = object : FrameLayout(activity) {
            override fun onMeasure(w: Int, h: Int) {
                val max = (View.MeasureSpec.getSize(h) * 0.88f).toInt()
                (sheet.layoutParams as LayoutParams).height = ViewGroup.LayoutParams.WRAP_CONTENT
                super.onMeasure(w, h)
                if (sheet.measuredHeight > max) {
                    (sheet.layoutParams as LayoutParams).height = max
                    super.onMeasure(w, h)
                }
            }
        }.apply {
            setBackgroundColor(0x66090909)
            addView(sheet, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        }
        // The navigation bar and the keyboard push the sheet up.
        ViewCompat.setOnApplyWindowInsetsListener(scrim) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            scrim.setPadding(0, bars.top, 0, 0)
            sheet.setPadding(0, 0, 0, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        // ---- behavior ----
        var autoClose: Runnable? = null
        val voice = Voice(activity, s, SpeechLang.tag(lang, config.speechLang), current = { text.text.toString() },
            show = { t -> text.setText(t); text.setSelection(t.length) },
            listening = { on ->
                speakLabel.text = if (on) s.listening else s.speak
                speak.contentDescription = if (on) s.micStop else s.speak
                if (on && ValueAnimator.areAnimatorsEnabled()) pulse.start() else { pulse.cancel(); ring.alpha = 0f }
                if (on) setStatus(null)
            },
            problem = { m -> setStatus("warn", m) })
        speak.setOnClickListener { voice.toggle() }
        langButtons.forEach { (l, b) ->
            b.setOnClickListener {
                if (l == lang) return@setOnClickListener
                lang = l
                prefs.edit().putString(SpeechLang.KEY, l).apply()
                showLang()
                voice.relang(SpeechLang.tag(l, config.speechLang))
            }
        }

        fun textChanged() {
            val n = text.text.length
            counter.text = if (n >= TEXT_MAX - 500) "$n / $TEXT_MAX" else ""
            counter.visibility = if (n >= TEXT_MAX - 500) View.VISIBLE else View.GONE
            counter.setTextColor(if (n >= TEXT_MAX * 0.9) k.warn else k.muted)
            dialog.setCanceledOnTouchOutside(n == 0 || finished)
        }
        text.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(e: Editable?) = textChanged()
            override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
            override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
        })

        fun busy(on: Boolean) {
            send.isEnabled = !on
            send.alpha = if (on) 0.55f else 1f
            spinner.visibility = if (on) View.VISIBLE else View.GONE
        }
        fun showDone() {
            finished = true
            dialog.setCanceledOnTouchOutside(true)
            scroll.visibility = View.GONE
            send.visibility = View.GONE
            doneRow.visibility = View.VISIBLE
        }
        // The relay refused the report: the form comes back with the text, so the person can change it.
        fun showForm() {
            finished = false
            dialog.setCanceledOnTouchOutside(text.text.isEmpty())
            scroll.visibility = View.VISIBLE
            send.visibility = View.VISIBLE
            doneRow.visibility = View.GONE
        }
        fun waitingNote(msg: String): String {
            val n = Papercuts.status().waiting
            return if (n > 1) "$msg ${s.waiting(n)}" else msg
        }
        fun submit() {
            val t = text.text.toString().trim()
            if (t.isEmpty()) {
                setStatus("warn", s.writeFirst)
                text.requestFocus()
                return
            }
            voice.stop()
            busy(true)
            setStatus(null)
            // The sheet answers as soon as the report is on the phone. The send runs in the background and
            // updates the status while the sheet is open; after that, a notification says what became of it.
            val canSend = Papercuts.canSend()
            Papercuts.send(draft, t, stateSwitch.isChecked, "other", shot, pins, saved = {
                busy(false)
                if (canSend) setStatus("info", waitingNote(s.saved)) else setStatus("warn", s.queuedToken)
                showDone()
            }) { r ->
                when (r.outcome) {
                    SendOutcome.DONE -> {
                        val msg = SpannableStringBuilder(s.thanks)
                        val start = msg.length
                        msg.append("#${r.issue ?: "?"}")
                        val url = r.url
                        if (url != null) msg.setSpan(object : ClickableSpan() {
                            override fun onClick(v: View) {
                                try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
                            }
                        }, start, msg.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        msg.setSpan(StyleSpan(android.graphics.Typeface.BOLD), start, msg.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        statusText.setLinkTextColor(k.ink)
                        setStatus("ok", msg)
                        showDone()
                        autoClose = Runnable { if (dialog.isShowing) close() }.also { main.postDelayed(it, 2500) }
                    }
                    SendOutcome.KEEP -> setStatus("warn", if (r.error == "no token") s.queuedToken else waitingNote(s.queued))
                    SendOutcome.DROP -> {
                        setStatus("err", "${s.notSent}${r.error}. ${r.help}".trim())
                        showForm()
                    }
                }
            }
        }
        send.setOnClickListener { submit() }
        // A tap on the status (the issue link) keeps the sheet open.
        status.setOnClickListener { autoClose?.let { main.removeCallbacks(it) } }

        var closing = false
        close = {
            if (!closing) {
                closing = true
                autoClose?.let { main.removeCallbacks(it) }
                Papercuts.unwatch(draft.id)
                voice.destroy()
                pulse.cancel()
                if (ValueAnimator.areAnimatorsEnabled() && sheet.height > 0) {
                    scrim.animate().alpha(0f).setDuration(180).start()
                    sheet.animate().translationY(sheet.height.toFloat()).setDuration(200)
                        .withEndAction { if (dialog.isShowing) dialog.dismiss() }.start()
                } else dialog.dismiss()
            }
        }
        scrim.setOnClickListener { if (text.text.isEmpty() || finished) close() }
        dialog.setOnCancelListener { voice.destroy(); autoClose?.let { main.removeCallbacks(it) } }
        dialog.setOnDismissListener { Papercuts.unwatch(draft.id); voice.destroy(); pulse.cancel() }

        showShot()
        textChanged()
        dialog.setContentView(scrim)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(MATCH, MATCH)
            edgeToEdge(this, lightBars = !k.dark)
            @Suppress("DEPRECATION")
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
            setWindowAnimations(0)
        }
        dialog.show()
        // Dark buttons in the navigation bar over a light sheet; set once the window is shown, or it is ignored.
        dialog.window?.let { w -> androidx.core.view.WindowCompat.getInsetsController(w, w.decorView).isAppearanceLightNavigationBars = !k.dark }
        // Slides up like the web sheet on a phone.
        if (ValueAnimator.areAnimatorsEnabled()) {
            scrim.alpha = 0f
            scrim.animate().alpha(1f).setDuration(200).start()
            sheet.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
                override fun onPreDraw(): Boolean {
                    sheet.viewTreeObserver.removeOnPreDrawListener(this)
                    sheet.translationY = sheet.height.toFloat()
                    sheet.animate().translationY(0f).setDuration(260).setInterpolator(DecelerateInterpolator(2f)).start()
                    return true
                }
            })
        }
    }

    /** The sheet's background: rounded 22 dp on top only. */
    @Suppress("FunctionName")
    private fun GradientDrawable22(k: Tokens) = android.graphics.drawable.GradientDrawable().apply {
        setColor(k.bg)
        val r = k.dpf(22)
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
    }
}
