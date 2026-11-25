# Apaaman

Apaaman is a community web app for messaging, local marketplace listings, and ride requests or offers.

## Requirements

- Node.js 22.13 or newer

## Run locally

```powershell
npm install
npm start
```

Open http://localhost:3000.

## Admin setup

On a new installation, optionally set `APAAMAN_ADMIN_PHONE` and `APAAMAN_ADMIN_PIN` before starting the server to create or update an admin account. The PIN must be 4–6 digits. Keep these values private; do not commit them to the repository.

The SQLite database and uploaded images are stored locally in `data/` and `uploads/`. Back them up, and use persistent storage when deploying. Set `APAAMAN_STORAGE_DIR` to the mounted disk's path to keep both directories on that disk.

## SMS PIN recovery

The login screen provides PIN recovery by SMS. To enable it, configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID` as private environment variables in Render. Never commit these values. Recovery phone numbers must be in international `+` format and match the number saved on the account.

## Deploy to Render

The root `render.yaml` configures a Node web service in Frankfurt with a 1 GB persistent disk for the database and uploaded photos. Create a Blueprint in Render from this repository and review the service and disk charges before applying it. Set any admin bootstrap credentials in Render's private environment settings, not in this repository.

## Install on mobile

Deploy behind HTTPS, then open the site on your phone. On Android, choose **Install app** from the app screen or browser menu. On iPhone or iPad, use **Share → Add to Home Screen** in Safari. The installed app uses the same site, account, and server data.
