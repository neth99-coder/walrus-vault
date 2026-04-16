# Walrus Vault

Walrus Vault is a Sui testnet app for storing files on Walrus and protecting encrypted files with Seal-based allowlists. It also provides a public document-verification tool that lets anyone confirm whether a file they hold matches a document registered on-chain — without logging in, paying gas, or seeing the encrypted content.

The app supports two wallet paths:

1. Google sign-in through Enoki zkLogin.
2. Browser wallet connection, with Slush preferred when available.

With the current UI you can:

1. Connect a wallet.
2. Create and manage access-control allowlists on Sui.
3. Upload plain or Seal-encrypted files to Walrus.
4. Automatically register a SHA-256 fingerprint of every uploaded file on-chain.
5. Share encrypted file access by adding wallets to a whitelist.
6. Download plain files directly from Walrus.
7. Decrypt and download protected files in the browser when the connected wallet has access.
8. **Verify** whether any local file matches a document stored on Walrus — no login or gas required.

## Architecture

| Layer         | Purpose                               | Stored data                                                                                   |
| :------------ | :------------------------------------ | :-------------------------------------------------------------------------------------------- |
| Local storage | Local dashboard state                 | File names, blob IDs, key IDs, whitelist names, whitelist members, cap IDs                    |
| Sui           | Access control, ownership, and hashes | Shared whitelist object, owner capability, owned Walrus blob objects, `HashRegistered` events |
| Seal          | Key release and browser encryption    | Key shares gated by `seal_approve`                                                            |
| Walrus        | Blob storage                          | Plain bytes or Seal-encrypted bytes                                                           |

## Supported wallets

### Enoki Google wallet

- Uses Google OAuth through Enoki.
- Provides a zkLogin-backed Sui wallet.
- Requires `VITE_ENOKI_API_KEY` and `VITE_GOOGLE_CLIENT_ID`.

### Browser wallets

- The app can also connect to a standard browser wallet exposed through dApp Kit.
- If Slush is installed, the UI prefers Slush over other non-Enoki wallets.
- Slush is currently the most reliable path for decrypting encrypted files.

## Current behavior

### Whitelists

- Whitelists are created from the UI.
- Each whitelist maps to one shared `Whitelist` object and one owned `Cap` object on Sui.
- The creator is added to the whitelist automatically during creation.
- Members can be added or removed from the whitelist from the dashboard.
- Whitelist display metadata is stored locally per wallet.

### Uploads

Uploads support two modes:

- **Plain upload** — file bytes are uploaded directly to Walrus.
- **Encrypted upload** — the browser encrypts the file with Seal before upload.

After every successful upload (plain or encrypted), the app:

1. Computes a SHA-256 hash of the **plaintext** file bytes in the browser.
2. Submits a `register_hash` transaction to Sui that emits a `HashRegistered` event containing the blob ID, Walrus object ID, SHA-256 hex digest, file name, and uploader address.

This step is non-fatal — if the hash-registration transaction fails, the Walrus upload is still considered successful.

For encrypted uploads, the app also saves local metadata needed by the dashboard:

- `fileName`
- `blobId`
- `keyId`
- `whitelistId`
- `whitelistName`
- `whitelistCapId`
- `packageId`
- `uploadedAt`

### File discovery

- Walrus files are discovered from Sui-owned Walrus blob objects.
- File metadata is not read from on-chain blob attributes; the dashboard is local-first.
- Dashboard labels and whitelist associations are stored in browser local storage per wallet.

### Downloads

- Plain files download directly from Walrus.
- Encrypted files build a `seal_approve` PTB, request the key from Seal, decrypt in the browser, and then download the plaintext.

### Shared access

There is no backend database for sharing.

To share an encrypted file, the owner:

1. Adds the recipient wallet to the whitelist on Sui.
2. Shares the `blobId` and `keyId` out-of-band.

The recipient can then use the **Shared Access** section to decrypt the file if their connected wallet is currently allowed.

### Document verification

The **Verify** section allows anyone — including unauthenticated visitors — to check whether a file they hold matches a document registered on-chain:

1. Select a file. The SHA-256 hash is computed locally in the browser; no data is uploaded.
2. The app fetches all `HashRegistered` events from the Sui network (free RPC read — no gas).
3. If a matching hash exists, the app displays the uploader address, file name, Walrus blob ID, object ID, and registration timestamp.
4. If no match is found, the app confirms there is no on-chain record for that file's hash.

This provides a "zero-knowledge" verification model: a third party can confirm document authenticity without accessing the encrypted content or belonging to an allowlist.

## Project structure

```
src/
  App.tsx                  — main UI (wallet, allowlists, upload, download, verify)
  blobHashRegistry.ts      — build hash-registration transactions; query HashRegistered events
  dapp-kit.ts              — dApp Kit configuration for Sui testnet
  enokiSession.ts          — Enoki session helpers
  fileHash.ts              — browser-native SHA-256 via Web Crypto API
  localWalrusMetadata.ts   — local storage model for files, deleted entries, and whitelists
  RegisterEnokiWallets.tsx — Enoki wallet registration for the Google login path
  seal.ts                  — Seal client helpers (encrypt, approve PTB, session keys, decrypt)
  walrus.ts                — Walrus helpers, blob parsing, aggregator URLs, upload/download
move/
  walrus_vault_policy/
    sources/
      whitelist.move           — Seal allowlist policy (seal_approve, member management)
      blob_hash_registry.move  — SHA-256 hash registry (register_hash entry, HashRegistered event)
```

