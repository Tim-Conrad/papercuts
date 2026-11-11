# Papercuts v0.3: premium widget, voice first, shortcuts, ticket config

Status: building. Requests by Tim on 2026-11-12, during the lab rollout:

1. "Really go all in on making sure the UI UX is flawless. We want premium quality."
2. "Make it really easy for agents to define what the tickets should include. As agents will integrate this library make the agent experience top notch. What are things that are generalised that work everywhere and apply these."
3. "On mobile audio input needs to be always the priority. Make it super easy to define shortcuts for humans to use this to feedback apps."

Marked "my call" where Tim did not decide. He can reverse each.

## 1. Premium widget (done in commit 55b779e)

Design tokens, a bottom sheet on phones, a floating card on desktop, chips, a growing text field, status banners, focus handling, and reduced motion. A screenshot gallery in light and dark mode at 390 and 1440 px is the check for each change.

## 2. The ticket config: `.github/papercuts.json`

One file in the repo of the app defines what a papercut of that app contains. It works the same for the widget, the JS API, the CLI and the relay. My call: JSON (no parser dependency) in `.github/`, next to the issue templates.

```json
{
  "$schema": "https://raw.githubusercontent.com/Tim-Conrad/papercuts/main/schema/papercuts.schema.json",
  "kinds": ["bug", "ux", "copy", "idea"],
  "fields": [
    { "id": "expected", "label": "What did you expect?", "required": false },
    { "id": "device", "label": "Device", "options": ["phone", "tablet", "desktop"] }
  ],
  "presets": [
    { "kind": "ux", "text": "Too small to tap" },
    { "kind": "bug", "text": "This does not load" }
  ],
  "labels": ["area:web"],
  "labelsByKind": { "bug": ["bug"] },
  "assignees": ["Tim-Conrad"],
  "context": { "storage": ["theme"], "skipStorage": ["room-code"] },
  "lang": "en"
}
```

- Every key is optional. Without the file, papercuts works as in v0.2.
- `fields`: at most 8. `id` matches `^[a-z][a-z0-9_-]{0,31}$`. A field with `options` is a choice, else one line of text (max 300 characters). A required field is required for people and agents.
- `kinds`: a subset of the built-in kinds, in the order the widget shows them. No new kinds, so that labels stay the same in all repos.
- `presets`: at most 12 quick phrases. One tap fills kind and text.
- `labels`, `labelsByKind`, `assignees`: added to each new issue. The relay creates missing labels.
- `context`: the `localStorage` keys to include, the same as `data-storage` and `data-storage-skip`.
- The page attributes win over the file. The file wins over the defaults.

Where the file is read:

- The relay: `GET /config?repo=owner/name` reads the file from the default branch with the credential (Contents: read), checks it, caches it for 5 minutes, and answers the checked config with a list of warnings. A broken file gives the defaults and the warnings, never an error for the page.
- The widget loads `/config` at start.
- The relay applies fields, labels and assignees to each report, also to reports from the JS API and the CLI.
- The issue body shows each field as a line `**What did you expect?** ...` below the sentence, and the YAML block holds `fields:`.

Agent experience:

- `papercuts init` (in the repo of an app):
  - detects the stack: FastAPI, nginx, Vite, Express, static
  - writes a starter `.github/papercuts.json` if none exists
  - adds the papercuts block to `AGENTS.md`
  - prints the exact steps for the feature flag of that stack, and the test to add

  It never overwrites a file. A second run is a no-op.
- `papercuts config [--check]`: shows the config of the repo that the relay uses, with warnings. `--check` exits 1 on a warning, for CI.
- `papercuts add ... --field expected="..."` and `report({ fields: { expected: "..." } })`. An unknown field gives an error with the list of valid fields.
- A JSON Schema at `schema/papercuts.schema.json`, so that editors and agents can check the file.
- The README gets an "Integrate papercuts into an app" checklist, which `papercuts init` also prints.

## 3. Voice first on phones

My call: on a touch device with speech input, the sheet leads with a large round button "Tap to speak":

- Tap starts listening. The words show live in the text field. A ring pulses while the microphone is on. Tap again to stop.
- The text stays editable after speech.
- Without speech input (Firefox on Android), the sheet leads with the text field and a hint to use the microphone key of the keyboard.
- On desktop, the microphone stays a small button in the text field.
- `data-voice="off"` turns voice first off.

## 4. Shortcuts for people

- `data-shortcut="alt+shift+p"` (default) sets the key combination. `data-shortcut="off"` turns it off. The widget shows the combination in the tab title.
- A link with `#papercut` (or `?papercut=open`) opens the panel when the page loads. The widget then removes it from the URL. It works for bookmarks, QR codes and a home-screen link.
- A long press with two fingers (600 ms) on touch opens the panel. `data-gesture="off"` turns it off. My call: no shake gesture, because iOS asks for a motion permission.
- Presets from the config show as chips above the text field. On a phone, a preset plus Send is two taps.
- `window.papercuts.open({ kind, text })` opens the panel with a draft, so that an app can add its own button or menu entry.
