# Things that cost a day

Behaviour that is real, non-obvious, and not written down clearly anywhere else. Each one was found the slow way.

## Android audio input

**expo-audio cannot see a USB microphone.** Its Android `getAvailableInputs()` keeps only `TYPE_BUILTIN_MIC`, `TYPE_BLUETOOTH_SCO` and `TYPE_WIRED_HEADSET`. A USB-C mic or dongle is `TYPE_USB_DEVICE` / `TYPE_USB_HEADSET` / `TYPE_USB_ACCESSORY`, so it will never be listed however it is attached. Query `AudioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)` yourself — that is all a plain Android recorder app does, it needs no recorder instance, and it therefore works *before* a take starts. See `modules/mixtape-wakelock`.

**Asking for stereo can silently lose you the external mic.** Android picks the input device by matching what the recorder demands against what each device can deliver. A mono-only USB mic is not a candidate for a two-channel request, so the policy falls back to the built-in mic with no error and no warning — the recording simply comes out on the phone. `RecordingPresets.HIGH_QUALITY` asks for `numberOfChannels: 2`. If you do not specifically need stereo, record mono.

**`getCurrentInput()` is not read-only.** When nothing is routed yet it walks the device list, picks the built-in mic, and *assigns* it to `recorder.preferredDevice`. Calling it before recording — or too early into a take, before the route settles — can pin the built-in mic and drag a live recording off the external one. Only call it once a take is properly under way, or avoid it.

**`setInput(uid)` resolves against the unfiltered list.** Unlike `getAvailableInputs()`, it looks the id up in the full `AudioManager` device list, so you can select a USB device through it as long as you obtained the id elsewhere. It needs a prepared recorder underneath: with none, it silently does nothing. Call it after `prepareToRecordAsync()` and before `record()`.

## EAS build

**Gitignored files never reach the builder.** EAS uploads the project through git, so anything in `.gitignore` is absent when the bundler runs — which surfaces as `Unable to resolve module ...` in the *Bundle JavaScript* phase, long before Gradle. If a gitignored file is genuinely needed to bundle, add a `.easignore`: EAS uses it **instead of** `.gitignore` for that upload, so it should be a copy of `.gitignore` minus the files the bundler needs.

**A new APK can downgrade its own JS.** With `runtimeVersion` on the `appVersion` policy, an installed build takes the newest update published to its channel for that runtime. Ship an APK without publishing a matching update and it will pull the older bundle down over the one embedded in it on first launch. Publish the update alongside the build.

**Native changes need a build; JS changes do not.** Anything touching `modules/`, `app.json` permissions or native dependencies requires `eas build`. Everything else ships with `eas update`.

**Build logs are brotli-compressed.** `eas build:view` gives the phase that failed but not the error. The log file is reachable through the GraphQL API (`builds.byId.logFiles`) and is served `Content-Encoding: br`, so `gzip` will not open it — `zlib.brotliDecompressSync` will. Inside it is ndjson, one object per line, with the real error under `phase`.

## AssemblyAI

**Use a floor, not a ceiling, to control diarization.** `speaker_options.min_speakers_expected` is what forces a split. A ceiling alone cannot: capping a two-person conversation at 1 collapses the whole thing into a single utterance, while a floor of 2 on the same audio produces a proper two-speaker transcript.

**`speakers_expected` and `speaker_options` are mutually exclusive**, and `max_speakers` is not a field — passing it is a 400.

**Content-based speaker identification needs names said out loud.** It is exact when someone is addressed by name in the audio and confidently wrong when nobody is, so gate it on evidence rather than trusting the mapping.

**Ten hours is the hard ceiling.** A longer file cannot be transcribed at all, so cap recording length below it rather than discovering this at upload time.

## Anthropic API

**A thinking-capable model puts a `thinking` block first**, so `content[0].text` is `undefined` and any code reading it silently falls back. Filter the content array for `type === "text"`. Give it a real `max_tokens` budget too: a small one gets spent entirely on thinking, and the reply comes back empty.
