namespace VerityPromotion

inductive Phase where
  | prepared
  | applied
  | recovered
  | rejected
  deriving DecidableEq, Repr

inductive Action where
  | moveHead (head : Nat)
  | revokeAuthority
  | cas (target : Nat)
  | crashAfterWrite
  | recoverAfterWrite
  deriving Repr

structure WriteRecord where
  operation : Nat
  oldHead : Nat
  approvedHead : Nat
  target : Nat
  candidate : Nat
  authority : Nat
  activeAuthority : Option Nat
  deriving DecidableEq, Repr

structure State where
  operation : Nat
  head : Nat
  activeAuthority : Option Nat
  approvedHead : Nat
  candidate : Nat
  approvedAuthority : Nat
  phase : Phase
  crashed : Bool
  writes : List WriteRecord
  deriving Repr

def writeRecord (state : State) (target : Nat) : WriteRecord :=
  { operation := state.operation
    oldHead := state.head
    approvedHead := state.approvedHead
    target := target
    candidate := state.candidate
    authority := state.approvedAuthority
    activeAuthority := state.activeAuthority }

def initial (operation oldHead candidate authority : Nat) : State :=
  { operation := operation
    head := oldHead
    activeAuthority := some authority
    approvedHead := oldHead
    candidate := candidate
    approvedAuthority := authority
    phase := .prepared
    crashed := false
    writes := [] }

abbrev canWrite (state : State) (target : Nat) : Prop :=
  state.phase = .prepared ∧
    state.crashed = false ∧
    state.writes = [] ∧
    state.head = state.approvedHead ∧
    state.activeAuthority = some state.approvedAuthority ∧
    target = state.candidate ∧
    target ≠ state.head

def step (state : State) (action : Action) : State := by
  cases action with
  | moveHead head => exact { state with head := head }
  | revokeAuthority => exact { state with activeAuthority := none }
  | cas target =>
      if state.phase = .prepared then
        if canWrite state target then
          exact { state with
            head := target,
            phase := .applied,
            writes := state.writes ++ [writeRecord state target] }
        else exact { state with phase := .rejected }
      else exact state
  | crashAfterWrite =>
      if state.phase = .applied then exact { state with crashed := true } else exact state
  | recoverAfterWrite =>
      if state.phase = .applied ∧ state.crashed = true ∧ state.head = state.candidate then
        exact { state with phase := .recovered, crashed := false }
      else exact state

def execute (state : State) (actions : List Action) : State :=
  actions.foldl step state

def recordMatchesApproval (state : State) (record : WriteRecord) : Prop :=
  record.operation = state.operation ∧
    record.oldHead = state.approvedHead ∧
    record.approvedHead = state.approvedHead ∧
    record.target = state.candidate ∧
    record.candidate = state.candidate ∧
    record.authority = state.approvedAuthority ∧
    record.activeAuthority = some state.approvedAuthority

def Safe (state : State) : Prop :=
  state.writes.length ≤ 1 ∧
    ∀ record, record ∈ state.writes → recordMatchesApproval state record

theorem initialSafe (operation oldHead candidate authority : Nat) :
    Safe (initial operation oldHead candidate authority) := by
  simp [Safe, initial]

theorem stepSafe (state : State) (action : Action) (safe : Safe state) :
    Safe (step state action) := by
  cases action with
  | moveHead head =>
      simpa [step, Safe, recordMatchesApproval] using safe
  | revokeAuthority =>
      simpa [step, Safe, recordMatchesApproval] using safe
  | cas target =>
      by_cases prepared : state.phase = .prepared
      · by_cases allowed : canWrite state target
        · rcases allowed with ⟨_, notCrashed, noWrites, oldMatches, authMatches,
            targetMatches, targetDiffers⟩
          have candidateDiffers : state.candidate ≠ state.approvedHead := by
            intro same
            apply targetDiffers
            rw [targetMatches, same, oldMatches]
          simp [step, prepared, canWrite, Safe, recordMatchesApproval, writeRecord,
            notCrashed, noWrites, oldMatches, authMatches, targetMatches, candidateDiffers]
        · simpa [step, prepared, allowed, Safe, recordMatchesApproval] using safe
      · simpa [step, prepared, Safe, recordMatchesApproval] using safe
  | crashAfterWrite =>
      by_cases applied : state.phase = .applied
      · simpa [step, applied, Safe, recordMatchesApproval] using safe
      · simpa [step, applied, Safe, recordMatchesApproval] using safe
  | recoverAfterWrite =>
      by_cases recovered : state.phase = .applied ∧ state.crashed = true ∧
          state.head = state.candidate
      · simpa [step, recovered, Safe, recordMatchesApproval] using safe
      · simpa [step, recovered, Safe, recordMatchesApproval] using safe

