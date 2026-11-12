-------------------- MODULE Promotion --------------------
EXTENDS Naturals, TLC

CONSTANTS Old, Target, Other, FenceAuthorization
ASSUME Old # Target /\ Target # Other /\ Old # Other
ASSUME FenceAuthorization \in BOOLEAN

Heads == {Old, Target, Other}
Epochs == {0, 1}
JournalStates == {"none", "prepared", "promoted", "abandoned"}
Decisions == {"idle", "prepared", "updated", "refused", "abandoned", "recovered"}

VARIABLES head, journal, attemptActive, policyEpoch, operationEpoch,
          crashed, updateAuthorized, decision

vars == <<head, journal, attemptActive, policyEpoch, operationEpoch,
          crashed, updateAuthorized, decision>>

AuthorizedNow == attemptActive /\ operationEpoch = policyEpoch

Init ==
  /\ head = Old
  /\ journal = "none"
  /\ attemptActive = TRUE
  /\ policyEpoch = 0
  /\ operationEpoch = 0
  /\ crashed = FALSE
  /\ updateAuthorized = TRUE
  /\ decision = "idle"

Prepare ==
  /\ journal = "none"
  /\ head = Old
  /\ journal' = "prepared"
  /\ operationEpoch' = policyEpoch
  /\ crashed' = FALSE
  /\ decision' = "prepared"
  /\ UNCHANGED <<head, attemptActive, policyEpoch, updateAuthorized>>

ChangePolicy ==
  /\ policyEpoch = 0
  /\ policyEpoch' = 1
  /\ UNCHANGED <<head, journal, attemptActive, operationEpoch,
                 crashed, updateAuthorized, decision>>

RevokeAttempt ==
  /\ attemptActive
  /\ attemptActive' = FALSE
  /\ policyEpoch' = IF policyEpoch = 0 THEN 1 ELSE policyEpoch
  /\ UNCHANGED <<head, journal, operationEpoch, crashed,
                 updateAuthorized, decision>>

RetryAtOld ==
  /\ journal = "prepared"
  /\ head = Old
  /\ ~crashed
  /\ (~FenceAuthorization \/ AuthorizedNow)
  /\ head' = Target
  /\ updateAuthorized' = AuthorizedNow
  /\ decision' = "updated"
  /\ UNCHANGED <<journal, attemptActive, policyEpoch, operationEpoch, crashed>>

RefuseStaleAuthorization ==
  /\ journal = "prepared"
  /\ head = Old
  /\ ~crashed
  /\ ~AuthorizedNow
  /\ FenceAuthorization
  /\ decision' = "refused"
  /\ UNCHANGED <<head, journal, attemptActive, policyEpoch, operationEpoch,
                 crashed, updateAuthorized>>

CrashAfterRefWriteBeforeJournalCommit ==
  /\ journal = "prepared"
  /\ head = Target
  /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED <<head, journal, attemptActive, policyEpoch, operationEpoch,
                 updateAuthorized, decision>>

CommitPromotion ==
  /\ journal = "prepared"
  /\ head = Target
  /\ ~crashed
  /\ journal' = "promoted"
  /\ UNCHANGED <<head, attemptActive, policyEpoch, operationEpoch, crashed,
                 updateAuthorized, decision>>

RecoverAfterWrite ==
  /\ journal = "prepared"
  /\ head = Target
  /\ crashed
  /\ journal' = "promoted"
  /\ crashed' = FALSE
  /\ decision' = "recovered"
  /\ UNCHANGED <<head, attemptActive, policyEpoch, operationEpoch, updateAuthorized>>

MoveHeadElsewhere ==
  /\ journal = "prepared"
  /\ head = Old
  /\ head' = Other
  /\ UNCHANGED <<journal, attemptActive, policyEpoch, operationEpoch, crashed,
                 updateAuthorized, decision>>

Abandon ==
  /\ journal = "prepared"
  /\ head # Target
  /\ ~crashed
  /\ journal' = "abandoned"
  /\ decision' = "abandoned"
  /\ UNCHANGED <<head, attemptActive, policyEpoch, operationEpoch,
                 crashed, updateAuthorized>>

NextState ==
  \/ Prepare
  \/ ChangePolicy
  \/ RevokeAttempt
  \/ RetryAtOld
  \/ RefuseStaleAuthorization
  \/ CrashAfterRefWriteBeforeJournalCommit
  \/ CommitPromotion
  \/ RecoverAfterWrite
  \/ MoveHeadElsewhere
  \/ Abandon

Spec == Init /\ [][NextState]_vars

TypeOK ==
  /\ head \in Heads
  /\ journal \in JournalStates
  /\ attemptActive \in BOOLEAN
  /\ policyEpoch \in Epochs
  /\ operationEpoch \in Epochs
  /\ crashed \in BOOLEAN
  /\ updateAuthorized \in BOOLEAN
  /\ decision \in Decisions

AuthorizedUpdateInvariant == updateAuthorized \/ head # Target

============================================================
