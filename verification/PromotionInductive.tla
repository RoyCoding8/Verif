-------------------- MODULE PromotionInductive --------------------
EXTENDS FiniteSets

Tasks == {"taskA", "taskB"}
NoTask == "no-task"
Commits == {"base", "taskA-next", "taskB-next", "external"}
NoCommit == "no-commit"
SlotPhases == {"empty", "prepared", "ref-written", "recorded", "abandoned"}

TargetFor == [t \in Tasks |-> IF t = "taskA" THEN "taskA-next" ELSE "taskB-next"]

VARIABLES
  (* @type: Str; *) head,
  (* @type: Set(Str); *) activeAuth,
  (* @type: Str -> Str; *) checkedHead,
  (* @type: Str; *) phase,
  (* @type: Str; *) opOwner,
  (* @type: Str; *) frozenHead,
  (* @type: Str; *) opTarget,
  (* @type: Str; *) writeFrom,
  (* @type: Bool; *) writeAuthorized,
  (* @type: Str; *) writtenOwner,
  (* @type: Str; *) writtenTarget

vars == <<head, activeAuth, checkedHead, phase, opOwner, frozenHead, opTarget,
          writeFrom, writeAuthorized, writtenOwner, writtenTarget>>

Init ==
  /\ head = "base"
  /\ activeAuth = Tasks
  /\ checkedHead = [t \in Tasks |-> "base"]
  /\ phase = "empty"
  /\ opOwner = NoTask
  /\ frozenHead = NoCommit
  /\ opTarget = NoCommit
  /\ writeFrom = NoCommit
  /\ writeAuthorized = FALSE
  /\ writtenOwner = NoTask
  /\ writtenTarget = NoCommit

CheckHead(t) ==
  /\ t \in Tasks
  /\ checkedHead' = [checkedHead EXCEPT ![t] = head]
  /\ UNCHANGED <<head, activeAuth, phase, opOwner, frozenHead, opTarget,
                 writeFrom, writeAuthorized, writtenOwner, writtenTarget>>

Prepare(t) ==
  /\ t \in Tasks
  /\ t \in activeAuth
  /\ phase \in {"empty", "recorded", "abandoned"}
  /\ checkedHead[t] # TargetFor[t]
  /\ phase' = "prepared"
  /\ opOwner' = t
  /\ frozenHead' = checkedHead[t]
  /\ opTarget' = TargetFor[t]
  /\ writeFrom' = NoCommit
  /\ writeAuthorized' = FALSE
  /\ writtenOwner' = NoTask
  /\ writtenTarget' = NoCommit
  /\ UNCHANGED <<head, activeAuth, checkedHead>>

Revoke(t) ==
  /\ t \in activeAuth
  /\ activeAuth' = activeAuth \ {t}
  /\ UNCHANGED <<head, checkedHead, phase, opOwner, frozenHead, opTarget,
                 writeFrom, writeAuthorized, writtenOwner, writtenTarget>>

MoveHead ==
  /\ phase = "prepared"
  /\ head # "external"
  /\ head' = "external"
  /\ UNCHANGED <<activeAuth, checkedHead, phase, opOwner, frozenHead, opTarget,
                 writeFrom, writeAuthorized, writtenOwner, writtenTarget>>

WriteRef ==
  /\ phase = "prepared"
  /\ opOwner \in activeAuth
  /\ head = frozenHead
  /\ head # opTarget
  /\ head' = opTarget
  /\ phase' = "ref-written"
  /\ writeFrom' = head
  /\ writeAuthorized' = (opOwner \in activeAuth)
  /\ writtenOwner' = opOwner
  /\ writtenTarget' = opTarget
  /\ UNCHANGED <<activeAuth, checkedHead, opOwner, frozenHead, opTarget>>

RecoverRecordOnly ==
  /\ phase = "ref-written"
  /\ head = opTarget
  /\ phase' = "recorded"
  /\ UNCHANGED <<head, activeAuth, checkedHead, opOwner, frozenHead, opTarget,
                 writeFrom, writeAuthorized, writtenOwner, writtenTarget>>

Abandon ==
  /\ phase = "prepared"
  /\ phase' = "abandoned"
  /\ UNCHANGED <<head, activeAuth, checkedHead, opOwner, frozenHead, opTarget,
                 writeFrom, writeAuthorized, writtenOwner, writtenTarget>>

Next ==
  \/ \E t \in Tasks: CheckHead(t)
  \/ \E t \in Tasks: Prepare(t)
  \/ \E t \in Tasks: Revoke(t)
  \/ MoveHead
  \/ WriteRef
  \/ RecoverRecordOnly
  \/ Abandon

UnsafeWriteRef ==
  /\ phase = "prepared"
  /\ opOwner \in activeAuth
  /\ head # opTarget
  /\ head' = opTarget
  /\ phase' = "ref-written"
  /\ writeFrom' = head
  /\ writeAuthorized' = (opOwner \in activeAuth)
  /\ writtenOwner' = opOwner
  /\ writtenTarget' = opTarget
  /\ UNCHANGED <<activeAuth, checkedHead, opOwner, frozenHead, opTarget>>

UnsafeNext == Next \/ UnsafeWriteRef

TypeOK ==
  /\ head \in Commits
  /\ activeAuth \in SUBSET Tasks
  /\ checkedHead \in [Tasks -> Commits]
  /\ phase \in SlotPhases
  /\ opOwner \in Tasks \cup {NoTask}
  /\ frozenHead \in Commits \cup {NoCommit}
  /\ opTarget \in Commits \cup {NoCommit}
  /\ writeFrom \in Commits \cup {NoCommit}
  /\ writeAuthorized \in BOOLEAN
  /\ writtenOwner \in Tasks \cup {NoTask}
  /\ writtenTarget \in Commits \cup {NoCommit}

PreparedShape ==
  phase \in {"prepared", "ref-written", "recorded"}
  => /\ opOwner \in Tasks
     /\ frozenHead \in Commits
     /\ opTarget = TargetFor[opOwner]

Safety ==
  phase \in {"ref-written", "recorded"}
  => /\ writeFrom = frozenHead
     /\ writeAuthorized
     /\ writtenOwner = opOwner
     /\ writtenTarget = opTarget

PositiveWrite == phase \in {"ref-written", "recorded"}

IndInv == TypeOK /\ PreparedShape /\ Safety

(* The finite data domains bound identities and commits, not trace length. The
   model abstracts JavaScript scheduling, SQLite durability, Git ref semantics,
   and the correspondence of their implementations to these atomic transitions. *)

============================================================
