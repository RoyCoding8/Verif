import Init

namespace VerityHistoryLaw

universe u v w

structure History (Call : Type u) (Input : Type v) (Output : Type w) where
  ids : List Call
  ids_nodup : ids.Nodup
  predecessor : Call → Call → Prop
  predecessor_decidable : DecidableRel predecessor
  input : Call → Input
  output : Call → Output

structure Machine (Input : Type v) (Output : Type w) (State : Type u) where
  step : State → Input → Output → Option State

def Ready {Call : Type u} {Input : Type v} {Output : Type w}
    (history : History Call Input Output) (pending : List Call) (call : Call) : Prop :=
  ∀ predecessor, predecessor ∈ history.ids →
    history.predecessor predecessor call → predecessor ∉ pending

def readyCheck {Call : Type u} {Input : Type v} {Output : Type w}
    [DecidableEq Call]
    (history : History Call Input Output) (pending : List Call) (call : Call) : Bool :=
  letI : DecidableRel history.predecessor := history.predecessor_decidable
  history.ids.all fun predecessor =>
    if history.predecessor predecessor call then decide (predecessor ∉ pending) else true

theorem readyCheck_spec {Call : Type u} {Input : Type v} {Output : Type w}
    [DecidableEq Call]
    (history : History Call Input Output) (pending : List Call) (call : Call) :
    readyCheck history pending call = true ↔ Ready history pending call := by
  letI : DecidableRel history.predecessor := history.predecessor_decidable
  simp only [readyCheck, List.all_eq_true]
  constructor
  · intro ready predecessor member precedes
    have test := ready predecessor member
    simp [precedes] at test
    exact test
  · intro ready predecessor member
    by_cases precedes : history.predecessor predecessor call
    · simp [precedes, ready predecessor member precedes]
    · simp [precedes]

inductive Executes {Call : Type u} {Input : Type v} {Output : Type w} {State : Type u}
    [BEq Call] [LawfulBEq Call]
    (history : History Call Input Output) (machine : Machine Input Output State) :
    Nat → List Call → State → Prop where
  | done (fuel : Nat) (state : State) : Executes history machine fuel [] state
  | next (fuel : Nat) (pending : List Call) (state nextState : State) (call : Call)
      (member : call ∈ pending)
      (ready : Ready history pending call)
      (transition : machine.step state (history.input call) (history.output call) = some nextState)
      (tail : Executes history machine fuel (pending.erase call) nextState) :
      Executes history machine (fuel + 1) pending state

def advance {Call : Type u} {Input : Type v} {Output : Type w} {State : Type u}
    [DecidableEq Call]
    (history : History Call Input Output) (machine : Machine Input Output State)
    (pending : List Call) (state : State) (call : Call) : Option State :=
  if readyCheck history pending call then
    machine.step state (history.input call) (history.output call)
  else none

theorem advance_spec {Call : Type u} {Input : Type v} {Output : Type w} {State : Type u}
    [DecidableEq Call]
    (history : History Call Input Output) (machine : Machine Input Output State)
    (pending : List Call) (state : State) (call : Call) (result : State) :
    advance history machine pending state call = some result ↔
      Ready history pending call ∧ machine.step state (history.input call) (history.output call) = some result := by
  letI : DecidableRel history.predecessor := history.predecessor_decidable
  simp [advance, readyCheck_spec]

def search {Call : Type u} {Input : Type v} {Output : Type w} {State : Type u}
    [DecidableEq Call] [BEq Call] [LawfulBEq Call]
    (history : History Call Input Output) (machine : Machine Input Output State) :
    Nat → List Call → State → Bool
  | 0, pending, _ => pending.isEmpty
  | fuel + 1, pending, state =>
      if pending.isEmpty then true
      else pending.any fun call =>
        match advance history machine pending state call with
        | none => false
        | some state' => search history machine fuel (pending.erase call) state'

theorem search_correct {Call : Type u} {Input : Type v} {Output : Type w} {State : Type u}
    [DecidableEq Call] [BEq Call] [LawfulBEq Call]
    (history : History Call Input Output) (machine : Machine Input Output State)
    (fuel : Nat) (pending : List Call) (state : State) :
    search history machine fuel pending state = true ↔ Executes history machine fuel pending state := by
  induction fuel generalizing pending state with
  | zero =>
      cases pending with
      | nil =>
          simp [search]
          exact .done 0 state
      | cons call rest =>
          simp [search]
          intro execution
          cases execution
  | succ fuel ih =>
      cases pending with
      | nil =>
          simp [search]
          exact .done (fuel + 1) state
      | cons call rest =>
          simp only [search, List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte]
          constructor
          · intro accepted
            rcases List.any_eq_true.mp accepted with ⟨choice, choiceMember, choiceAccepted⟩
            cases advanceResult : advance history machine (call :: rest) state choice with
            | none => simp [advanceResult] at choiceAccepted
            | some next =>
                have tailAccepted : search history machine fuel ((call :: rest).erase choice) next = true := by
                  simpa [advanceResult] using choiceAccepted
                have readyAndStep := (advance_spec history machine (call :: rest) state choice next).mp advanceResult
                exact .next fuel (call :: rest) state next choice choiceMember readyAndStep.1
                  readyAndStep.2 ((ih ((call :: rest).erase choice) next).mp tailAccepted)
          · intro execution
            cases execution with
            | next fuel' pending' current nextState chosen member ready transition tail =>
                have advanceResult : advance history machine (call :: rest) state chosen = some nextState :=
                  (advance_spec history machine (call :: rest) state chosen nextState).mpr ⟨ready, transition⟩
                apply List.any_eq_true.mpr
                refine ⟨chosen, member, ?_⟩
                simpa [advanceResult] using (ih ((call :: rest).erase chosen) nextState).mpr tail

theorem completeHistory_correct {Call : Type u} {Input : Type v} {Output : Type w} {State : Type u}
    [DecidableEq Call] [BEq Call] [LawfulBEq Call]
    (history : History Call Input Output) (machine : Machine Input Output State) (initial : State) :
    search history machine history.ids.length history.ids initial = true ↔
      Executes history machine history.ids.length history.ids initial :=
  search_correct history machine history.ids.length history.ids initial

end VerityHistoryLaw
