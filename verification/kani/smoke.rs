#[kani::proof]
fn verity_smoke() {
    let value: u8 = kani::any();
    assert_eq!(value, value);
    kani::cover!(value == 0);
}
