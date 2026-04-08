This is the **Access Control Plan** for the hybrid model. In this setup, **Firebase** acts as the high-speed frontend index and "User Directory," while the **Sui Blockchain** remains the immutable "Policy Enforcer" that the Seal Network actually listens to.

---

## 1. Governance Architecture

| Layer | Component | Status | Role |
| :--- | :--- | :--- | :--- |
| **Discovery** | **Firebase** | Centralized | Stores file metadata and "User-to-File" mappings for the UI. |
| **Permission** | **Sui Smart Contract** | Decentralized | The **Authoritative Source**. Contains the `Whitelist` object. |
| **Enforcement** | **Seal Network** | Decentralized | Validates the Sui `Whitelist` before releasing any key shares. |
| **Storage** | **Walrus** | Decentralized | Holds the encrypted blobs. |

---

## 2. Object Definitions

### Firebase (The Index)
Used for fast lookup and dashboard rendering.
* **`files` Collection:** Stores `blob_id`, `key_id`, `file_name`, and `whitelist_id`.
* **`whitelists` Collection:** Stores a list of `wallet_addresses` for UI display purposes.

### Sui (The Truth)
Used for cryptographic enforcement.
```rust
struct Whitelist has key, store {
    id: UID,
    // A mapping of address -> bool
    members: Table<address, bool>, 
}
```

---

## 3. The "Dual-Write" Access Flow

When a File Owner wants to grant access to a user, the frontend performs a **Dual-Write**:

1.  **Sui Transaction (The Gate):** Owner calls `whitelist::add_member(whitelist_cap, user_address)`. 
    * *Result:* The user is now cryptographically capable of requesting the key from Seal.
2.  **Firebase Update (The View):** Owner adds the user's address to the `whitelists` document in Firebase.
    * *Result:* The file immediately appears on the user's "Shared with Me" dashboard.

---

## 4. Complete System Flow

The lifecycle follows a **Hybrid-Parallel path**: metadata goes to Firebase for the UI, while the cryptographic "permission gate" is established on Sui.

### Step 1: Initialization (Owner)
* **Sui:** Owner deploys/calls the `create_whitelist` function.
* **Result:** A unique `Whitelist` object is created on-chain.
* **Firebase:** The `whitelist_id` (Sui Object ID) is saved in a Firebase collection to link the database to the blockchain.

---

### Step 2: Upload & Encryption (Owner)
1.  **Browser:** Generates a symmetric encryption key and a random `nonce`.
2.  **Key ID:** A `key_id` is formed: `whitelist_id + nonce`.
3.  **Seal:** The symmetric key is pushed to Seal, tagged with this `key_id`.
4.  **Walrus:** The browser encrypts the file and uploads the blob to Walrus, receiving a `blob_id`.
5.  **Firebase:** The browser saves the "File Record" (name, size, `blob_id`, `key_id`) to Firebase.

---

### Step 3: Granting Access (Owner)
This is a **Dual-Update** to ensure both the dashboard and the "gate" are synced:
* **Execution A (The Power):** Owner signs a Sui transaction: `whitelist::add(user_address)`. This enables Seal to approve the user.
* **Execution B (The View):** Frontend adds `user_address` to the Firebase `members` list. This makes the file appear in the user’s "Shared" folder.

---

### Step 4: Access & Decryption (User)
1.  **Discovery:** User opens their dashboard. Firebase queries all files where their address is in the `members` list.
2.  **Fetch:** User clicks "Download." The browser gets the `blob_id` and `key_id` from Firebase and pulls the encrypted data from **Walrus**.
3.  **Authentication:** User creates a **Session Key** (signed by their wallet) to prove identity.
4.  **Seal Request:** User sends the `key_id` and Session Key to Seal.
5.  **On-Chain Verification:** Seal performs a dry-run/simulation on **Sui**:
    * *Check:* Is the requester's address marked `true` in the `Whitelist` object associated with this `key_id`?
6.  **Decryption:** * If **YES**: Seal releases the key shares. Browser decrypts the Walrus blob locally.
    * If **NO**: Seal rejects the request.

---

### Step 5: Revocation (Owner)
1.  **Sui:** Owner calls `whitelist::remove(user_address)`.
2.  **Firebase:** Owner removes the address from the Firebase record.
* **Result:** Even if the user still has the `blob_id` cached, they can no longer get the key from Seal because the **Sui check** will fail.

---

## 5. Summary Table: Where Data Lives

| Data Point | Primary Store | Secondary Store (UI) |
| :--- | :--- | :--- |
| **Permissions** | **Sui** (Authoritative) | **Firebase** (Mirror) |
| **File Bytes** | **Walrus** (Encrypted) | N/A |
| **Decryption Key** | **Seal** (Fragmented) | N/A |
| **File Names/Types** | **Firebase** | N/A |
| **Mapping (Who has what)** | **Firebase** | **Sui** (Logic only) |

## 5. Decryption Logic (Seal Integration)

This is the critical "handshake" where Firebase is bypassed for security.

1.  **Identify:** User finds the file in their Firebase dashboard and gets the `key_id` and `whitelist_id`.
2.  **Request:** User sends a request to **Seal** with the `key_id`.
3.  **Verify (On-Chain):** Seal does not check Firebase. Instead, it executes a `seal_approve` check against the **Sui Whitelist Object**.
    * **Seal logic:** `IF (Sui.Whitelist[user_address] == true) THEN Release_Key_Shares`.
4.  **Decrypt:** The user's browser combines the shares and decrypts the Walrus blob locally.

---

## 6. Security Guardrails

* **Firebase Compromise:** If an attacker hacks your Firebase and adds their address to a file, they will see the file in their dashboard, but **decryption will fail**. Seal will see they aren't on the Sui Whitelist and refuse the key.
* **Revocation:** To revoke access, you **must** call the Sui contract. If you only remove them from Firebase, a tech-savvy user could still manually request the key from Seal using the `key_id` they previously saw.
* **Sync Integrity:** If a Sui transaction fails, the frontend must **not** update Firebase. The Sui state is the only state that matters for actual privacy.

---

## 7. Actor Responsibilities

* **File Owner:** Manages the Sui `Whitelist` object and keeps Firebase in sync.
* **Authorized User:** Authenticates via wallet to Seal to prove they own the address in the Sui `Whitelist`.
* **Developer:** Maintains the Firebase index and provides the UI to bridge the two layers.