#[kani::proof]
fn verity_positive() {
    let input: u8 = kani::any();
    let output = subject::cap(input);
    assert!(output <= 10);
    kani::cover!(output == 10);
}
