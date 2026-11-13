#[path = "subject.rs"]
mod subject;

#[kani::proof]
fn verity_positive() {
    let input: u8 = kani::any();
    let output = subject::cap(input);
    assert!(output <= 10);
    kani::cover!(output == 10);
}

#[kani::proof]
fn verity_counterexample() {
    let input: u8 = kani::any();
    let output = subject::broken_cap(input);
    assert!(output <= 10);
}

#[kani::proof]
fn verity_unreachable() {
    let input: u8 = kani::any();
    kani::assume(input < 10);
    let output = subject::cap(input);
    assert!(output <= 10);
    kani::cover!(output == 10);
}