theorem executeSafeFrom (state : State) (actions : List Action) (safe : Safe state) :
    Safe (execute state actions) := by
  induction actions generalizing state with
  | nil => exact safe
  | cons action actions ih =>
      exact ih (step state action) (stepSafe state action safe)

theorem executeSafe (operation oldHead candidate authority : Nat) (actions : List Action) :
    Safe (execute (initial operation oldHead candidate authority) actions) :=
  executeSafeFrom _ _ (initialSafe operation oldHead candidate authority)

theorem executeAtMostOneWrite (operation oldHead candidate authority : Nat)
    (actions : List Action) :
    (execute (initial operation oldHead candidate authority) actions).writes.length ≤ 1 :=
  (executeSafe operation oldHead candidate authority actions).1

theorem stepPreservesWrite (state : State) (action : Action) (record : WriteRecord)
    (present : record ∈ state.writes) : record ∈ (step state action).writes := by
  cases action with
  | moveHead head => simpa [step] using present
  | revokeAuthority => simpa [step] using present
  | cas target =>
      by_cases prepared : state.phase = .prepared
      · by_cases allowed : canWrite state target
        · have noWrites := allowed.2.2.1
          rw [noWrites] at present
          simp at present
        · simpa [step, prepared, allowed] using present
      · simpa [step, prepared] using present
  | crashAfterWrite =>
      by_cases applied : state.phase = .applied
      · simpa [step, applied] using present
      · simpa [step, applied] using present
  | recoverAfterWrite =>
      by_cases recovered : state.phase = .applied ∧ state.crashed = true ∧
          state.head = state.candidate
      · simpa [step, recovered] using present
      · simpa [step, recovered] using present

theorem executePreservesWrites (state : State) (actions : List Action) :
    ∀ record, record ∈ state.writes → record ∈ (execute state actions).writes := by
  induction actions generalizing state with
  | nil => intro record present; exact present
  | cons action actions ih =>
      intro record present
      exact ih (step state action) record (stepPreservesWrite state action record present)

theorem matchingFencesWrite (operation oldHead candidate authority : Nat)
    (different : candidate ≠ oldHead) :
    let result := execute (initial operation oldHead candidate authority) [.cas candidate]
    result.phase = .applied ∧ result.head = candidate ∧ result.writes.length = 1 ∧
      ∀ record, record ∈ result.writes → recordMatchesApproval result record := by
  simp [execute, step, canWrite, initial, recordMatchesApproval, writeRecord, different]

theorem movedHeadRejects (operation oldHead movedHead candidate authority : Nat)
    (moved : movedHead ≠ oldHead) :
    let result := execute (initial operation oldHead candidate authority)
      [.moveHead movedHead, .cas candidate]
    result.phase = .rejected ∧ result.head = movedHead ∧ result.writes = [] := by
  simp [execute, step, canWrite, initial, moved]

theorem revokedAuthorityRejects (operation oldHead candidate authority : Nat) :
    let result := execute (initial operation oldHead candidate authority)
      [.revokeAuthority, .cas candidate]
    result.phase = .rejected ∧ result.activeAuthority = none ∧ result.writes = [] := by
  simp [execute, step, canWrite, initial]

theorem unapprovedTargetRejects (operation oldHead candidate authority target : Nat)
    (different : target ≠ candidate) :
    let result := execute (initial operation oldHead candidate authority) [.cas target]
    result.phase = .rejected ∧ result.head = oldHead ∧ result.writes = [] := by
  simp [execute, step, canWrite, initial, different]

theorem noOpTargetRejects (operation oldHead authority : Nat) :
    let result := execute (initial operation oldHead oldHead authority) [.cas oldHead]
    result.phase = .rejected ∧ result.head = oldHead ∧ result.writes = [] := by
  simp [execute, step, canWrite, initial]

theorem recoveryAfterWriteOnlyRecordsOutcome
    (state : State) (applied : state.phase = .applied)
    (crashed : state.crashed = true) (atCandidate : state.head = state.candidate) :
    let result := step state .recoverAfterWrite
    result.phase = .recovered ∧ result.head = state.head ∧
      result.writes = state.writes ∧ result.activeAuthority = state.activeAuthority := by
  simp [step, applied, crashed, atCandidate]

theorem successfulRecoveryTrace (operation oldHead candidate authority : Nat)
    (different : candidate ≠ oldHead) :
    let result := execute (initial operation oldHead candidate authority)
      [.cas candidate, .crashAfterWrite, .recoverAfterWrite]
    result.phase = .recovered ∧ result.head = candidate ∧ result.writes.length = 1 := by
  simp [execute, step, canWrite, initial, different]

theorem retryAfterAppliedDoesNotWrite (state : State) (applied : state.phase = .applied) :
    (step state (.cas state.candidate)).writes = state.writes := by
  simp [step, applied]

end VerityPromotion
