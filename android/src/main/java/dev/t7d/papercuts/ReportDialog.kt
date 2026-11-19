package dev.t7d.papercuts

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout

/** One input and Send, like the web widget. The person chooses no kind; agents triage. */
internal object ReportDialog {
    fun show(activity: Activity, draft: Draft, config: Papercuts.Config, send: (String, Boolean) -> Unit) {
        val s = config.strings
        val pad = (16 * activity.resources.displayMetrics.density).toInt()
        val input = EditText(activity).apply {
            hint = s.hint
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 2
        }
        val box = CheckBox(activity).apply {
            text = s.attachState
            isChecked = config.attachStateDefault
        }
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
            addView(box)
        }
        val dialog = AlertDialog.Builder(activity)
            .setTitle(s.title)
            .setView(layout)
            .setPositiveButton(s.send, null)
            .setNegativeButton(s.cancel, null)
            .create()
        dialog.setOnShowListener {
            val ok = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            ok.isEnabled = false
            input.addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(e: android.text.Editable?) { ok.isEnabled = !e.isNullOrBlank() }
                override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
            })
            ok.setOnClickListener {
                send(input.text.toString(), box.isChecked)
                dialog.dismiss()
            }
        }
        dialog.show()
    }
}
