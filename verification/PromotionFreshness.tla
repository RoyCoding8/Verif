-------------------- MODULE PromotionFreshness --------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANT StaleEvidenceMutant
ASSUME StaleEvidenceMutant \in BOOLEAN

Tasks == {"A", "B"}
Heads == {"old", "targetA", "targetB", "external"}
NoOwner == "none"
TargetFor == [t \in Tasks |-> IF t = "A" THEN "targetA" ELSE "targetB"]
OpStates == {"none", "prepared", "promoted", "abandoned"}
Epochs == 0..2

VARIABLES head, epoch, activeAuth, evidenceHead, evidenceEpoch,
          opState, opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites,
          crashed, writeLog

vars == <<head, epoch, activeAuth, evidenceHead, evidenceEpoch,
          opState, opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites,
          crashed, writeLog>>

EvidenceMatches == head = checkedHead /\ epoch = checkedEpoch

Init ==
  /\ head = "old"
  /\ epoch = 0
  /\ activeAuth = Tasks
  /\ evidenceHead = [t \in Tasks |-> "old"]
  /\ evidenceEpoch = [t \in Tasks |-> 0]
  /\ opState = "none"
  /\ opOwner = NoOwner
  /\ opId = 0
  /\ opSerial = 0
  /\ checkedHead = "old"
  /\ checkedEpoch = 0
  /\ opWrites = 0
  /\ crashed = FALSE
  /\ writeLog = <<>>

CheckEvidence(t) ==
  /\ t \in Tasks
  /\ evidenceHead' = [evidenceHead EXCEPT ![t] = head]
  /\ evidenceEpoch' = [evidenceEpoch EXCEPT ![t] = epoch]
  /\ UNCHANGED <<head, epoch, activeAuth, opState, opOwner,
                 opId, opSerial, checkedHead, checkedEpoch, opWrites, crashed, writeLog>>

Prepare(t) ==
  /\ t \in Tasks
  /\ t \in activeAuth
  /\ opState \in {"none", "promoted", "abandoned"}
  /\ opSerial < 2
  /\ opState' = "prepared"
  /\ opOwner' = t
  /\ opId' = opSerial + 1
  /\ opSerial' = opSerial + 1
  /\ checkedHead' = evidenceHead[t]
  /\ checkedEpoch' = evidenceEpoch[t]
  /\ opWrites' = 0
  /\ crashed' = FALSE
  /\ UNCHANGED <<head, epoch, activeAuth, evidenceHead, evidenceEpoch, writeLog>>

Revoke(t) ==
  /\ t \in activeAuth
  /\ activeAuth' = activeAuth \ {t}
  /\ UNCHANGED <<head, epoch, evidenceHead, evidenceEpoch, opState,
                 opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites, crashed, writeLog>>

MoveRef ==
  /\ opState = "prepared"
  /\ ~crashed
  /\ opWrites = 0
  /\ epoch < 2
  /\ head' = "external"
  /\ epoch' = epoch + 1
  /\ UNCHANGED <<activeAuth, evidenceHead, evidenceEpoch, opState,
                 opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites, crashed, writeLog>>

WriteRef ==
  /\ opState = "prepared"
  /\ ~crashed
  /\ opWrites = 0
  /\ opOwner \in activeAuth
  /\ head # TargetFor[opOwner]
  /\ epoch < 2
  /\ (StaleEvidenceMutant \/ EvidenceMatches)
  /\ head' = TargetFor[opOwner]
  /\ epoch' = epoch + 1
  /\ opWrites' = 1
  /\ writeLog' = Append(writeLog,
       <<head, epoch, checkedHead, checkedEpoch, opOwner, opOwner \in activeAuth, opId>>)
  /\ UNCHANGED <<activeAuth, evidenceHead, evidenceEpoch, opState,
                 opOwner, opId, opSerial, checkedHead, checkedEpoch, crashed>>

CrashAfterWrite ==
  /\ opState = "prepared"
  /\ opWrites = 1
  /\ head = TargetFor[opOwner]
  /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED <<head, epoch, activeAuth, evidenceHead, evidenceEpoch,
                 opState, opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites, writeLog>>

CommitWrite ==
  /\ opState = "prepared"
  /\ opWrites = 1
  /\ ~crashed
  /\ head = TargetFor[opOwner]
  /\ opState' = "promoted"
  /\ UNCHANGED <<head, epoch, activeAuth, evidenceHead, evidenceEpoch,
                 opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites, crashed, writeLog>>

RecoverWrittenRef ==
  /\ opState = "prepared"
  /\ opWrites = 1
  /\ crashed
  /\ head = TargetFor[opOwner]
  /\ opState' = "promoted"
  /\ crashed' = FALSE
  /\ UNCHANGED <<head, epoch, activeAuth, evidenceHead, evidenceEpoch,
                 opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites, writeLog>>

Abandon ==
  /\ opState = "prepared"
  /\ opWrites = 0
  /\ ~crashed
  /\ opState' = "abandoned"
  /\ UNCHANGED <<head, epoch, activeAuth, evidenceHead, evidenceEpoch,
                 opOwner, opId, opSerial, checkedHead, checkedEpoch, opWrites, crashed, writeLog>>

Next ==
  \/ \E t \in Tasks: CheckEvidence(t)
  \/ \E t \in Tasks: Prepare(t)
  \/ \E t \in Tasks: Revoke(t)
  \/ MoveRef
  \/ WriteRef
  \/ CrashAfterWrite
  \/ CommitWrite
  \/ RecoverWrittenRef
  \/ Abandon

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ head \in Heads
  /\ epoch \in Epochs
  /\ activeAuth \subseteq Tasks
  /\ evidenceHead \in [Tasks -> Heads]
  /\ evidenceEpoch \in [Tasks -> Epochs]
  /\ opState \in OpStates
  /\ opOwner \in Tasks \cup {NoOwner}
  /\ opId \in 0..2
  /\ opSerial \in 0..2
  /\ opId <= opSerial
  /\ checkedHead \in Heads
  /\ checkedEpoch \in Epochs
  /\ opWrites \in {0, 1}
  /\ crashed \in BOOLEAN
  /\ Len(writeLog) <= 2
  /\ \A i \in 1..Len(writeLog):
       writeLog[i] \in Heads \X Epochs \X Heads \X Epochs \X Tasks \X BOOLEAN \X (1..2)

OnePreparedOwner ==
  opState = "prepared" => opOwner \in Tasks

FreshAuthorizedWrites ==
  \A i \in 1..Len(writeLog):
    /\ writeLog[i][1] = writeLog[i][3]
    /\ writeLog[i][2] = writeLog[i][4]
    /\ writeLog[i][5] \in Tasks
    /\ writeLog[i][6]

OneWritePerDurableOperation ==
  \A i, j \in 1..Len(writeLog): i # j => writeLog[i][7] # writeLog[j][7]

RecoveryDoesNotRewrite ==
  /\ (crashed => opWrites = 1)
  /\ Cardinality({i \in 1..Len(writeLog): writeLog[i][7] = opId}) = opWrites
  /\ OneWritePerDurableOperation

============================================================
