# Papercuts for Android

A person reports a problem on purpose; the app attaches its state. The app never files a papercut by itself.

- **Event log** (`Papercuts.event`): what the app did lately, kept only on the device (24 h, at most 5000 events).
  A report carries the whole log as the attachment `events.log`, one line per event, oldest first. A run of equal
  events becomes one line with a count (`net n=wlan ×3 until 14:05:40`). Events in `Config.quietEvents` (bursts, for
  example a list that the car asks for) count as one run even with other fields. Events in `Config.sectionEvents`
  (for example `call_start`) open a block with an empty line and `## `, so that a reader sees each call. If the log
  is longer than the 60000 characters of an attachment, the oldest lines go. The context of the report keeps the
  last 40 lines (`events`). The app keeps two attachments of its own (the relay takes three).
- **Report sheet** (`Papercuts.showDialog`): the phone layout of the web widget. A bottom sheet with a large speak
  button (speech input that keeps listening through short pauses) with DE / EN beside it, one text field, the screen picture and a switch
  "attach the app state". Tap the picture to draw on it and set numbered pins with a note each (like "Mark screen"
  on the web). Send never waits for the network: the sheet answers as soon as the report is in the outbox ("Saved. It
  is sent in the background.") with "Report another" and "Close". While the sheet stays open, the status changes to
  what happened: "Sent as #12" with a link, "saved on the phone" while the relay is out of reach, or why the relay
  refused it (then the form comes back with the text). Light and dark follow the phone; the accent
  is `Config.accent`. It takes a screenshot first and paints over the views you name (for example a WebView with a
  conversation). All words are in `Papercuts.Strings` (English defaults; Claude Auto passes the German ones of the
  web widget).
- **Drafts** (`capture` + `keepDraft`): capture the state now, finish the report later from a notification
  (for example a button in Android Auto).
- **Outbox**: reports wait as files until the relay answers (often only on the home network), then go to
  `POST /app-report` with the app token. One background worker sends them, the newest report first. A probe of 1.5 s
  comes first, so an unreachable relay costs about 1.5 s and not the timeout of each report. The worker runs on
  start, on Send, when the network changes, and from a background job (`OutboxJob`, JobScheduler) while the app is
  closed: after a failed try with a network constraint and a delay of 30 s, doubled up to 15 minutes, and on mobile
  data once more as soon as a network without a meter (the home WLAN) is there. `Papercuts.status()` gives the number
  of waiting reports, the last error and the time of the last try; they survive a restart.
- **Confirmation**: a report that the relay files (or refuses) after its sheet closed gives a silent notification
  with the issue number and the first words of the report. A tap opens the issue. Only if the app may post
  notifications.
- **Attachments**: text the app hands over in its `StateProvider`, for example a cleaned DOM. Each becomes one
  comment of the issue (`papercuts attachment <id>`). Remove private content in the app: papercuts only redacts secrets.

No dependencies beyond the Android SDK, `androidx.core` (notifications) and `org.json`. The apps compile the sources
from a pinned flake input: add `android/src/main/java` as a source folder (Gradle `sourceSets`), and
`android/src/test/java` to the unit tests (they need `org.json:json` on the test classpath).

```kotlin
Papercuts.init(this, Papercuts.Config(
    repo = "Tim-Conrad/my-app",
    relayUrl = { "https://papercuts.lab.t7d.dev" },
    token = { prefs.papercutsToken },
    attachStateDefault = BuildConfig.PAPERCUTS_STATE_DEFAULT,
    base = { mapOf("app" to BuildConfig.VERSION_NAME, "android" to Build.VERSION.SDK_INT) },
))
Papercuts.event("call_start", "source" to "car")
Papercuts.showDialog(activity, where = "MainActivity", state = { done -> done(State(mapOf("phase" to phase))) })
```

The app needs `INTERNET` and, to send when the network comes back, `ACCESS_NETWORK_STATE`. To send while the app is
closed, it declares the job service; `RECEIVE_BOOT_COMPLETED` keeps the job planned across a restart of the phone:

```xml
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<service
    android:name="dev.t7d.papercuts.OutboxJob"
    android:exported="false"
    android:permission="android.permission.BIND_JOB_SERVICE" />
```

Without the service, reports go out only while the app runs. The jobs use the ids `Config.jobId` and `jobId + 1`.
For the speak button it needs `RECORD_AUDIO` (asked on the first tap) and, from Android 11, the speech service visible in its manifest:

```xml
<queries>
    <intent><action android:name="android.speech.RecognitionService" /></intent>
</queries>
```

Without both, or on a phone without speech recognition, the sheet leaves the speak button out.

The person picks the speech language beside the speak button: DE or EN. The phone keeps the choice
(SharedPreferences `papercuts`, key `speech_lang`). A tap while the sheet listens starts the input again in the new
language, and the words so far stay. Until the first tap, the choice comes from `Config.speechLang`, else the
language of the phone.
