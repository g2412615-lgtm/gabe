# Putting KWE Blueprints online

KWE Blueprints runs on Fly.io, like DeployMap, at
**https://blueprints.gabeweb.com**. It's one small machine with one storage
volume, which holds the database, your uploaded blueprints and the page
images. It "suspends" when nobody is using it, so it costs very little, and
wakes in about a second when you open it.

In GitHub's **Actions** tab the two workflows are **KWE Blueprints — deploy** and **KWE Blueprints — checks** (earlier runs show them under their first name, Blueprint Notes).

You only do the setup below once. After that, every change merged into the
repository's main branch goes online by itself.

Never paste passwords or tokens into a chat, including with Claude. Type
them straight into the Fly.io, GitHub or Cloudflare pages below.

---

## One-time setup (about 15 minutes, all in the browser)

### 1. Make a Fly.io token

1. Sign in at https://fly.io/dashboard.
2. Open **Tokens**, under your organization's settings in the left menu.
3. Create an **organization token**. A name like `github-blueprints` works. Don't pick an app "deploy token": that kind only works for an app that already exists.
4. Copy the token. You'll paste it into GitHub in the next step.
5. The deploy works out which Fly organization to use from the token itself. You only need its short name if the token can see more than one organization; step 2 explains.

### 2. Give the token and your password to GitHub

1. Open the repository on GitHub and go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret** and add:
   - **Name** `FLY_API_TOKEN`, **Secret**: the Fly.io token from step 1.
3. Click **New repository secret** again and add:
   - **Name** `BLUEPRINTS_PASSWORD`, **Secret**: the password you want to sign in with.
   - Make it long, at least 12 characters.
   - You'll type it once on each device. The iPad and the computer then stay signed in for up to a year while you keep using them.
4. Usually nothing else is needed. If the first deploy stops with "Couldn't tell which Fly organization to use", it lists the organizations your token can see. Then:
   1. Open the **Variables** tab on the same page, not Secrets.
   2. Add a repository variable **Name** `FLY_ORG` whose **Value** is the one you want.

### 3. Run the first deploy

1. In the repository, open the **Actions** tab.
2. Choose **KWE Blueprints — deploy** on the left.
3. Click **Run workflow** and tick **First-time setup**.
4. Click the green **Run workflow** button.

The run takes about 5 minutes. It creates the Fly app `gabeweb-blueprints` and its 10 GB storage, sets the password, builds and starts the app, and asks Fly for a certificate for `blueprints.gabeweb.com`.

If **Run workflow** doesn't show up, the change that adds it hasn't been merged into the main branch yet. Merge the pull request first.

Merging before this step is fine. The automatic run the merge starts just notes that the app doesn't exist yet, and stops without failing.

### 4. Point the address at the app (Cloudflare)

1. Sign in to Cloudflare, open **gabeweb.com**, then **DNS → Records → Add record**:
   - **Type** `CNAME`
   - **Name** `blueprints`
   - **Target** `gabeweb-blueprints.fly.dev`
   - **Proxy status** **DNS only** (grey cloud). Fly makes and serves the certificate itself.
2. Save.

Within about 10 minutes **https://blueprints.gabeweb.com** opens the sign-in page. Until then the app also answers at https://gabeweb-blueprints.fly.dev.

### 5. Put it on the iPad's home screen (optional, recommended)

1. On the iPad, open https://blueprints.gabeweb.com in Safari and sign in.
2. Tap **Share → Add to Home Screen**.

It then opens full screen like an app, without Safari's address bar.

---

## Day to day

- **Updates:** anything merged into the main branch under `blueprints/` deploys by itself. Watch it in **Actions → KWE Blueprints — deploy**. If the main branch has no changes to the app, nothing happens.
- **Change the password, or sign out a lost device:**
  1. Update the `BLUEPRINTS_PASSWORD` secret on GitHub.
  2. Run **KWE Blueprints — deploy** by hand. Leave "First-time setup" unticked.

  Changing the password signs out every device, so a lost iPad loses access. Then sign in again on the devices you still have.
- **Check it's up:** https://blueprints.gabeweb.com/api/health should show `"ok":true`.

## If the storage fills up

The app warns before it's full. It turns down new uploads with "The app's storage is full…", and https://blueprints.gabeweb.com/api/health shows `"storage":"full"`. Ten gigabytes holds a lot of blueprints. To add more, on a computer with the Fly command line:

```bash
fly volumes list -a gabeweb-blueprints
fly volumes extend <the volume id from the list> -s 20 -a gabeweb-blueprints
```

Then press **Retry** on any page that couldn't be prepared.

## Backups

- **Daily snapshots:** the app keeps a snapshot of its database once a day, the newest 14, on its storage. Fly also snapshots the whole storage volume daily.
- **Before an update changes the database:** when a new version needs to add something to the database, it first saves a full copy of it as it was (`backups/app-before-schema-…db`), kept for good. Updates only ever add; they never delete or change your pages, circles or comments.
- **Off-site copy to Cloudflare R2 (optional):** this is the same setup DeployMap uses.
  1. Create an R2 API token with "Object Read & Write" on your bucket.
  2. On a computer with the Fly command line installed, run:

     ```bash
     fly secrets set -a gabeweb-blueprints R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com R2_BUCKET=<bucket>
     ```

  Uploads and database snapshots are then copied every 30 minutes under `blueprints/` in the bucket, and kept 30 days.

---

## Alternative: deploy from the Mac

If you'd rather deploy from the Mac the way DeployMap is deployed:

1. Clone the repository outside iCloud Drive.
2. Open Terminal in its `blueprints` folder.
3. Run these commands. Each `fly` command names the app explicitly.

```bash
fly auth whoami
fly apps create gabeweb-blueprints
fly volumes create data --size 10 --region dfw -a gabeweb-blueprints
fly secrets set -a gabeweb-blueprints APP_PASSWORD='the-password-you-want'
fly deploy -a gabeweb-blueprints --remote-only --ha=false
fly certs add blueprints.gabeweb.com -a gabeweb-blueprints
```

Then add the Cloudflare record from step 4.

Later updates are just the `fly deploy` line.

`--ha=false` matters: it keeps the app on one machine. Its data lives on one volume, so a second machine would split it.
