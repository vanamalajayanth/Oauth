# OAuth Demo Repository

## Overview

This repository is a small demo app that uses Hono and Deno to implement authentication via GitHub OAuth. The app authenticates the user with GitHub, receives an OAuth access token, fetches GitHub profile data, and then issues a local JWT session token for protected app routes.

## Why OAuth was added

The repo started as a session-based authentication app (`session-auth-app`). OAuth was introduced to allow users to sign in using GitHub instead of local credentials only. That meant:

- letting the user authenticate with GitHub credentials
- exchanging the GitHub authorization code for an access token
- fetching user profile and email data from GitHub
- creating a local JWT session token after GitHub login

Using OAuth made the app more realistic for modern web authentication flows and removed the need to store or manage passwords inside this demo.

## Key files

- `server.js` - the main server application. It configures OAuth, handles login and callback routes, verifies JWTs, and serves the public UI.
- `package.json` - project metadata and dependency references.
- `creds` - local credentials fallback file used for `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `JWT_SECRET` when env vars are not set.
- `public/login.html` - login page presented to the user.
- `public/dashboard.html` - protected dashboard shown after successful authentication.

## OAuth implementation details

### 1. Configuration

The app reads required values from environment variables or `creds`:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `BASE_URL` (defaults to `http://localhost:3000`)
- `JWT_SECRET`

If GitHub credentials are missing, the app will not start the GitHub auth flow.

### 2. Starting GitHub OAuth

The route `/auth/github` begins the OAuth process:

- generates a random `state` value
- stores it in an HTTP-only cookie called `oauth_state`
- redirects the browser to GitHub's authorization page with the required query parameters

### 3. OAuth callback handling

GitHub redirects back to `/auth/github/callback` with `code` and `state`.

The app then:

- validates the returned `state` against the stored cookie
- exchanges the authorization code for an access token at GitHub's token endpoint
- fetches user profile information from GitHub
- fetches the verified email address if needed

### 4. Creating a local session token

Once GitHub user data is retrieved, the server constructs a JWT payload with:

- `username`
- `fullName`
- `email`
- `role`
- `picture`

The JWT is signed with `JWT_SECRET`, then stored in an HTTP-only cookie named `token`.

### 5. Protecting routes

Protected routes like `/dashboard.html` and `/api/user` require a valid JWT.

The server verifies the token by:

- reading the token from the `Authorization` header or the `token` cookie
- validating the signature
- checking expiration

If the token is invalid or expired, the request is rejected with `401` or redirected to `/login.html`.

### 6. Logout

The `/logout` route clears the `token` cookie and redirects back to `/login.html`.

## Running the app

1. Install Deno if not already installed.
2. Create a `creds` file or export env vars:

```bash
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
JWT_SECRET=change-me
BASE_URL=http://localhost:3000
```

3. Run the app:

```bash
denon run --allow-net --allow-read server.js
```

4. Open `http://localhost:3000` and use the GitHub login flow.

## Notes

- The JWT expiration is intentionally short in this demo (`60` seconds).
- Cookies are set as HTTP-only for security, but not flagged `secure` in local development.
- The repository demonstrates how OAuth can be integrated with a simple local session layer.
