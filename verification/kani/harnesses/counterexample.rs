#[kani::proof]
fn verity_counterexample() {
    let input: u8 = kani::any();
    let output = subject::cap(input);
    assert!(output <= 10);
}
