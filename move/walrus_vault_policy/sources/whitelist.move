module walrus_vault_policy::whitelist;

use sui::table;
use sui::table::Table;

const E_NO_ACCESS: u64 = 1;
const E_INVALID_CAP: u64 = 2;
const E_DUPLICATE: u64 = 3;
const E_NOT_IN_WHITELIST: u64 = 4;
const E_WRONG_VERSION: u64 = 5;

const VERSION: u64 = 1;

public struct Whitelist has key {
    id: UID,
    version: u64,
    addresses: Table<address, bool>,
}

public struct Cap has key, store {
    id: UID,
    wl_id: ID,
}

public fun create_whitelist(ctx: &mut TxContext): (Cap, Whitelist) {
    let mut whitelist = Whitelist {
        id: object::new(ctx),
        version: VERSION,
        addresses: table::new(ctx),
    };
    whitelist.addresses.add(ctx.sender(), true);
    let cap = Cap {
        id: object::new(ctx),
        wl_id: object::id(&whitelist),
    };
    (cap, whitelist)
}

public fun share_whitelist(whitelist: Whitelist) {
    transfer::share_object(whitelist);
}

entry fun create_whitelist_entry(ctx: &mut TxContext) {
    let (cap, whitelist) = create_whitelist(ctx);
    share_whitelist(whitelist);
    transfer::public_transfer(cap, ctx.sender());
}

public fun add(whitelist: &mut Whitelist, cap: &Cap, account: address) {
    assert!(cap.wl_id == object::id(whitelist), E_INVALID_CAP);
    assert!(!whitelist.addresses.contains(account), E_DUPLICATE);
    whitelist.addresses.add(account, true);
}

public fun remove(whitelist: &mut Whitelist, cap: &Cap, account: address) {
    assert!(cap.wl_id == object::id(whitelist), E_INVALID_CAP);
    assert!(whitelist.addresses.contains(account), E_NOT_IN_WHITELIST);
    whitelist.addresses.remove(account);
}

entry fun add_member(whitelist: &mut Whitelist, cap: &Cap, account: address) {
    add(whitelist, cap, account);
}

entry fun remove_member(whitelist: &mut Whitelist, cap: &Cap, account: address) {
    remove(whitelist, cap, account);
}

fun check_policy(caller: address, id: vector<u8>, whitelist: &Whitelist): bool {
    assert!(whitelist.version == VERSION, E_WRONG_VERSION);

    let prefix = whitelist.id.to_bytes();
    let mut i = 0;
    if (prefix.length() > id.length()) {
        return false
    };
    while (i < prefix.length()) {
        if (prefix[i] != id[i]) {
            return false
        };
        i = i + 1;
    };

    whitelist.addresses.contains(caller)
}

entry fun seal_approve(id: vector<u8>, whitelist: &Whitelist, ctx: &TxContext) {
    assert!(check_policy(ctx.sender(), id, whitelist), E_NO_ACCESS);
}

#[test_only]
public fun destroy_for_testing(whitelist: Whitelist, cap: Cap) {
    let Whitelist {
        id,
        version: _,
        addresses,
    } = whitelist;
    addresses.drop();
    object::delete(id);

    let Cap { id, wl_id: _ } = cap;
    object::delete(id);
}

#[test]
fun test_approve() {
    let ctx = &mut tx_context::dummy();
    let (cap, mut whitelist) = create_whitelist(ctx);
    whitelist.add(&cap, @0x1);
    whitelist.remove(&cap, @0x1);
    whitelist.add(&cap, @0x2);

    assert!(!check_policy(@0x2, b"123", &whitelist), 1);

    let mut whitelist_id = object::id(&whitelist).to_bytes();
    vector::push_back(&mut whitelist_id, 11);
    assert!(check_policy(@0x2, whitelist_id, &whitelist), 1);

    let mut whitelist_id_for_removed_user = object::id(&whitelist).to_bytes();
    vector::push_back(&mut whitelist_id_for_removed_user, 11);
    assert!(!check_policy(@0x1, whitelist_id_for_removed_user, &whitelist), 1);

    destroy_for_testing(whitelist, cap);
}