# Recipe backups to Google Drive — one-time setup

Every night (and whenever somebody presses **Back up now** on the Recipes page)
BrewPlanner writes the whole recipe library to a JSON file. That file always
lands on the Pi. It is *also* uploaded to the shared Drive folder —
[recipe backups](https://drive.google.com/drive/folders/1wYK4s0UCvFI7rQF_WoqhD-Q6DSd03NUC) —
once the Pi has credentials for it.

**Nothing below is needed to have backups.** With no Google credentials at all
the nightly run still writes every recipe to `recipe-backups/` next to the
database, and the Recipes page says "local only". What Drive adds is a copy
that survives the SD card dying, which is the failure this is really for.

## What gets written

One file per backup, `brewplanner-recipes-2026-07-28T031500Z.json`, holding
every recipe exactly as the editor saves it — name, style, settings, grain
bill, hops, yeast, other ingredients, mash guidelines, water profile — plus the
id and dates it was stored under.

Prices, gram weights and costs are deliberately **not** in the file. They are
worked out from the shop catalogue every time a recipe is read, so putting them
in a backup would be recording this week's prices, not the recipe.

Restoring is a replay: `POST /api/recipes` with each `recipes[].recipe`.

Two knobs, both optional, in `/etc/brewplanner.env`:

```sh
RECIPE_BACKUP_DIR=/var/lib/brewplanner/recipe-backups   # default: beside the database
RECIPE_BACKUP_KEEP=30                                   # local files to keep; 0 keeps all
```

A nightly run whose contents are byte-for-byte identical to the last one is
skipped, so a quiet week leaves one backup rather than seven copies of it.
**Back up now** always writes one.

## Choosing how the Pi signs in

Two ways, and the difference matters — read this before creating anything.

### Option A — OAuth refresh token (works with the folder above)

A one-time consent in a browser as yourself. The backups are owned by, and
count against, your own Google account.

**This is the option that works with an ordinary Drive folder**, including the
one linked above.

1. Go to <https://console.cloud.google.com/apis/credentials>, create (or pick) a
   project, and enable the **Google Drive API** for it.
2. **Create credentials → OAuth client ID → Desktop app.** Note the client id
   and client secret.
3. Get a refresh token for the scope `https://www.googleapis.com/auth/drive`.
   The quickest route is the [OAuth playground](https://developers.google.com/oauthplayground):
   open the gear icon, tick *Use your own OAuth credentials*, paste the id and
   secret, authorise the Drive scope, then exchange the code for tokens.
   (Add `https://developers.google.com/oauthplayground` as an authorised
   redirect URI on the client first.)
4. Put all three in `/etc/brewplanner.env`:

   ```sh
   GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=…
   GOOGLE_OAUTH_REFRESH_TOKEN=1//…
   ```

5. `sudo systemctl restart checklist-server` and press **Back up now**.

A refresh token for an app still in "Testing" on the OAuth consent screen
expires after 7 days. Publish the consent screen (no verification is needed for
a private app using your own account) or expect to re-mint it.

### Option B — Service account (needs a Shared Drive)

A key file on the Pi and no consent screen ever again — but a service account
**has no Drive storage of its own**, so it cannot own files in a personal
Drive folder. Uploading to the folder linked above with a service account fails
with `storageQuotaExceeded`, and the Recipes page will say so.

It works when the destination is a **Shared Drive** (Google Workspace), where
the drive owns the files rather than the account that uploads them.

1. <https://console.cloud.google.com/apis/credentials> → enable the **Google
   Drive API** → **Create credentials → Service account**.
2. On the service account, **Keys → Add key → JSON**. Download it.
3. Copy the key to the Pi, readable only by the service user:

   ```sh
   sudo install -o brewplanner -g brewplanner -m 600 google-key.json \
     /etc/brewplanner-google.json
   ```

4. Share the target folder with the service account's `client_email` (it looks
   like `something@project.iam.gserviceaccount.com`), as **Content manager** or
   **Editor**.
5. In `/etc/brewplanner.env`:

   ```sh
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/etc/brewplanner-google.json
   ```

   (`GOOGLE_SERVICE_ACCOUNT_KEY` also works if you would rather paste the JSON
   itself than place a file.)

6. `sudo systemctl restart checklist-server` and press **Back up now**.

If both options are configured the refresh token is used — having gone to the
trouble of minting one is taken as the intent.

## Pointing at a different folder

The folder id is the last path segment of its Drive URL. Override it with:

```sh
GOOGLE_DRIVE_FOLDER_ID=1wYK4s0UCvFI7rQF_WoqhD-Q6DSd03NUC
```

## Checking it works

- The Recipes page carries a line under its heading: when the last backup ran,
  how many recipes it held, and — in amber — what went wrong if the Drive half
  failed.
- `journalctl -u checklist-server -f | grep -i backup` shows the nightly runs.
- `GET /api/recipes/backup` returns the same status as JSON.
