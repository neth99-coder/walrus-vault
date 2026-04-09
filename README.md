# Walrus Vault

Walrus Vault is a Sui testnet app for storing files on Walrus and protecting encrypted files with Seal-based allowlists.

The app currently supports two wallet paths:

1. Google sign-in through Enoki zkLogin.
2. Browser wallet connection, with Slush preferred when available.

With the current UI you can:

1. Connect a wallet.
2. Create and manage allowlists on Sui.
3. Upload plain or encrypted files to Walrus.
4. Share encrypted file access by adding wallets to a whitelist.
5. Download plain files directly.
6. Decrypt and download protected files in the browser when the connected wallet has access.

## Architecture

| Layer         | Purpose                            | Stored data                                                                |
| :------------ | :--------------------------------- | :------------------------------------------------------------------------- |
| Local storage | Local dashboard state              | File names, blob IDs, key IDs, whitelist names, whitelist members, cap IDs |
| Sui           | Access control and ownership       | Shared whitelist object, owner capability, owned Walrus blob objects       |
| Seal          | Key release and browser encryption | Key shares gated by `seal_approve`                                         |
| Walrus        | Blob storage                       | Plain bytes or encrypted bytes                                             |

## Supported wallets

### Enoki Google wallet

- Uses Google OAuth through Enoki.
- Provides a zkLogin-backed Sui wallet.
- Requires `VITE_ENOKI_API_KEY` and `VITE_GOOGLE_CLIENT_ID`.

### Browser wallets

- The app can also connect to a standard browser wallet exposed through dApp Kit.
- If Slush is installed, the UI prefers Slush over other non-Enoki wallets.
- This path is currently the most reliable option for decrypting encrypted files.

## Current behavior

### Whitelists

- Whitelists are created from the UI.
- Each whitelist maps to one shared `Whitelist` object and one owned `Cap` object on Sui.
- The creator is added to the whitelist automatically during creation.
- Members can be added or removed from the whitelist from the dashboard.
- Whitelist display metadata is stored locally per wallet.

### Uploads

Uploads support two modes:

- Plain upload: file bytes are uploaded directly to Walrus.
- Encrypted upload: the browser encrypts the file with Seal before upload.

For encrypted uploads, the app stores local metadata needed by the dashboard, including:

- `fileName`
- `blobId`
- `keyId`
- `whitelistId`
- `whitelistName`
- `whitelistCapId`
- `packageId`
- `uploadedAt`

### File discovery

- Walrus files are still discovered from Sui-owned Walrus blob objects.
- File metadata is no longer read from on-chain blob attributes for the dashboard model.
- Dashboard labels and whitelist associations are local-first.

### Downloads

- Plain files download directly from Walrus.
- Encrypted files build a `seal_approve` PTB, request the key from Seal, decrypt in the browser, and then download the plaintext.

### Shared access

There is no backend database for sharing.

To share an encrypted file, the owner:

1. Adds the recipient wallet to the whitelist on Sui.
2. Shares the `blobId` and `keyId` out-of-band.

The recipient can then use the Shared Access section in the UI to decrypt the file if their connected wallet is currently allowed.

## Project structure

- `src/App.tsx`: main UI flow for wallet connection, allowlists, uploads, downloads, and shared access.
- `src/dapp-kit.ts`: dApp Kit configuration for Sui testnet.
- `src/RegisterEnokiWallets.tsx`: Enoki wallet registration for the Google login path.
- `src/localWalrusMetadata.ts`: local storage model for files, deleted entries, and named whitelists.
- `src/seal.ts`: Seal client helpers for encryption, approval PTBs, session keys, and decrypt flow.
- `src/walrus.ts`: Walrus helpers, blob parsing, aggregator URLs, and upload/download helpers.
- `move/walrus_vault_policy/sources/whitelist.move`: Move policy module for Seal allowlist enforcement.

## Prerequisites

You need:

- Node.js 20+
- npm 10+
- Sui CLI
- a Sui testnet account with testnet SUI for gas
- a Google OAuth client ID if you want to use Enoki login
- an Enoki app and public API key if you want to use Enoki login
- a published whitelist Move package if you want encrypted uploads and whitelist management

## Environment variables

Create a `.env` file in the project root.

```env
VITE_ENOKI_API_KEY=your_enoki_public_api_key
VITE_GOOGLE_CLIENT_ID=your_google_oauth_web_client_id
VITE_SEAL_POLICY_PACKAGE_ID=0x_your_published_move_package
VITE_WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
VITE_WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
```

Notes:

- `VITE_ENOKI_API_KEY` and `VITE_GOOGLE_CLIENT_ID` are required by the current app startup flow.
- `VITE_SEAL_POLICY_PACKAGE_ID` is required for whitelist creation, whitelist updates, encrypted uploads, and encrypted downloads.
- `VITE_WALRUS_PUBLISHER_URL` and `VITE_WALRUS_AGGREGATOR_URL` are optional. If omitted, the app uses Walrus testnet defaults.

## Enoki setup

### Google Cloud

