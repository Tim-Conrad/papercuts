package dev.t7d.papercuts

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.PathParser

/** The design tokens of the web widget (widget/papercuts.js), light and dark. */
internal class Tokens(ctx: Context, val accent: Int) {
    val dark = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val onAccent = Color.WHITE
    val bg = if (dark) 0xFF1B1B1F.toInt() else 0xFFFFFFFF.toInt()
    val surface = if (dark) 0xFF26262B.toInt() else 0xFFF4F4F5.toInt()
    val hover = if (dark) 0xFF303036.toInt() else 0xFFECECEF.toInt()
    val line = if (dark) 0x1CFFFFFF else 0x1C18181B
    val ink = if (dark) 0xFFF4F4F5.toInt() else 0xFF18181B.toInt()
    val muted = if (dark) 0xFFA1A1AA.toInt() else 0xFF6B6B75.toInt()
    val ok = if (dark) 0xFF4ADE80.toInt() else 0xFF15803D.toInt()
    val warn = if (dark) 0xFFFBBF24.toInt() else 0xFFB45309.toInt()
    val err = if (dark) 0xFFF87171.toInt() else 0xFFDC2626.toInt()
    /** The border of a focused field: ink at 38 %. */
    val focus = ColorUtils.setAlphaComponent(ink, 97)
    fun tint(c: Int, amount: Float = 0.12f) = ColorUtils.blendARGB(bg, c, amount)

    private val density = ctx.resources.displayMetrics.density
    fun dp(v: Number) = (v.toFloat() * density + 0.5f).toInt()
    fun dpf(v: Number) = v.toFloat() * density
}

/** A rounded rectangle, with an optional border. */
internal fun Tokens.round(fill: Int, radiusDp: Number, stroke: Int = 0, strokeDp: Number = 1): GradientDrawable =
    GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dpf(radiusDp)
        if (stroke != 0) setStroke(dp(strokeDp).coerceAtLeast(1), stroke)
    }

/** A pressable background: the shape plus a ripple in the hover color. */
internal fun Tokens.pressable(shape: GradientDrawable, mask: Int = Color.WHITE): Drawable {
    val m = GradientDrawable().apply { setColor(mask); cornerRadius = shape.cornerRadius }
    return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, 30)), shape, m)
}

internal fun Tokens.text(ctx: Context, s: CharSequence, sizeSp: Float, color: Int = ink, weight: Int = 400): TextView =
    TextView(ctx).apply {
        text = s
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        typeface = Typeface.create(Typeface.DEFAULT, weight, false)
        includeFontPadding = false
        setLineSpacing(0f, 1.3f)
    }

/** A button with an icon only: 44 dp, the size fingers need. */
internal fun Tokens.iconButton(ctx: Context, icon: Icon, label: String, color: Int = muted, onClick: () -> Unit): ImageView =
    ImageView(ctx).apply {
        setImageDrawable(IconDrawable(icon, color, dp(20)))
        scaleType = ImageView.ScaleType.CENTER
        contentDescription = label
        tooltipText = label
        background = pressable(round(Color.TRANSPARENT, 12))
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
        setOnClickListener { onClick() }
    }

/** A pill or tool button: icon and words in one row. */
internal fun Tokens.pill(ctx: Context, icon: Icon?, label: String, fill: Int = bg, stroke: Int = line, color: Int = ink, heightDp: Int = 44, radiusDp: Int = 999, onClick: () -> Unit): TextView =
    text(ctx, label, 13f, color, 560).apply {
        gravity = Gravity.CENTER
        setPadding(dp(14), 0, dp(14), 0)
        minHeight = dp(heightDp)
        if (icon != null) {
            setCompoundDrawablesRelative(IconDrawable(icon, if (color == ink) muted else color, dp(16)), null, null, null)
            compoundDrawablePadding = dp(7)
        }
        background = pressable(round(fill, radiusDp, stroke))
        isClickable = true
        setOnClickListener { onClick() }
    }

internal fun View.clipRound(radiusPx: Float) {
    outlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
    }
    clipToOutline = true
}

