# Walrus Vault

Walrus Vault is a zkLogin-enabled Sui app that lets a user:

1. Sign in with Google through Enoki.
2. Create named Seal whitelists in the UI.
3. Upload files to Walrus either as plain blobs or encrypted blobs.
4. Attach encrypted uploads to a selected whitelist.
5. Manage whitelist members on Sui.
6. Download files, automatically decrypting encrypted files when the connected wallet has access.

The app uses local storage for dashboard metadata and list names, Sui for access control, Seal for key release, and Walrus for file bytes.

## Architecture

| Layer         | Purpose                | Stored data                                                           |
| :------------ | :--------------------- | :-------------------------------------------------------------------- |
| Local storage | Dashboard memory       | File name, blob ID, key ID, whitelist name, whitelist members, cap ID |
| Sui           | Access control         | Shared Whitelist object and owner Cap object                          |
| Seal          | Encryption key service | Key shares gated by `seal_approve`                                    |
| Walrus        | Blob storage           | Plain bytes or encrypted bytes                                        |

## Current UX

### Whitelists

Whitelists are created explicitly in the UI.

- Each whitelist has a local display name.
- Each whitelist maps to one shared `Whitelist` object and one owned `Cap` object on Sui.
- The creator is added to the whitelist automatically on-chain during creation.
- Members can be added or removed from the list in the UI.

### Uploads

Uploads support two modes:

- Plain upload: the file is uploaded directly to Walrus.
- Encrypted upload: the browser encrypts the file with Seal and requires you to choose a whitelist first.

For encrypted uploads, local storage keeps the file metadata needed by the owner UI:

- `fileName`
- `blobId`
- `keyId`
- `whitelistId`
- `whitelistName`
- `whitelistCapId`
- `packageId`
- `uploadedAt`

### Downloads

- Plain files download directly from Walrus.
- Encrypted files build a whitelist `seal_approve` PTB, request the key from Seal, decrypt in the browser, and then download.

### Shared access

There is no shared backend database.

To share an encrypted file, the owner:

1. Adds the recipient to the chosen whitelist on Sui.
2. Sends the `blobId` and `keyId` to the recipient out-of-band.

The recipient can use the Open Shared File section in the UI. Seal checks Sui access at decrypt time.

## Project structure

- `src/App.tsx`: main UI flow for login, whitelist creation, upload, download, and sharing.
- `src/localWalrusMetadata.ts`: local storage model for files, deleted entries, and named whitelists.
- `src/seal.ts`: reusable Seal client helpers.
- `src/walrus.ts`: Walrus helpers and blob parsing.
- `move/walrus_vault_policy/sources/whitelist.move`: Seal allowlist policy contract.

## Environment variables

Create a `.env` file in the project root.

```env
VITE_ENOKI_API_KEY=your_enoki_api_key
VITE_GOOGLE_CLIENT_ID=your_google_oauth_client_id
VITE_SEAL_POLICY_PACKAGE_ID=0x_your_published_move_package
```

`VITE_SEAL_POLICY_PACKAGE_ID` is required for whitelist creation and encrypted uploads.

## Local development

Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

Build and lint:

```bash
npm run lint
npm run build
```

## Move contract

The whitelist policy package lives in:

`move/walrus_vault_policy`

It exposes these main entry points:

- `create_whitelist_entry`
- `add_member`
- `remove_member`
- `seal_approve`

The contract follows the Seal allowlist pattern:

- one shared whitelist object defines access
- the owner keeps a capability object
- encrypted file key IDs are prefixed with the whitelist object ID
- Seal approval succeeds only for addresses currently in the whitelist

## Deploying the Move package to Sui testnet

### Prerequisites

You need:

- Sui CLI installed
- a testnet account selected in the CLI
- enough testnet SUI for publish gas

Check that the CLI exists:

```bash
sui --version
```

### 1. Configure the CLI for testnet

List environments:

```bash
sui client envs
```

Switch to testnet if needed:

```bash
sui client switch --env testnet
```

Check the active address:

```bash
sui client active-address
```

### 2. Build the package

```bash
cd move/walrus_vault_policy
sui move build
```

### 3. Publish the package

From the same folder:

```bash
sui client publish --gas-budget 100000000
```

After publish, note the package ID from the output.

### 4. Configure the frontend

Set the published package ID in `.env`:

```env
VITE_SEAL_POLICY_PACKAGE_ID=0x...
```

Restart the Vite dev server after changing `.env`.

## How the whitelist flow works

### Create a list

