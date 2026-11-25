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

## Community sections

The Dashboard links to Education, Jobs, Health, and News. Administrators curate Education and Health resources; signed-in members can post job openings and community updates. Resource links must use HTTPS. Members can remove their own posts, and administrators can remove any post.

## Admin-assisted PIN recovery

Users who forget their PIN must contact a community administrator through a trusted channel. The administrator can search for the account and issue a random temporary PIN; the user must change it before accessing the app. Administrators should independently verify the account holder before resetting a PIN and share temporary PINs privately.

To enable the admin tools on Render, set `APAAMAN_ADMIN_PHONE` and `APAAMAN_ADMIN_PIN` as private environment variables. Use a phone number and a 4–6 digit PIN that only the administrator knows. The account is created or promoted to administrator when the server starts. Never commit these values or share them in chat.

## Deploy to Render

The root `render.yaml` configures a Node web service in Frankfurt with a 1 GB persistent disk for the database and uploaded photos. Create a Blueprint in Render from this repository and review the service and disk charges before applying it. Set any admin bootstrap credentials in Render's private environment settings, not in this repository.

## Install on mobile

Deploy behind HTTPS, then open the site on your phone. On Android, choose **Install app** from the app screen or browser menu. On iPhone or iPad, use **Share → Add to Home Screen** in Safari. The installed app uses the same site, account, and server data.

The Rides page opens on live OpenStreetMap tiles centered on Apam when online; the bundled offline map remains available with **Offline map**. The place-search bar remains visible in either map mode, though searches require an internet connection. Search for places in Ghana or tap **My location** to request location access. Online map tiles and searches are not cached for offline use. A place-search query is sent to OpenStreetMap's Nominatim service. Location is requested only after you tap **My location**; Apaaman does not send or save your coordinates, but OpenStreetMap can infer the approximate area you view from its tile requests. Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL) 1.0.

Riders can post pickup and destination requests, while drivers can search open ride requests and accept them. Riders can also search driver offers by route and request a match. Both sides can see the matched status and update the trip status; the app does not provide live driver tracking or payments.