/** A dialog window under the status and navigation bars; the content pads itself by the insets. */
internal fun edgeToEdge(w: android.view.Window, lightBars: Boolean = false) {
    androidx.core.view.WindowCompat.setDecorFitsSystemWindows(w, false)
    androidx.core.view.WindowCompat.getInsetsController(w, w.decorView).isAppearanceLightNavigationBars = lightBars
    if (android.os.Build.VERSION.SDK_INT >= 30) w.attributes = w.attributes.apply { fitInsetsTypes = 0 }
    w.attributes = w.attributes.apply { layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
    @Suppress("DEPRECATION")
    w.statusBarColor = Color.TRANSPARENT
    @Suppress("DEPRECATION")
    w.navigationBarColor = Color.TRANSPARENT
    if (android.os.Build.VERSION.SDK_INT >= 29) w.isNavigationBarContrastEnforced = false
}

internal fun lp(w: Int, h: Int, weight: Float = 0f) = LinearLayout.LayoutParams(w, h, weight)
internal const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
internal const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

/** A vertical stack with a gap between the children, like `display: grid; gap` on the web. */
internal fun Tokens.column(ctx: Context, gapDp: Int): LinearLayout = LinearLayout(ctx).apply {
    orientation = LinearLayout.VERTICAL
    showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    dividerDrawable = GradientDrawable().apply { setSize(0, dp(gapDp)) }
}

internal fun Tokens.row(ctx: Context, gapDp: Int): LinearLayout = LinearLayout(ctx).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    dividerDrawable = GradientDrawable().apply { setSize(dp(gapDp), 0) }
}

/** The icons of the web widget: plain shapes on a 24 px grid, stroked 2 px with round ends. */
internal class Icon(vararg val shapes: Shape) {
    sealed class Shape
    class P(val d: String) : Shape()
    class R(val x: Float, val y: Float, val w: Float, val h: Float, val rx: Float, val rotate: Float = 0f) : Shape()
    class C(val cx: Float, val cy: Float, val r: Float) : Shape()

    companion object {
        val LOGO = Icon(R(2.5f, 8f, 19f, 8f, 4f, -45f), P("M10.6 10.6h.01M13.4 13.4h.01M13.4 10.6h.01M10.6 13.4h.01"))
        val X = Icon(P("M6 6l12 12M18 6 6 18"))
        val MIC = Icon(R(9f, 2.5f, 6f, 12f, 3f), P("M5 10.5a7 7 0 0 0 14 0M12 17.5V21"))
        val PEN = Icon(P("M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"))
        val PIN = Icon(C(12f, 12f, 9f), P("M10.5 9 12.5 8v8"))
        val UNDO = Icon(P("M9 14 4 9l5-5"), P("M4 9h11a5 5 0 0 1 0 10h-3"))
        val TRASH = Icon(P("M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"))
        val CHECK = Icon(P("M20 6 9 17l-5-5"))
        val ALERT = Icon(C(12f, 12f, 9f), P("M12 8v4.5M12 16h.01"))
        val CLOCK = Icon(C(12f, 12f, 9f), P("M12 7v5l3 2"))
        val SCREEN = Icon(R(2.5f, 4f, 19f, 13f, 2f), P("M8 21h8M12 17v4"))
    }
}

internal class IconDrawable(private val icon: Icon, color: Int, private val size: Int) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = 2f
        this.color = color
    }
    private val paths = icon.shapes.map { s -> if (s is Icon.P) PathParser.createPathFromPathData(s.d) else null }

    init { setBounds(0, 0, size, size) }

    fun setColor(c: Int) { paint.color = c; invalidateSelf() }

    override fun getIntrinsicWidth() = size
    override fun getIntrinsicHeight() = size

    override fun draw(canvas: Canvas) {
        val b = bounds
        canvas.save()
        canvas.translate(b.left.toFloat(), b.top.toFloat())
        canvas.scale(b.width() / 24f, b.height() / 24f)
        icon.shapes.forEachIndexed { i, s ->
            when (s) {
                is Icon.P -> canvas.drawPath(paths[i] ?: Path(), paint)
                is Icon.C -> canvas.drawCircle(s.cx, s.cy, s.r, paint)
                is Icon.R -> {
                    canvas.save()
                    if (s.rotate != 0f) canvas.rotate(s.rotate, 12f, 12f)
                    canvas.drawRoundRect(RectF(s.x, s.y, s.x + s.w, s.y + s.h), s.rx, s.rx, paint)
                    canvas.restore()
                }
            }
        }
        canvas.restore()
    }

    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(cf: ColorFilter?) { paint.colorFilter = cf }
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}
