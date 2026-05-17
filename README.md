# CHRIS Website - Windows Server Deployment

This website is currently a static HTML/JS site with local authentication.
The project now includes a minimal Node.js backend for Google authentication and a path toward future database integration.

## Railway deployment

Railway can deploy this project as a Node.js app. The repository includes `railway.json`, and Railway will run:

```text
npm start
```

For a persistent production deployment, add a MySQL database service in Railway or provide external MySQL credentials. Then set these variables in the Railway service:

```text
NODE_ENV=production
USE_MYSQL=true
REQUIRE_MYSQL=true
DB_HOST=your-mysql-host
DB_PORT=3306
DB_USER=your_mysql_user
DB_PASSWORD=your_mysql_password
DB_NAME=chris_website
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-a-strong-admin-password
SESSION_SECRET=replace-with-a-long-random-secret
MFA_CHALLENGE_SECRET=replace-with-a-long-random-secret
MFA_ISSUER=CHRIS
ENABLE_GOOGLE_AUTH=false
GOOGLE_CLIENT_ID=your-google-web-client-id.apps.googleusercontent.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
SMTP_FROM="CHRIS <no-reply@example.com>"
EMAIL_MFA_DEV_MODE=false
```

For a quick deployment without MySQL, set `USE_MYSQL=false` and omit `REQUIRE_MYSQL`. The app will start with the local JSON store, but Railway redeploys or container restarts can lose that data, so use MySQL before relying on the site for real records.

Do not set `PORT` on Railway. Railway provides it automatically, and the backend binds to that assigned port.

If you enable Google login, add your Railway public URL to the Google OAuth Authorized JavaScript origins.

## What was added

- `server.js` — lightweight Express server that serves the site and verifies Google Sign-In tokens.
- `package.json` — Node dependencies and start script.
- `data/users.json` — initial local user store for prototype users.
- `config.js` — client-side configuration file for the Google client ID.

## Setup for Windows Server 2022

1. Install Node.js on the server (Node 18+ recommended).
2. Copy the project folder to the server.
3. Open PowerShell in the project root and run:

   ```powershell
   npm install
   ```

4. Create a `.env` file in the project root or set environment variables directly.

   Copy `.env.example` to `.env` and update the values, or set these values in PowerShell:

   ```powershell
   $env:GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID'
   $env:ENABLE_GOOGLE_AUTH = 'false'
   $env:USE_MYSQL = 'false'
   $env:DB_HOST = 'localhost'
   $env:DB_PORT = '3306'
   $env:DB_USER = 'your_mysql_user'
   $env:DB_PASSWORD = 'your_mysql_password'
   $env:DB_NAME = 'chris_website'
   $env:SMTP_HOST = 'smtp.example.com'
   $env:SMTP_PORT = '587'
   $env:SMTP_SECURE = 'false'
   $env:SMTP_USER = 'your_smtp_user'
   $env:SMTP_PASS = 'your_smtp_password'
   $env:SMTP_FROM = 'CHRIS <no-reply@example.com>'
   $env:EMAIL_MFA_DEV_MODE = 'true'
   ```

5. Create the MySQL database and users table using `db-schema.sql`:

   ```powershell
   mysql -u your_mysql_user -p < db-schema.sql
   ```

6. Start the backend:

   ```powershell
   npm start
   ```

The backend exposes `/config.js` dynamically, so `login.html` will load the correct Google client ID when the server is running.

7. Open the site in a browser at:

   ```text
   http://localhost:3000/login.html
   ```

Use the port printed by `npm start` if you change `PORT` or if another app is already using the default port.

## Google account login setup

The login page includes a Google account option. It appears when `GOOGLE_CLIENT_ID` is set to a real Google OAuth web client ID, `ENABLE_GOOGLE_AUTH=true`, and the site is served by the Node backend.

1. Open Google Cloud Console.
2. Create or select a project.
3. Go to APIs & Services > Credentials.
4. Create an OAuth client ID with application type `Web application`.
5. Add your site URL to Authorized JavaScript origins, for example:

   ```text
   http://localhost:3000
   ```

   If you change `PORT`, use that exact port here.

6. Copy the OAuth client ID into `.env`:

   ```text
   GOOGLE_CLIENT_ID=your-google-web-client-id.apps.googleusercontent.com
   ENABLE_GOOGLE_AUTH=true
   ```

7. Restart the backend.

The backend verifies Google ID tokens at `/api/auth/google`. New Google users are created automatically, then they complete the same MFA setup/verification flow before entering the dashboard.

## Email MFA setup

The login page lets users choose an authenticator app or email code for MFA. Email codes require SMTP settings in `.env`:

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
SMTP_FROM="CHRIS <no-reply@example.com>"
EMAIL_MFA_DEV_MODE=true
```

Use `SMTP_SECURE=true` for SMTPS ports such as `465`; use `false` for STARTTLS ports such as `587`.
When SMTP is not configured and `EMAIL_MFA_DEV_MODE=true`, the MFA code is printed in the server console for local testing.

## Current database integration

The backend can store data in MySQL using `mysql2`, or in `data/local-db.json` for local development.
The app loads environment variables from `.env` via `dotenv`, but you can also set them directly in Windows Server.

- Set `USE_MYSQL=false` to use the local JSON fallback store.
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` are required for MySQL.
- `GOOGLE_CLIENT_ID` and `ENABLE_GOOGLE_AUTH=true` are required for Google account login.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are required for email MFA.
- `EMAIL_MFA_DEV_MODE=true` lets local development continue by printing the email MFA code in the server console when SMTP is not configured.
- The database schema is provided in `db-schema.sql`.

## Future data improvements

- store other app data such as leaves, trainings, attendance, and announcements in database tables
- add server-side sessions or JWTs instead of browser-only session storage
- secure the app with HTTPS in production

## Notes

- This is a prototype backend for authentication only.
- The current site still uses local session tracking in the browser.
- For production, use a real database and secure session/cookie handling.
- On Windows Server, set a fixed `PORT`, keep it free, and run the app as a Windows service or scheduled task so it restarts automatically after reboots.
