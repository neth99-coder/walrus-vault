/// Records off-chain document attestations on-chain by emitting events.
///
/// This module matches the backend call shape:
/// `package::attestation::attest(doc_hash, attester, request_id, timestamp_ms)`.
/// No objects are created, so each attestation is inexpensive and easy to
/// query later through Sui event APIs.
module walrus_vault_policy::attestation;

use std::string::String;
use sui::event;

/// Emitted once per attestation request processed by the backend signer.
public struct Attested has copy, drop {
    /// Document hash supplied by the caller.
    doc_hash: String,
    /// Attester address string supplied by the backend.
    attester: String,
    /// Off-chain request identifier for correlation.
    request_id: String,
    /// Millisecond timestamp supplied by the caller.
    timestamp_ms: u64,
    /// Actual Sui sender that signed the transaction.
    tx_sender: address,
}

/// Emit an attestation event for the provided document hash and request ID.
entry fun attest(
    doc_hash: String,
    attester: String,
    request_id: String,
    timestamp_ms: u64,
    ctx: &TxContext,
) {
    event::emit(Attested {
        doc_hash,
        attester,
        request_id,
        timestamp_ms,
        tx_sender: ctx.sender(),
    });
}
