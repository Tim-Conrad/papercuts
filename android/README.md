# Papercuts for Android

A person reports a problem on purpose; the app attaches its state. The app never files a papercut by itself.

- **Event log** (`Papercuts.event`): what the app did lately, kept only on the device (24 h, 300 events). The last
  30 minutes go with a report, one line each.
- **Report dialog** (`Papercuts.showDialog`): one input and Send, like the web widget, and a box "attach the app state".
  It takes a screenshot first and paints over the views you name (for example a WebView with a conversation).
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

The app needs `INTERNET` and, to send when the network comes back, `ACCESS_NETWORK_STATE`.
