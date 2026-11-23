# Papercuts for Android

A person reports a problem on purpose; the app attaches its state. The app never files a papercut by itself.

- **Event log** (`Papercuts.event`): what the app did lately, kept only on the device (24 h, 300 events). The last
  30 minutes go with a report, one line each.
- **Report sheet** (`Papercuts.showDialog`): the phone layout of the web widget. A bottom sheet with a large speak
  button (speech input that keeps listening through short pauses) with DE / EN beside it, one text field, the screen picture and a switch
  "attach the app state". Tap the picture to draw on it and set numbered pins with a note each (like "Mark screen"
  on the web). Send says what happened: "Sent as #12" with a link, "saved on the phone" while the relay is out of
  reach, or why the relay refused it. Then "Report another" or "Close". Light and dark follow the phone; the accent
  is `Config.accent`. It takes a screenshot first and paints over the views you name (for example a WebView with a
  conversation). All words are in `Papercuts.Strings` (English defaults; Claude Auto passes the German ones of the
  web widget).
- **Drafts** (`capture` + `keepDraft`): capture the state now, finish the report later from a notification
  (for example a button in Android Auto).
- **Outbox**: reports wait as files until the relay answers (often only on the home network), then go to
  `POST /app-report` with the app token.
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

The app needs `INTERNET` and, to send when the network comes back, `ACCESS_NETWORK_STATE`. For the speak button
it needs `RECORD_AUDIO` (asked on the first tap) and, from Android 11, the speech service visible in its manifest:

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
