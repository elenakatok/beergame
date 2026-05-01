# How to Host the Beer Game on Firebase (Updated)

This guide is for the current codebase, which now includes:

- Firebase Authentication (instructor/admin login)
- Cloud Functions (session + player APIs, instructor approvals, email notifications)
- Firestore security rules + indexes
- Secret Manager values required by backend functions

If you only deploy Hosting, the app will not work correctly.

## 1. Prerequisites

- Google account
- Node.js **22** or newer (`node -v`)
- npm (`npm -v`)
- Firebase CLI (`firebase --version`)
- Git (recommended)
- SMTP2GO account + API key (for approval/rejection emails)

Install Firebase CLI if needed:

```bash
npm install -g firebase-tools
```

## 2. Get the code

```bash
git clone https://github.com/siemsene/beergame.git
cd beergame
```

Install dependencies (root + functions):

```bash
npm install
cd functions
npm install
cd ..
```

## 3. Create and configure your Firebase project

In [Firebase Console](https://console.firebase.google.com):

1. Create a new project.
2. Enable **Firestore Database**.
3. Enable **Authentication** and turn on `Email/Password` sign-in.
4. Add a **Web App** and copy firebase config values.
5. Enable **App Check** for your web app and create a reCAPTCHA v3 site key.

Notes:

- Because this app uses Cloud Functions + scheduled cleanup, use **Blaze** billing plan.
- Scheduled function: hourly session cleanup.

## 4. Configure local environment (`.env`)

Create a root `.env` file:

```env
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_auth_domain
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_storage_bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_FIREBASE_MEASUREMENT_ID=your_measurement_id
VITE_RECAPTCHA_SITE_KEY=your_recaptcha_v3_site_key
```

Do not commit `.env`.

## 5. Connect repo to your Firebase project

```bash
firebase login
firebase use --add
```

Select your project and set it as default for this repo.

## 6. Configure backend secrets (required)

Functions require these secrets:

- `SMTP2GO_API_KEY`
- `MAIL_FROM` (example: `Beer Game <noreply@yourdomain.com>`)
- `ADMIN_EMAIL` (your admin login email)
- `APP_BASE_URL` (example: `https://your-project-id.web.app`)

Set them interactively (masked input):

```bash
firebase functions:secrets:set SMTP2GO_API_KEY
firebase functions:secrets:set MAIL_FROM
firebase functions:secrets:set ADMIN_EMAIL
firebase functions:secrets:set APP_BASE_URL
```

Optional verification:

```bash
firebase functions:secrets:access ADMIN_EMAIL
```

## 7. Build checks before deploy

```bash
npm run build
cd functions
npm run build
cd ..
```

If you see warnings about runtime/deps, use Node 22 and keep `firebase-functions` / `firebase-admin` up to date.

## 8. Deploy Firestore rules and indexes

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

(Equivalent single command: `firebase deploy --only firestore`)

## 9. Deploy Functions and Hosting

```bash
firebase deploy --only functions
firebase deploy --only hosting
```

Or deploy all at once:

```bash
firebase deploy
```

## 10. First-run bootstrap (important)

1. Open your deployed site.
2. Use **Instructor / Admin**.
3. Register/sign in with the same email you set in `ADMIN_EMAIL`.
4. The app auto-bootstraps this account as approved admin.

After that, admin can approve/reject instructors and monitor usage.

## 11. Quick smoke test checklist

1. Register a new instructor account.
2. Confirm admin receives SMTP2GO notification email.
3. Approve the instructor in Admin Dashboard.
4. Instructor logs in and creates a session.
5. Student joins with session code + name.
6. Try duplicate name in same session (should be blocked).
7. In lobby, confirm online/offline status updates.
8. Start game and verify order progress meter + blink behavior.
9. Disconnect network briefly and confirm reconnect overlay appears.

## 12. Updating later

When you pull new code:

```bash
npm install
cd functions
npm install
npm run build
cd ..
npm run build
firebase deploy
```

## 13. Billing kill switch (recommended)

A safety net against a runaway bill (compromised key, abuse, bug). When your monthly cost crosses a budget you set, GCP publishes to a Pub/Sub topic, the `billingKillSwitch` Cloud Function listens, and it detaches the billing account from the project — which immediately stops all paid services. The function is idempotent and ignores forecast-only alerts; it only fires on actual cost overruns.

### One-time setup in GCP Console

1. Enable APIs (one-time per project):
   - **Cloud Billing API**
   - **Cloud Pub/Sub API**
2. Create a Pub/Sub topic named **`billing-kill-switch`** (Cloud Console → Pub/Sub → Topics → Create).
3. Cloud Console → **Billing → Budgets & alerts → Create budget**:
   - Scope it to this project.
   - Set thresholds (e.g., 50%, 90%, 100% of monthly target).
   - Under "Manage notifications" toggle **Connect a Pub/Sub topic to this budget** and select `billing-kill-switch`.
4. Grant the Cloud Functions runtime service account permission to disable billing. By default that SA is `<PROJECT_ID>-compute@developer.gserviceaccount.com`. On the **billing account** (Billing → Account management → Permissions → Add principal) grant role **Billing Account Administrator** (`roles/billing.admin`) — or the narrower **Project Billing Manager** (`roles/billing.projectManager`) if you only want it to be able to detach billing from this one project. Without this role the function will fail with `PERMISSION_DENIED` and billing will stay on.
5. Deploy the function:

   ```bash
   firebase deploy --only functions:billingKillSwitch
   ```

### Verify

- From Cloud Console → Pub/Sub → `billing-kill-switch` → "Messages" tab → publish a test message with body `{"costAmount": 1, "budgetAmount": 100}`. Expected log: "Budget alert received but actual cost is within budget" — function exits without disabling.
- Optionally, on a sandbox project only, publish `{"costAmount": 200, "budgetAmount": 100}` and confirm billing is disabled. **Do not run this test on your live project unless you intend to manually re-enable billing afterward** (Billing → Account management → Link a billing account).

### Re-enabling after a real fire

If the kill switch fires on production, the project is salvageable:

1. Investigate the cause in Cloud Logging (`severity=ERROR`).
2. Cloud Console → Billing → Account management → **Link a billing account** to re-attach billing.
3. Functions, Firestore, and Hosting resume on the next request — no redeploy needed.

## Troubleshooting

### "permission-denied" errors in app

Usually means one of:

- Firestore rules not deployed
- Instructor not approved yet
- Admin email mismatch with `ADMIN_EMAIL`

### Function email not sent

Check:

- SMTP2GO API key is valid
- `MAIL_FROM` uses a sender accepted by SMTP2GO
- Functions logs:

```bash
firebase functions:log
```

### Runtime warning about Node 20 deprecation

Set `functions/package.json` engines to Node 22 and redeploy.

### Missing indexes error

Deploy indexes:

```bash
firebase deploy --only firestore:indexes
```

---

If you follow all sections above (including secrets + functions), you will have a fully working self-hosted instance of the current Beer Game.