1. Enter a whitelist name in the UI.
2. The app calls `create_whitelist_entry`.
3. The shared `Whitelist` ID and owned `Cap` ID are read from the transaction result.
4. The list is saved in local storage under the connected wallet.
5. The creator remains on the whitelist by default.

### Add or remove members

1. Open the Whitelists section.
2. Add a wallet address to a named list.
3. The app sends `add_member` or `remove_member` on Sui.
4. Local storage is updated to mirror the current list membership for the dashboard.

### Upload an encrypted file

1. Toggle Encrypt with Seal.
2. Choose a whitelist.
3. The app generates a `keyId` using `[whitelist_id][random_nonce]`.
4. The file is encrypted in the browser with Seal.
5. Ciphertext is uploaded to Walrus.
6. The file row is stored locally with its `keyId` and linked whitelist metadata.

### Download an encrypted file

1. Click the download button on an encrypted file.
2. The app builds a `seal_approve` PTB for the linked whitelist.
3. Seal verifies the connected address against Sui.
4. If approved, the app decrypts in-browser and downloads the plaintext.

## Local storage notes

The dashboard is intentionally local-first.

- Clearing browser storage removes the local file and whitelist labels.
- Walrus blobs are still on Walrus.
- Whitelist access control is still on Sui.
- If local metadata is lost, encrypted files still require the `keyId` to decrypt.

## Notes

- The app still uses Sui ownership to discover Walrus blob objects.
- File metadata is no longer read from Sui blob attributes.
- The Vite production build currently emits a large bundle warning, but the build completes successfully.

This is the actual user flow in this project:

1. The page loads and mounts the dApp Kit provider.
2. The app registers the Enoki Google wallet using the API key and Google client ID.
3. The user clicks `Log in with Google`.
4. dApp Kit asks the selected Enoki wallet to connect.
5. Enoki opens the Google OAuth popup.
6. Google authenticates the user and returns control to the redirect URL.
7. Enoki uses the login result to resolve the user's zkLogin wallet.
8. dApp Kit exposes the connected Sui account to the React app.
9. The app loads token balances and Walrus Blob objects for that address.

## What logout means in this app

Logout in this app means disconnecting the current Enoki wallet session from the dApp.

It does not necessarily mean:

- the user is globally signed out of Google
- all browser-level authentication state is cleared

It means the dApp is no longer treating the wallet as the active connected account.

## Setup guide

## 1. Prerequisites

You need:

- Node.js 20+
- npm 10+
- a Google Cloud project
- a Google OAuth 2.0 Web Client ID
- an Enoki app
- an Enoki public API key

## 2. Google Cloud configuration

In Google Cloud Console:

1. Create or choose a project.
2. Configure the OAuth consent screen.
3. Create an OAuth 2.0 Client ID of type `Web application`.
4. Add the frontend origin to `Authorized JavaScript origins`.
5. Add the exact redirect URL to `Authorized redirect URIs`.

For local development with Vite, use:

- Authorized JavaScript origin: `http://localhost:5173`
- Authorized redirect URI: `http://localhost:5173/`

The trailing slash matters because the app uses the exact browser URL as the redirect target.

If you run Vite on another port, replace `5173` with the actual port.

## 3. Enoki configuration

In the Enoki portal:

1. Create an app.
2. Add `http://localhost:5173` to the allowed origins list.
3. Open `Auth providers`.
4. Enable `Google`.
5. Paste the same Google OAuth Client ID you created in Google Cloud.
6. Ensure the app supports `testnet`, since this project uses testnet.
7. Copy the public API key for that app.

The key point is that the Google client ID must match in all three places:

- Google Cloud
- Enoki Auth provider configuration
- `.env` as `VITE_GOOGLE_CLIENT_ID`

## 4. Local environment variables

Copy the example file:

```bash
cp .env.example .env
```

Then set:

```dotenv
VITE_ENOKI_API_KEY=your_enoki_public_api_key
VITE_GOOGLE_CLIENT_ID=your_google_oauth_web_client_id
VITE_WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
VITE_WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
```

Do not put a Google client secret into the frontend `.env`. Vite exposes `VITE_*` variables to the browser.

The Walrus URLs are optional. If omitted, the app uses the testnet defaults shown above.

## 5. Install and run

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Build the project:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Repository walkthrough

### `src/main.tsx`

Bootstraps the React app and wraps it with:

- `QueryClientProvider` for React Query
- `DAppKitProvider` for Sui wallet state
- `RegisterEnokiWallets` so the Google wallet is available before the app renders

