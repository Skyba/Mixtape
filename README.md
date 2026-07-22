# Mixtape — voice & meeting recorder

A sideloaded Android app (Expo / React Native) that records long-form audio,
transcribes it with **speaker diarization**, syncs to your own cloud, and gives
you shareable read-only transcript links and a per-user REST API. Built for
personal use — no Play Store, no third-party servers: **you run the whole
backend on your own Firebase project.**

> **Backend note:** this uses **Firebase** (Auth, Cloud Storage, Firestore,
> Cloud Functions), *not* Supabase. Transcription is **AssemblyAI**; topic/summary
> and speaker-name inference are **Anthropic (Claude)**. You bring your own keys
> for both — they're entered in the app's Settings, never committed.

## Features

- Record to `.m4a` (AAC), background/screen-off safe, pause/resume, up to hours long
- Transcription with speaker diarization (AssemblyAI); **speaker names inferred
  from the transcript content**, not guessed by order
- Auto topic/title + optional AI summary (Claude)
- Cloud sync (per-user, namespaced storage), local-first with retry/recovery
- Public read-only **share links** (colored transcript + talk-time + summary) —
  including live sharing while recording
- Per-user **REST API** (Bearer keys) to pull recordings/transcripts/audio
- Live (near-real-time) segmented transcription with exponential-backoff diarization

## Architecture

```
Expo RN app  ──►  Firebase Auth (email/password)
             ──►  Cloud Storage   recordings/<uid>/<folder>/<base>.{m4a,txt,json,aai.json}
             ──►  Firestore       shares/<id>  (public share docs), apiKeys/<hash>
             ──►  Cloud Functions  api (REST) · mergeAudio · askSonnet · createApiKey…
             ──►  Hosting          public/index.html  (share viewer at /r/<id>)
external:    AssemblyAI (transcription) · Anthropic (topics/summary/name-mapping)
```

## Prerequisites

- Node 20+, a package manager (npm), Git
- An **Expo** account + `eas-cli` (`npm i -g eas-cli`) for building the APK
- The **Firebase CLI** (`npm i -g firebase-tools`) on the Blaze (pay-as-you-go)
  plan — Cloud Functions require it
- An **AssemblyAI** API key and an **Anthropic** API key (entered in-app later)

## 1. Clone & install

```bash
git clone <your-fork-url> mixtape && cd mixtape
npm install
cp firebaseConfig.example.ts firebaseConfig.ts       # app's Firebase config
cp public/index.example.html public/index.html       # share-viewer's Firebase config
cp .firebaserc.example .firebaserc                    # your Firebase project id
# now fill each of the three in (step 3)
```

These three copies (`firebaseConfig.ts`, `public/index.html`, `.firebaserc`) are
**gitignored** — your project's config/ids never get committed. Only the
`*.example` templates are in the repo.

## 2. Create your Firebase project

In the [Firebase console](https://console.firebase.google.com):

1. Create a project, upgrade it to the **Blaze** plan (needed for Functions).
2. **Authentication** → enable **Email/Password**. Create your owner user
   (Users → Add user), or sign up in-app later.
3. **Storage** → enable it (pick a region).
4. **Firestore** → create a database (**Standard** edition, production mode).
5. Project settings → **Your apps** → add a **Web app** → copy the SDK config.

## 3. Wire your project into the code

| File (copied from its `.example` in step 1) | What to set |
|------|-------------|
| `firebaseConfig.ts` | paste the Web app config (from step 2.5) |
| `public/index.html` | paste the **same** Firebase web config (the share viewer embeds it) |
| `.firebaserc` | your Firebase project id (or delete it and run `firebase use --add`) |
| `app.json` | `expo.owner`, `expo.extra.eas.projectId`, `expo.updates.url` (your Expo project), `android.package` + `ios.bundleIdentifier` (your own reverse-DNS id), `scheme` |

`SHARE_BASE` and the REST `API_BASE` are derived automatically from
`firebaseConfig.projectId` (`https://<projectId>.web.app`), so you don't edit those.

## 4. Deploy the backend (rules, functions, hosting)

```bash
firebase login
# set the server-side Anthropic key used by the share-page "ask" function:
firebase functions:secrets:set ANTHROPIC_KEY
cd functions && npm install && cd ..
firebase deploy    # storage.rules, firestore.rules, functions, hosting
```

Security rules (already in the repo):
- `storage.rules` — `recordings/<uid>/**` readable/writable only by that signed-in user
- `firestore.rules` — `shares/<id>` public-read + owner-write; `apiKeys` server-only

## 5. Build & install the app

```bash
eas login
eas build --platform android --profile preview   # builds an installable APK
```

Download the APK from the build URL, install it (allow "unknown sources"), open
it, and **sign in** with your Firebase user. Then **Settings**:
- paste your **AssemblyAI** key (enables transcription)
- paste your **Anthropic** key (enables topics/summaries/name inference)

JS-only changes ship over the air with `eas update --branch preview`; native
changes (new modules, `app.json` plugins) need a fresh `eas build`.

## Optional

- **REST API** — Settings → API access generates Bearer keys.
  `GET https://<projectId>.web.app/api/v1/recordings|transcript|utterances|audio|meta`
- **Live share links** — toggle "Share live link" while recording.
- **External sync** — the REST API lets you pull your recordings/transcripts
  into your own scripts or a separate archive; not required to run the app.

## Security notes

- The Firebase **web API key is not a secret** (client identifier); access is
  gated by the rules + Auth above. Safe to ship in the app/hosting.
- **Real secrets stay out of git:** AssemblyAI/Anthropic keys live in the app's
  encrypted-at-rest settings (per install) and in a Functions secret
  (`ANTHROPIC_KEY`); `.env`, `firebaseConfig.ts`, and service accounts are gitignored.
- Storage/Firestore are **owner-scoped** — each user only sees their own `uid`.

## License

MIT — see [LICENSE](LICENSE).
