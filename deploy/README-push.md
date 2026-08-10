# Push notifications to the Android app — one-time setup

The hub sends two kinds of notification, on two Android channels so they can be
silenced independently from the phone's own notification settings.

**Brewery alerts** (`konfus-critical`) go to *every* phone: the fermenter losing
pressure or running away with it, a chamber overheating, a fridge that has
stopped cooling, kegs warming up, the brewery near freezing, a critical sensor
gone quiet. Nobody caused these, so there is nobody to leave out. Which of them
fire, and at what threshold, is set in the app under **Settings →
Notifications**; the same screen has a **Send test** button and says whether
delivery is working at all.

**Changes** (`konfus-changes`) go to every *other* signed-in phone when somebody
changes something that matters — a fermenter setpoint, what is in a keg, a saved
recipe, a started brew session, a to-do added or removed, a settings change.
Tapping one opens the page the change was on. You are never notified about your
own changes; that is the whole reason the token is stored against an account.

**Nothing below is needed for the app to work.** With no Firebase credentials
the hub simply never pushes (it says so once at boot, in the journal), and the
app is unchanged in every other respect — the alerts are still recorded and
shown on the Alerts page. What this adds is the buzz.

## What sends a notification

Brewery alerts are listed in **Settings → Notifications** and all open the
Alerts page. Changes:

| Change                                     | Opens       |
| ------------------------------------------ | ----------- |
| A device setpoint (fermenter, keg fridge)  | Devices     |
| Keg contents                               | Kegs        |
| A recipe created, or **Save** on a recipe  | Recipes     |
| A brew session started                     | Brew Sessions |
| A to-do added or deleted                   | To-Do       |
| Notification / recipe-default / colour settings | Settings |

Deliberately quiet: moving a brew session between stages, ticking a to-do off,
the rig's own heater and pump controls during a session (whoever is standing at
the rig is driving it), price overrides, and everything else in the change
history. The [history page](../apps/web/src/pages/History.tsx) still records all
of it — a notification interrupts someone, a history entry waits to be read.

The set lives in one place, as `push:` on the rules in
[`apps/server/src/audit/hook.ts`](../apps/server/src/audit/hook.ts), and is
pinned by a test so it can't drift by accident.

## 1. Create the Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) → **Create
   a project**. Call it whatever you like (`konfus` reads well in the console).
   Google Analytics is not needed.
2. In the project, **Add app → Android**.
   - **Package name**: `com.konfus.app` — this must match exactly (it's
     `appId` in [`capacitor.config.ts`](../apps/web/capacitor.config.ts)).
   - Nickname and signing certificate can be left empty; FCM does not need
     the SHA-1 for messaging.
3. Download **`google-services.json`** and put it at:

   ```
   apps/web/android/app/google-services.json
   ```

   The Android build picks it up automatically — `app/build.gradle` applies the
   google-services plugin only when that file exists.

Nothing about a sideloaded APK stops this working: FCM has no Play Store
requirement.

## 2. Give the Pi a key to send with

Sending is a server-to-Google call, so the hub needs a service account —
separate from the JSON above, and the one thing here that is a secret.

1. Firebase console → ⚙ **Project settings** → **Service accounts** →
   **Generate new private key**. You get a JSON file.
2. Copy it to the Pi, readable only by the service user:

   ```sh
   sudo install -m 600 -o brewplanner -g brewplanner fcm-key.json /etc/brewplanner-fcm.json
   ```

3. Point the hub at it in `/etc/brewplanner.env`:

   ```sh
   FCM_SERVICE_ACCOUNT_KEY_FILE=/etc/brewplanner-fcm.json
   ```

   (`FCM_SERVICE_ACCOUNT_KEY` takes the JSON inline instead, for setups where
   dropping a file is awkward. Same shape as the Drive backup credentials — see
   [README-recipe-backup.md](README-recipe-backup.md) — but a *different* key,
   from the Firebase project, and scoped to messaging only.)

4. Restart and check the line:

   ```sh
   sudo systemctl restart checklist-server
   journalctl -u checklist-server -n 30 | grep -i push
   # Push notifications enabled (the app is told about changes and critical alerts).
   ```

The Pi only needs **outbound** HTTPS to Google for this. Nothing new is exposed,
and the Cloudflare tunnel is not involved.

## 3. Rebuild and reinstall the app

The APK carries its own copy of the web bundle *and* the Firebase config, so a
rebuild is required — an already-installed app will not start receiving.

```sh
cd apps/web
npm run android:build          # vite build + cap sync android
cd android && ./gradlew assembleDebug
# apk: apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Install it, sign in, and Android will ask once for notification permission.
Grant it — declining is remembered, and the app never asks again (Settings →
Apps → Konfus → Notifications turns it back on).

Each phone registers itself right after it signs in, and hands the token back
when you sign out — so a shared phone never keeps buzzing with the previous
user's notifications.

## Troubleshooting

**Nothing arrives at all.** Open **Settings → Notifications** first: the
Delivery row says whether the hub has a key and how many phones are registered,
which separates the two causes. Then check the boot line from step 2. "Push
notifications disabled" means the hub has no key; a warning about an unreadable
key means the JSON is not a service-account key (the `google-services.json` from
step 1 is a common mix-up — that one belongs in the APK, not on the Pi).

**Changes arrive but brewery alerts don't** (or the reverse). They are separate
Android channels, so one can be muted on the phone while the other works:
Settings → Apps → Konfus → Notifications, then check *Brewery alerts* and
*Brewery changes*. Also worth checking on the hub: **Settings → Notifications**
has an on/off per alert, and a sensor left on **mock** data never raises one —
only real readings can.

**One phone gets nothing, others do.** It never registered: notification
permission was declined, or the build has no `google-services.json`. Sign out
and back in to retry, after checking the app's notification setting.

**Everything arrives twice.** Two accounts are signed in on two phones and both
are being told about a third person's change — that is working as intended.
Your own changes never come back to you.

**A phone that no longer exists.** Nothing to do: FCM reports the token as dead
on the next send and the hub deletes it. An uninstalled app cannot tell the hub
it is gone, so this is the only way the registry stays clean.