## Prerequisites

You need:

- Node.js 20+
- npm 10+
- Sui CLI
- a Sui testnet account with testnet SUI for gas
- a Google OAuth client ID if you want to use Enoki login
- an Enoki app and public API key if you want to use Enoki login
- a published `walrus_vault_policy` Move package for encrypted uploads, whitelist management, and hash registration

## Git push protection

Git pushes are blocked when the frontend build fails.

- The repository installs a `pre-push` hook through `npm install` via the `prepare` script.
- The hook runs `npm run build`.
- If the build exits non-zero, `git push` is aborted.

If hooks are not active in your local clone, run:

```bash
npm run prepare
```

## Environment variables

Create a `.env` file in the project root:

```env
VITE_ENOKI_API_KEY=your_enoki_public_api_key
VITE_GOOGLE_CLIENT_ID=your_google_oauth_web_client_id
VITE_SEAL_POLICY_PACKAGE_ID=0x_your_published_move_package
VITE_WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
VITE_WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space
```

Notes:

- `VITE_ENOKI_API_KEY` and `VITE_GOOGLE_CLIENT_ID` are required by the current app startup flow.
- `VITE_SEAL_POLICY_PACKAGE_ID` is required for whitelist creation, whitelist updates, encrypted uploads, encrypted downloads, hash registration, and the public Verify tool.
- `VITE_WALRUS_PUBLISHER_URL` and `VITE_WALRUS_AGGREGATOR_URL` are optional and fall back to Walrus testnet defaults.

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

The policy package is in `move/walrus_vault_policy` and contains two modules.

### `whitelist`

Seal allowlist policy:

- `create_whitelist_entry` — creates a shared `Whitelist` object and transfers a `Cap` to the caller.
- `add_member` / `remove_member` — manage allowed addresses.
- `seal_approve` — called by Seal to gate key release; passes only when the caller is on the whitelist.

### `blob_hash_registry`

SHA-256 hash registry:

- `register_hash(blob_id, object_id, sha256_hex, file_name)` — emits a `HashRegistered` event. No objects are created, so it is inexpensive.
- `HashRegistered` events can be queried by anyone via the public Sui RPC `suix_queryEvents` endpoint.

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

### 4. Upgrade an existing deployment

If you already have a published package and want to add the `blob_hash_registry` module:

```bash
sui client upgrade --upgrade-capability <UPGRADE_CAP_OBJECT_ID> --gas-budget 100000000
```

The upgrade capability object ID is in `move/walrus_vault_policy/Published.toml`.

### 5. Restart the app

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

1. Open the **Whitelists** section.
2. Enter a Sui address or click an existing member to remove them.
3. The app sends `add_member` or `remove_member` on Sui.
4. Local whitelist metadata is updated after the transaction succeeds.

### Upload a file

1. Choose a file and configure epochs and deletability.
2. Optionally toggle **Encrypt with Seal** and choose an access group.
3. The SHA-256 hash of the plaintext is computed in-browser.
4. If encryption is enabled, the file is encrypted with Seal; otherwise raw bytes are uploaded.
5. The file is uploaded to Walrus via the publisher endpoint.
6. The app submits a `register_hash` transaction on Sui to record the hash on-chain.
7. Local metadata is saved so the owner dashboard can manage the file later.

### Download an encrypted file

1. Click the file's decrypt/download button.
2. The app builds a `seal_approve` PTB for the linked whitelist.
3. Seal checks Sui access for the connected wallet.
4. If approved, the browser decrypts the file and downloads the plaintext.

### Verify a document

1. Navigate to the **Verify** tab (also visible on the login page without a wallet).
2. Select the file you want to verify.
3. The app hashes it locally with SHA-256.
4. It queries all `HashRegistered` events on Sui (no gas, no login).
5. A match shows the uploader, blob ID, object ID, and registration timestamp. No match means the file was never registered or has been modified.

## Local storage notes

The dashboard is intentionally local-first.

- Clearing browser storage removes local file and whitelist labels.
- Walrus blobs remain on Walrus.
- Access control and hash records remain on Sui.
- If local metadata is lost, you still need the correct `keyId` to decrypt an encrypted file.
- Whitelists are loaded from wallet-scoped local storage, not discovered from chain state.

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

This is a known issue with the Enoki path. Use Slush or another standard browser wallet as the current workaround for encrypted file decryption.

### Wallet has no SUI available for gas

Whitelist updates, encrypted uploads, and hash registration all require testnet SUI for gas. Make sure the connected wallet has testnet SUI before performing these operations. The public Verify tool never requires gas.

### Hash registration succeeds but Verify returns no match

Possible causes:

- The package ID in `VITE_SEAL_POLICY_PACKAGE_ID` was changed after the file was uploaded (the events were emitted under a different package ID).
- The file being checked has been modified since upload.
- The `register_hash` transaction was included in the upload session but the RPC node hasn't indexed the event yet — wait a few seconds and retry.

## Notes

- The app is testnet-focused; mainnet deployments require a private Walrus publisher with authentication.
- Logout disconnects the wallet session and refreshes the page.
- The production build may emit a large bundle warning, but the build still completes.
- The Verify tool works for all users — no wallet connection is required.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run preview
```
