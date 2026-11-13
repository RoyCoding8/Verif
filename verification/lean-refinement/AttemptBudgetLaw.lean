namespace VerityAttemptBudget

inductive Status where
  | queued
  | running
  deriving DecidableEq, Repr

inductive Action where
  | start
  | grant (claim : Nat)
  | clear
  | requeue
  deriving Repr

structure State where
  cap : Nat
  spent : Nat
  claim : Nat
  status : Status
  active : Option Nat
  deriving Repr

def initial (cap : Nat) : State :=
  { cap := cap, spent := 0, claim := 0, status := .queued, active := none }

def step (state : State) : Action → State
  | .start =>
      if state.status = .queued then
        { state with status := .running, claim := state.claim + 1, active := none }
      else state
  | .grant claim =>
      if state.status = .running ∧ claim = state.claim ∧ state.active = none ∧
          state.spent < state.cap then
        { state with spent := state.spent + 1, active := some claim }
      else state
  | .clear =>
      if state.active.isSome then { state with active := none } else state
  | .requeue =>
      if state.status = .running then
        { state with status := .queued, active := none }
      else state

def execute (state : State) : List Action → State
  | [] => state
  | action :: actions => execute (step state action) actions

def Safe (state : State) : Prop :=
  state.spent ≤ state.cap ∧
    ∀ claim, state.active = some claim → state.status = .running ∧ claim = state.claim

theorem initialSafe (cap : Nat) : Safe (initial cap) := by
  constructor
  · exact Nat.zero_le cap
  · intro claim active
    cases active

theorem stepSafe (state : State) (action : Action) (safe : Safe state) :
    Safe (step state action) := by
  cases action with
  | start =>
      simp only [step]
      split
      · constructor
        · exact safe.1
        · intro claim active
          cases active
      · exact safe
  | grant claim =>
      simp only [step]
      split
      · rename_i allowed
        have status : state.status = .running := allowed.1
        have current : claim = state.claim := allowed.2.1
        have capacity : state.spent < state.cap := allowed.2.2.2
        constructor
        · change state.spent + 1 ≤ state.cap
          exact Nat.succ_le_of_lt capacity
        · intro activeClaim active
          have sameClaim := Option.some.inj active
          change claim = activeClaim at sameClaim
          rw [← sameClaim]
          exact ⟨status, current⟩
      · exact safe
  | clear =>
      simp only [step]
      split
      · constructor
        · exact safe.1
        · intro claim active
          cases active
      · exact safe
  | requeue =>
      simp only [step]
      split
      · constructor
        · exact safe.1
        · intro claim active
          cases active
      · exact safe

theorem executeSafeFrom (state : State) (actions : List Action) (safe : Safe state) :
    Safe (execute state actions) := by
  induction actions generalizing state with
  | nil => exact safe
  | cons action actions ih =>
      exact ih (step state action) (stepSafe state action safe)

theorem executeSafe (cap : Nat) (actions : List Action) :
    Safe (execute (initial cap) actions) :=
  executeSafeFrom (initial cap) actions (initialSafe cap)

theorem stepSpentMonotone (state : State) (action : Action) :
    state.spent ≤ (step state action).spent := by
  cases action with
  | start =>
      simp only [step]
      split <;> exact Nat.le_refl _
  | grant claim =>
      simp only [step]
      split
      · exact Nat.le_succ state.spent
      · exact Nat.le_refl state.spent
  | clear =>
      simp only [step]
      split <;> exact Nat.le_refl _
  | requeue =>
      simp only [step]
      split <;> exact Nat.le_refl _

theorem executeSpentMonotone (state : State) (actions : List Action) :
    state.spent ≤ (execute state actions).spent := by
  induction actions generalizing state with
  | nil => exact Nat.le_refl _
  | cons action actions ih =>
      exact Nat.le_trans (stepSpentMonotone state action) (ih (step state action))

theorem grantProgress (state : State) (claim : Nat)
    (running : state.status = .running) (current : claim = state.claim)
    (inactive : state.active = none) (capacity : state.spent < state.cap) :
    (step state (.grant claim)).spent = state.spent + 1 ∧
      (step state (.grant claim)).active = some claim := by
  change (if state.status = .running ∧ claim = state.claim ∧ state.active = none ∧
    state.spent < state.cap then
      { state with spent := state.spent + 1, active := some claim }
    else state).spent = state.spent + 1 ∧
    (if state.status = .running ∧ claim = state.claim ∧ state.active = none ∧
      state.spent < state.cap then
        { state with spent := state.spent + 1, active := some claim }
      else state).active = some claim
  rw [ite_eq_left (show state.status = .running ∧ claim = state.claim ∧
    state.active = none ∧ state.spent < state.cap from
      ⟨running, current, inactive, capacity⟩)]
  exact ⟨rfl, rfl⟩

theorem grantRefused (state : State) (claim : Nat)
    (refused : ¬ (state.status = .running ∧ claim = state.claim ∧
      state.active = none ∧ state.spent < state.cap)) :
    step state (.grant claim) = state := by
  simp only [step]
  split
  · rename_i granted
    exact False.elim (refused granted)
  · rfl

theorem staleGrantRefused (state : State) (claim : Nat)
    (stale : claim ≠ state.claim) : step state (.grant claim) = state := by
  apply grantRefused
  intro allowed
  exact stale allowed.2.1

theorem queuedGrantRefused (state : State) (claim : Nat)
    (queued : state.status = .queued) : step state (.grant claim) = state := by
  apply grantRefused
  intro allowed
  exact Status.noConfusion (queued.symm.trans allowed.1)

theorem exhaustedGrantRefused (state : State) (claim : Nat)
    (exhausted : state.cap ≤ state.spent) : step state (.grant claim) = state := by
  apply grantRefused
  intro allowed
  exact (Nat.not_lt_of_ge exhausted) allowed.2.2.2

theorem startDoesNotSpend (state : State) :
    (step state .start).spent = state.spent := by
  simp only [step]
  split <;> rfl

theorem clearDoesNotSpend (state : State) :
    (step state .clear).spent = state.spent := by
  simp only [step]
  split <;> rfl

theorem requeueDoesNotSpend (state : State) :
    (step state .requeue).spent = state.spent := by
  simp only [step]
  split <;> rfl

theorem clearPreservesCap (state : State) :
    (step state .clear).cap = state.cap := by
  simp only [step]
  split <;> rfl

theorem requeuePreservesCap (state : State) :
    (step state .requeue).cap = state.cap := by
  simp only [step]
  split <;> rfl

theorem stepPreservesCap (state : State) (action : Action) :
    (step state action).cap = state.cap := by
  cases action with
  | start => simp only [step]; split <;> rfl
  | grant claim => simp only [step]; split <;> rfl
  | clear => simp only [step]; split <;> rfl
  | requeue => simp only [step]; split <;> rfl

theorem executePreservesCap (state : State) (actions : List Action) :
    (execute state actions).cap = state.cap := by
  induction actions generalizing state with
  | nil => rfl
  | cons action actions ih =>
      exact (ih (step state action)).trans (stepPreservesCap state action)

end VerityAttemptBudget