In Google Cloud Console:

1. Create or choose a project.
2. Configure the OAuth consent screen.
3. Create an OAuth 2.0 client ID of type `Web application`.
4. Add your frontend origin to Authorized JavaScript origins.
5. Add the exact redirect URL to Authorized redirect URIs.

For local Vite development:

- Authorized JavaScript origin: `http://localhost:5173`
- Authorized redirect URI: `http://localhost:5173/`

If your dev server uses another port, update both entries accordingly.

### Enoki portal

In Enoki:

1. Create an app.
2. Add your local origin to the allowed origins list.
3. Enable Google as an auth provider.
4. Paste the same Google client ID from Google Cloud.
5. Enable testnet.
6. Copy the Enoki public API key into `.env`.

The Google client ID must match across Google Cloud, Enoki, and your `.env` file.

## Move package

The whitelist policy package is in `move/walrus_vault_policy`.

Main entry points:

- `create_whitelist_entry`
- `add_member`
- `remove_member`
- `seal_approve`

The contract follows the Seal allowlist pattern:

- one shared whitelist object defines access
- the owner keeps a capability object
- encrypted `keyId` values are prefixed with the whitelist object ID
- Seal approval succeeds only when the current wallet is in the whitelist

## Deploy the Move package to Sui testnet

### 1. Select testnet in the Sui CLI

```bash
sui client envs
sui client switch --env testnet
sui client active-address
```

### 2. Build the package

```bash
cd move/walrus_vault_policy
sui move build
```

### 3. Publish the package

```bash
sui client publish --gas-budget 100000000
```

After publish, copy the package ID and set it as `VITE_SEAL_POLICY_PACKAGE_ID` in `.env`.

### 4. Restart the app

Restart the Vite dev server after changing `.env`.

## Local development

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Build the app:

```bash
npm run build
```

Lint the app:

```bash
npm run lint
```

Preview the production build:

```bash
npm run preview
```

## How the app works

### Connect a wallet

You can enter through either path:

1. Google via Enoki.
2. Browser wallet, with Slush preferred if present.

Once connected, the app loads balances, owned Walrus blobs, local file metadata, and local whitelist metadata for that wallet.

### Create a whitelist

1. Enter a whitelist name in the UI.
2. The app calls `create_whitelist_entry`.
3. The shared whitelist ID and owned cap ID are read from the transaction result.
4. The whitelist is saved to local storage for the connected wallet.
5. The creator remains on the whitelist by default.

### Add or remove members

1. Open the Whitelists section.
2. Enter a Sui address or click an existing member to remove them.
3. The app sends `add_member` or `remove_member` on Sui.
4. Local whitelist metadata is updated after the transaction succeeds.

### Upload an encrypted file

1. Toggle Encrypt with Seal.
2. Choose a whitelist.
3. The app generates a `keyId` using `[whitelist_id][random_nonce]`.
4. The file is encrypted in the browser with Seal.
5. Ciphertext is uploaded to Walrus.
6. Local metadata is saved so the owner dashboard can manage the file later.

### Download an encrypted file

1. Click the file's decrypt/download button.
2. The app builds a `seal_approve` PTB for the linked whitelist.
3. Seal checks Sui access for the connected wallet.
4. If approved, the browser decrypts the file and downloads the plaintext.

## Local storage notes

The dashboard is intentionally local-first.

- Clearing browser storage removes local file and whitelist labels.
- Walrus blobs remain on Walrus.
- Access control remains on Sui.
- If local metadata is lost, you still need the correct `keyId` to decrypt an encrypted file.
- Whitelists are currently loaded from wallet-scoped local storage, not discovered from chain state.

## Known issues

- Enoki integration currently hits `InvalidUserSignatureError` when decrypting encrypted files through the Seal flow. The same decrypt path succeeds with Slush, which points to a zkLogin or server-side compatibility issue rather than a frontend certificate-construction issue.
- On some Android phones, the dApp flow unexpectedly asks for camera permissions. That is not expected behavior for this app and is currently under investigation.

## Troubleshooting

### `redirect_uri_mismatch`

Your Google Cloud redirect URI does not exactly match the redirect URI used by the app.

For local development, verify:

- `http://localhost:5173` in Authorized JavaScript origins
- `http://localhost:5173/` in Authorized redirect URIs

### Enoki login completes but no wallet account is returned

Check:

- Enoki allowed origins
- Google client ID consistency across Google, Enoki, and `.env`
- redirect URI accuracy
- active local port
- testnet enabled in Enoki

### `InvalidUserSignatureError` during decrypt

This is a known issue with the Enoki path right now. Use Slush or another standard browser wallet as the current workaround for encrypted file decryption.

### Wallet has no SUI available for gas

Whitelist updates and other wallet transactions require testnet SUI for gas. Make sure the connected wallet has testnet SUI before creating or editing whitelists.

## Notes

- The app is currently testnet-focused.
- Logout disconnects the wallet session and refreshes the page.
- The production build may emit a large bundle warning, but the build still completes.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run preview
```
