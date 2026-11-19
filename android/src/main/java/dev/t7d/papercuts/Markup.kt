package dev.t7d.papercuts

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.ByteArrayOutputStream

/** A marked picture: the PNG with the strokes and pins drawn in, and the words of each pin. */
internal class Marked(val png: ByteArray, val pins: List<String>)

/** The drawing sheet of the web widget: pen strokes and numbered pins on the screenshot, with a note per pin. */
internal object Markup {
    private const val RED = 0xFFD13438.toInt()

    private sealed class Mark
    private class Stroke(val points: MutableList<Pair<Float, Float>>) : Mark()
    private class Pin(val x: Float, val y: Float, var text: String = "") : Mark()

    fun show(activity: Activity, k: Tokens, s: Papercuts.Strings, shot: ByteArray, done: (Marked) -> Unit) {
        val source = BitmapFactory.decodeByteArray(shot, 0, shot.size) ?: return
        val marks = mutableListOf<Mark>()
        var tool = "pen"
        val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
        val canvasView = MarkView(activity, source, marks) { tool }
        val pins = k.column(activity, 8)

        fun renderPins() {
            pins.removeAllViews()
            marks.filterIsInstance<Pin>().forEachIndexed { i, p ->
                val num = k.text(activity, "${i + 1}", 12f, Color.WHITE, 700).apply {
                    gravity = Gravity.CENTER
                    background = k.round(RED, 999)
                    layoutParams = lp(k.dp(24), k.dp(24))
                }
                val input = EditText(activity).apply {
                    setText(p.text)
                    hint = s.pinText
                    contentDescription = s.pinLabel(i + 1)
                    filters = arrayOf(InputFilter.LengthFilter(120))
                    setSingleLine()
                    background = null
                    setTextColor(k.ink)
                    setHintTextColor(k.muted)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                    setPadding(k.dp(4), k.dp(6), k.dp(4), k.dp(6))
                    layoutParams = lp(0, WRAP, 1f)
                    addTextChangedListener(object : TextWatcher {
                        override fun afterTextChanged(e: Editable?) { p.text = e?.toString().orEmpty() }
                        override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                        override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                    })
                }
                pins.addView(k.row(activity, 10).apply {
                    setPadding(k.dp(8), k.dp(4), k.dp(8), k.dp(4))
                    background = k.round(k.bg, 12)
                    addView(num)
                    addView(input)
                })
            }
            pins.visibility = if (pins.childCount == 0) View.GONE else View.VISIBLE
        }
        canvasView.changed = { renderPins() }

        lateinit var pen: TextView
        lateinit var pin: TextView
        fun setTool(t: String) {
            tool = t
            for ((b, name) in listOf(pen to "pen", pin to "pin")) {
                val on = name == t
                b.background = k.pressable(k.round(if (on) k.ink else k.bg, 11))
                b.setTextColor(if (on) k.bg else k.muted)
                (b.compoundDrawablesRelative[0] as? IconDrawable)?.setColor(if (on) k.bg else k.muted)
            }
        }
        fun tool(icon: Icon?, label: String, primary: Boolean = false, iconOnly: Boolean = false, onClick: () -> Unit): TextView =
            k.pill(activity, icon, if (iconOnly) "" else label, fill = if (primary) k.accent else k.bg, stroke = 0,
                color = if (primary) k.onAccent else k.muted, radiusDp = 11, onClick = onClick).apply {
                setPadding(k.dp(if (primary) 14 else if (iconOnly) 9 else 9), 0, k.dp(if (primary) 14 else if (iconOnly) 9 else 9), 0)
                if (iconOnly) { contentDescription = label; tooltipText = label; compoundDrawablePadding = 0 }
            }
        fun sep() = View(activity).apply {
            setBackgroundColor(k.line)
            layoutParams = LinearLayout.LayoutParams(k.dp(1), k.dp(22)).apply { setMargins(k.dp(4), 0, k.dp(4), 0) }
        }

        pen = tool(Icon.PEN, s.pen) { setTool("pen") }
        pin = tool(Icon.PIN, s.pin) { setTool("pin") }
        val bar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(k.dp(4), k.dp(4), k.dp(4), k.dp(4))
            background = k.round(k.bg, 16)
            elevation = k.dpf(8)
            addView(pen)
            addView(pin)
            addView(sep())
            addView(tool(Icon.UNDO, s.undo, iconOnly = true) { if (marks.isNotEmpty()) marks.removeAt(marks.lastIndex); renderPins(); canvasView.invalidate() })
            addView(tool(Icon.TRASH, s.clear, iconOnly = true) { marks.clear(); renderPins(); canvasView.invalidate() })
            addView(sep())
            addView(tool(Icon.X, s.cancel, iconOnly = true) { dialog.dismiss() })
            addView(tool(Icon.CHECK, s.done, primary = true) {
                done(Marked(render(source, marks), marks.filterIsInstance<Pin>().map { it.text.trim() }))
                dialog.dismiss()
            })
        }
        val barScroll = HorizontalScrollView(activity).apply {
            isHorizontalScrollBarEnabled = false
            clipToPadding = false
            setPadding(0, k.dp(8), 0, k.dp(8))
            addView(bar)
        }
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xE009090B.toInt())
            setPadding(k.dp(16), k.dp(8), k.dp(16), k.dp(16))
            addView(barScroll, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(canvasView, lp(MATCH, 0, 1f).apply { setMargins(0, k.dp(8), 0, k.dp(8)) })
            addView(ScrollView(activity).apply { addView(pins) }, lp(MATCH, WRAP))
        }
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.ime())
            v.setPadding(k.dp(16), k.dp(8) + bars.top, k.dp(16), k.dp(16) + bars.bottom)
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        setTool("pen")
        renderPins()
        dialog.setContentView(root)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(MATCH, MATCH)
            edgeToEdge(this)
            @Suppress("DEPRECATION")
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        dialog.show()
    }

    private fun lineWidth(b: Bitmap) = maxOf(3f, Math.round(maxOf(b.width, b.height) / 220f).toFloat())

    private fun draw(c: Canvas, b: Bitmap, marks: List<Mark>) {
        val w = lineWidth(b)
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = RED; strokeWidth = w
        }
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = RED }
        val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD; textSize = w * 3 * 1.2f
        }
        var nr = 0
        for (m in marks) when (m) {
            is Stroke -> {
                val p = Path()
                m.points.forEachIndexed { i, (x, y) -> if (i == 0) p.moveTo(x, y) else p.lineTo(x, y) }
                if (m.points.size == 1) p.lineTo(m.points[0].first + 0.1f, m.points[0].second)
                c.drawPath(p, stroke)
            }
            is Pin -> {
                nr++
                c.drawCircle(m.x, m.y, w * 3, fill)
                c.drawText("$nr", m.x, m.y - (label.descent() + label.ascent()) / 2, label)
            }
        }
    }

    /** The PNG of the marked picture; the relay takes at most 8 MB, so a large one shrinks until it fits. */
    private fun render(source: Bitmap, marks: List<Mark>): ByteArray {
        val out = source.copy(Bitmap.Config.ARGB_8888, true)
        draw(Canvas(out), out, marks)
        var b = out
        while (true) {
            val bytes = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            if (bytes.size <= 6 * 1024 * 1024 || b.width < 64) return bytes
            b = Bitmap.createScaledBitmap(b, (b.width * 0.7f).toInt(), (b.height * 0.7f).toInt(), true)
        }
    }

    /** Shows the picture as large as it fits; touches are kept in picture pixels. */
    @SuppressLint("ViewConstructor")
    private class MarkView(ctx: Context, val source: Bitmap, val marks: MutableList<Mark>, val tool: () -> String) : View(ctx) {
        var changed: () -> Unit = {}
        private val toScreen = Matrix()
        private val toPicture = Matrix()
        private val frame = RectF()
        private val shadow = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        private var drawing: Stroke? = null

        override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
            val fit = minOf(w.toFloat() / source.width, h.toFloat() / source.height, 4f)
            val dw = source.width * fit
            val dh = source.height * fit
            frame.set((w - dw) / 2, (h - dh) / 2, (w + dw) / 2, (h + dh) / 2)
            toScreen.setRectToRect(RectF(0f, 0f, source.width.toFloat(), source.height.toFloat()), frame, Matrix.ScaleToFit.FILL)
            toScreen.invert(toPicture)
        }

        override fun onDraw(c: Canvas) {
            val r = 12 * resources.displayMetrics.density
            c.drawRoundRect(frame, r, r, shadow)
            c.save()
            val clip = Path().apply { addRoundRect(frame, r, r, Path.Direction.CW) }
            c.clipPath(clip)
            c.concat(toScreen)
            c.drawBitmap(source, 0f, 0f, null)
            draw(c, source, marks)
            c.restore()
        }

        private fun picture(e: MotionEvent): Pair<Float, Float> {
            val p = floatArrayOf(e.x, e.y)
            toPicture.mapPoints(p)
            return p[0].coerceIn(0f, source.width.toFloat()) to p[1].coerceIn(0f, source.height.toFloat())
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (!frame.contains(e.x, e.y)) return false
                    parent?.requestDisallowInterceptTouchEvent(true)
                    val p = picture(e)
                    if (tool() == "pin") {
                        marks.add(Pin(p.first, p.second))
                        changed()
                    } else {
                        drawing = Stroke(mutableListOf(p)).also { marks.add(it) }
                    }
                    invalidate()
                }
                MotionEvent.ACTION_MOVE -> drawing?.let { d ->
                    for (i in 0 until e.historySize) {
                        val p = floatArrayOf(e.getHistoricalX(i), e.getHistoricalY(i))
                        toPicture.mapPoints(p)
                        d.points.add(p[0] to p[1])
                    }
                    d.points.add(picture(e))
                    invalidate()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> drawing = null
            }
            return true
        }
    }
}