### `src/dapp-kit.ts`

Creates the dApp Kit instance and pins the app to Sui testnet.

### `src/RegisterEnokiWallets.tsx`

Registers the Google Enoki wallet and supplies:

- the Enoki public API key
- the Google client ID
- the redirect URL
- the active Sui client and network

### `src/App.tsx`

Contains the app's main business logic:

- login button
- logout button
- account display
- error display for auth failures
- balance fetching and formatting
- Walrus file upload form
- Walrus metadata write after upload
- Walrus owned-file listing
- Walrus download logic with MIME sniffing and extension recovery

### `src/walrus.ts`

Contains Walrus-specific helpers:

- default publisher and aggregator URLs
- blob ID normalization from raw decimal u256 to base64url
- blob attribute helpers for file name and content type
- raw Sui object parsing fallback for Walrus blob objects
- Walrus blob formatting helpers

### `src/index.css` and `src/App.css`

Contain the global and page-level styling for the app.

## Why this project uses Enoki instead of raw zkLogin

You can build zkLogin flows directly with lower-level Sui tooling, but then you need to manage more of the integration yourself. For a learning project and a lightweight app, Enoki is the practical choice because it reduces the amount of custom infrastructure you need to write.

That is why this project can stay frontend-focused while still demonstrating a real zkLogin wallet flow.

## Current limitations

This app is intentionally limited.

It currently does not include:

- token transfers
- sponsored transactions
- mainnet support
- multi-provider login
- profile storage or app-specific backend logic

The Walrus file listing is based on owned Walrus `Blob` objects on Sui. If a blob was uploaded elsewhere without transferring the blob object to this address, it will not appear in the list.

## Common issues

### `redirect_uri_mismatch`

Your Google Cloud redirect URI does not exactly match the redirect URI used by the app.

For local dev, verify:

- `http://localhost:5173` in Authorized JavaScript origins
- `http://localhost:5173/` in Authorized redirect URIs

### `Request to Enoki API failed (status: 400)`

This usually means one of these is wrong:

- the Enoki app does not allow your local origin
- the Enoki API key belongs to a different app than the one you configured
- the Google client ID does not match between Google, Enoki, and `.env`
- the app is running on a different port than the one you allowed
- the Enoki app is not configured for the network this project uses

### Wallet stays in `Waiting`

This usually means the popup flow completed, but the wallet session was not fully established. Check the auth error shown in the UI and verify the configuration items above.

## Funding the wallet on testnet

The first login usually creates an address with no funds.

To test balances:

1. Copy the address shown in the app.
2. Send testnet assets to that address.
3. Click `Refresh balances`.

## How Walrus testnet works in this app

This repository uses the **public Walrus testnet publisher**.

That means:

- uploads go to a public publisher endpoint over HTTP
- the publisher stores the blob on Walrus testnet
- the request tells the publisher to send the resulting Walrus `Blob` object to your connected Sui address
- the app lists your files by reading the Walrus `Blob` objects your address owns on Sui testnet

### Do you need test WAL for this app?

For the current implementation in this repository: **no, not for the upload button in the UI**.

Because the app uses the public Walrus testnet publisher, the browser upload flow does not directly spend your wallet's WAL balance.

You may still want testnet SUI in the wallet for other dApp testing and for any future extension that writes Walrus metadata or signs Walrus transactions directly.

### When do you need test WAL?

You need test WAL if you switch to a direct Walrus client flow where **your own wallet** signs and pays for storage operations, for example:

- using the Walrus CLI directly
- using the Walrus TypeScript SDK to register and certify blobs with your wallet
- running your own publisher or other custom Walrus write infrastructure

In that model, you generally need:

- testnet SUI for gas
- testnet WAL for Walrus storage fees

### How do you get test WAL?

For a direct Walrus wallet flow on testnet:

1. Fund your Sui address with testnet SUI from the Sui faucet.
2. Install the Walrus CLI.
3. Exchange some testnet SUI for testnet WAL with:

```bash
walrus get-wal --context testnet
```

The Walrus docs describe the standard setup flow as:

1. Configure the Sui client for testnet.
2. Fund the address with testnet SUI.
3. Run `walrus get-wal --context testnet`.

If you only use this repository exactly as implemented today, that extra step is not required.

## Scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
```

## Summary

This project is a simple reference implementation of a Sui zkLogin wallet using Google authentication and Enoki. The main educational value is seeing how identity, wallet creation, and balance reads fit together in a React app without requiring a traditional browser wallet extension.
