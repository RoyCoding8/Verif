import HistoryLaw

namespace VerityHistoryAudit

inductive Call where
  | first
  | second
  deriving DecidableEq, BEq, ReflBEq, LawfulBEq

open Call

def history : VerityHistoryLaw.History Call Call Call where
  ids := [first, second]
  ids_nodup := by decide
  predecessor := fun earlier later => earlier = first ∧ later = second
  predecessor_decidable := by
    intro earlier later
    infer_instance
  input := id
  output := id

def forwardMachine : VerityHistoryLaw.Machine Call Call Bool where
  step := fun state input output =>
    match state, input, output with
    | false, first, first => some true
    | true, second, second => some true
    | _, _, _ => none

def reverseMachine : VerityHistoryLaw.Machine Call Call Bool where
  step := fun state input output =>
    match state, input, output with
    | false, second, second => some true
    | true, first, first => some true
    | _, _, _ => none

theorem acceptedCompleteHistory :
    VerityHistoryLaw.search history forwardMachine history.ids.length history.ids false = true := by
  rfl

theorem rejectedRealTimeViolation :
    VerityHistoryLaw.search history reverseMachine history.ids.length history.ids false = false := by
  rfl

theorem acceptedImpliesConstructiveExecution :
    VerityHistoryLaw.search history forwardMachine history.ids.length history.ids false = true ↔
      VerityHistoryLaw.Executes history forwardMachine history.ids.length history.ids false :=
  VerityHistoryLaw.completeHistory_correct history forwardMachine false

#print axioms VerityHistoryLaw.search_correct -- allow: propext Quot.sound
#print axioms VerityHistoryLaw.completeHistory_correct -- allow: propext Quot.sound
#print axioms acceptedCompleteHistory -- allow: propext Classical.choice Quot.sound
#print axioms rejectedRealTimeViolation -- allow: propext Classical.choice Quot.sound
#print axioms acceptedImpliesConstructiveExecution -- allow: propext Classical.choice Quot.sound

end VerityHistoryAudit
