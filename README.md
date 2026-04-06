# Sui zkLogin Wallet Starter

This project is a basic Sui web app that lets a user:

1. Click Log in with Google.
2. Create or restore a zkLogin wallet on Sui testnet.
3. View the wallet address and token balances.
4. Log out from the dApp session.

The app uses:

- React + Vite
- `@mysten/dapp-kit-react` for wallet integration
- `@mysten/enoki` for Google OAuth-backed zkLogin wallet registration
- `@mysten/sui` for balance reads on Sui testnet

## Prerequisites

- Node.js 20+
- npm 10+
- A Google Cloud project with an OAuth 2.0 Web Client
- An Enoki app and public API key

## Required setup

### 1. Create a Google OAuth client

In Google Cloud Console:

1. Create or select a project.
2. Configure the OAuth consent screen.
3. Create an OAuth 2.0 Client ID of type Web application.
4. Add your local and production URLs to Authorized JavaScript origins.
5. Add matching redirect URLs to Authorized redirect URIs.

For local development with Vite, use at least:

- Authorized JavaScript origin: `http://localhost:5173`
- Authorized redirect URI: `http://localhost:5173/`

The redirect URI must match exactly. For this app, the local redirect URI includes the trailing slash.

If you host the app elsewhere, add:

- the site origin to Authorized JavaScript origins, for example `https://your-app.example`
- the exact app URL to Authorized redirect URIs, for example `https://your-app.example/`

If you deploy under a subpath, the redirect URI must include that full path, for example `https://your-app.example/sui-wallet-login/`.

### 2. Create an Enoki app

In the Enoki portal:

1. Create an app.
2. Add your local and production origins to the allow list.
3. Open Auth providers.
4. Enable Google.
5. Paste the same Google OAuth Client ID you created in Google Cloud.
6. Copy the public API key.

The Google Client ID configured in Enoki must match `VITE_GOOGLE_CLIENT_ID` in your local `.env` file.

This starter uses Enoki for the zkLogin nonce and salt flow, which keeps the app simple and avoids building your own salt service for the basic onboarding case.

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Variables:

- `VITE_ENOKI_API_KEY`: Your Enoki public API key
- `VITE_GOOGLE_CLIENT_ID`: Your Google OAuth web client ID

## Install

```bash
npm install
```

## Run locally

```bash
npm run dev
```

Open the local URL Vite prints, usually `http://localhost:5173`.

## How the login flow works

1. The app registers an Enoki Google wallet provider against Sui testnet.
2. The app sends Google back to the exact current app URL as the OAuth redirect URI.
3. The user clicks Log in with Google.
4. Enoki starts the zkLogin-compatible Google OAuth flow.
5. After success, the app receives a zkLogin wallet account derived from the Google identity and Enoki-managed salt.
6. The app loads balances for that Sui address from testnet.

## How logout works

The Log out button disconnects the Enoki wallet from the dApp and clears the local wallet session state.

This does not guarantee a global Google sign-out. It is a dApp session logout.

## Troubleshooting sign-in

If Google sign-in completes but the app still stays on Waiting, check these first:

1. Google OAuth settings must exactly match local dev:
   - Authorized JavaScript origin: `http://localhost:5173`
   - Authorized redirect URI: `http://localhost:5173/`
2. Your Enoki app must allow the local origin `http://localhost:5173`.
3. The `VITE_GOOGLE_CLIENT_ID` in your `.env` must be the same OAuth client you configured in Google Cloud.
4. Restart `npm run dev` after changing `.env` values.
5. Open the browser console if the app shows a login error after the popup closes.

If Vite runs on a different port, replace `5173` with the exact port shown in your terminal in both Google Cloud and the Enoki allow list.

## Funding the wallet on testnet

The first login creates the wallet address, but it will usually have zero balance.

To test balances:

1. Copy the wallet address shown in the app.
2. Send testnet tokens to it from another wallet or a faucet workflow you already use.
3. Click Refresh balances.

## Project structure

- `src/dapp-kit.ts`: Sui testnet dApp Kit client setup
- `src/RegisterEnokiWallets.tsx`: Google Enoki wallet registration hook-up
- `src/App.tsx`: Login, logout, address display, balance loading UI
- `src/index.css`: Global theme and layout foundation
- `src/App.css`: Page-specific styling

## Notes for developers

- The app is intentionally read-only for now. It creates/restores a zkLogin wallet and displays balances, but does not submit transactions.
- If you later want to add sends or sponsored transactions, keep using Enoki so the proof flow stays aligned with the wallet session.
- The default network is Sui testnet.

## Scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
```
