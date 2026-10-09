import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
} from '../../lib/production-api';
import {
  buildHarvestPayload,
  clearHarvestWriteRecovery,
  createHarvestDraftSignature,
  createHarvestSubmission,
  getHarvestWriteRecovery,
  HarvestReconciliationError,
  reconcileHarvestWrite,
  restoreHarvestWriteRecovery,
  type HarvestInput,
  type HarvestSubmission,
  type WaterQualityReconciliationData,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';
import {
  createHarvestRecoveryRecord,
  deleteHarvestRecoveryRecord,
  harvestSubmissionFromRecord,
  HarvestRecoveryStorageError,
  loadHarvestRecovery,
  persistHarvestRecoveryRecord,
  resolveHarvestRecoveryUserId,
  type HarvestRecoveryLoad,
  type HarvestRecoveryRecord,
  type HarvestRecoveryStatus,
} from '../../features/production/harvest-recovery-store';

const CONFLICT_MESSAGES: Record<string, string> = {
  harvest_final_backdated:
    'The final harvest time is earlier than existing population-affecting events. Nothing was recorded. Review the refreshed timeline and start a new harvest.',
  harvest_final_quantity_mismatch:
    'The final harvest quantity does not equal the server-projected remaining population. Nothing was recorded. Reconcile the discrepancy through an authorized workflow (a sampling population estimate, a mortality record or a partial harvest) or escalate to a supervisor.',
  harvest_final_requires_active:
    'A final harvest requires an ACTIVE batch. Nothing was recorded. Review the refreshed batch state.',
  harvest_already_final:
    'A final harvest has already been recorded for this batch. No further harvests are permitted. Nothing was recorded by this submission.',
  harvest_exceeds_population:
    'The harvest quantity exceeds the server-projected remaining population. Nothing was recorded. Review the refreshed projection and enter a smaller quantity.',
  idempotency_key_payload_conflict:
    'This submission identity conflicts with a different recorded harvest. Review the refreshed timeline before starting a new harvest.',
};

const GENERIC_CONFLICT_MESSAGE =
  'The server rejected the harvest because the batch state changed. Review the refreshed batch before proceeding. Nothing was recorded.';

const UNPROCESSABLE_MESSAGES: Record<string, string> = {
  harvest_total_weight_required:
    'The server requires a total harvest weight greater than zero. Correct the record before submitting again. Nothing was recorded.',
};

const RESTART_LIMITATION =
  "Before each harvest is sent, its identity is saved to this device's secure storage so the same submission can be retried after the app restarts. Device-level durability has not been verified in this build. A timeline check does not prove that a duplicate cannot occur; always retry the original submission instead of starting a new one.";

const BLOCK_MESSAGES: Record<string, string> = {
  storage_unavailable:
    'Secure recovery storage is unavailable on this device or platform. Harvest recording is disabled because an interrupted submission could not be recovered safely.',
  identity_unavailable:
    'The signed-in user could not be verified, so the harvest recovery record cannot be checked. Check the connection and reopen this batch. Harvest recording is disabled until then.',
  corrupt:
    'A stored harvest recovery record for this batch is unreadable. New harvests are blocked. Escalate to a supervisor and check the batch timeline before taking any action.',
  incompatible:
    'A stored harvest recovery record for this batch uses an incompatible version. New harvests are blocked. Escalate to a supervisor.',
  invalid_batch:
    'This batch identity cannot be secured for recovery. Harvest recording is disabled.',
  foreign:
    'An unresolved harvest recovery record from another account exists for this batch. New harvests are blocked. Escalate to a supervisor; do not start another harvest.',
  mismatch:
    'The stored harvest recovery record does not match the unresolved submission held in memory. New harvests are blocked. Escalate to a supervisor.',
  identity_changed:
    'The signed-in account changed after this form loaded. The harvest was not sent or saved. Reopen the batch so recovery can be re-checked under the current account.',
  cleanup:
    'The unsent harvest record could not be removed from secure storage. New harvests are blocked for this batch. Reopen the batch to re-check recovery.',
};

const RESTORED_MESSAGES: Record<HarvestRecoveryStatus, string> = {
  PREPARED:
    'A harvest was prepared before the app stopped and may or may not have been sent. Its original identity is restored. Retry the same harvest to resolve it; do not start a new one.',
  POSTING:
    'A harvest was being sent when the app stopped and may have been recorded. Its original identity is restored. Retry the same harvest to resolve it; do not start a new one.',
  OUTCOME_UNKNOWN:
    'A previous harvest has an uncertain outcome. Its original identity is restored. Retry the same harvest to resolve it; do not start a new one.',
  ACCEPTED_UNRECONCILED:
    'A previous harvest was accepted but not yet verified. Its original identity is restored. Retry the same harvest to verify it; do not start a new one.',
};

type Hydration =
  { status: 'loading' } | { status: 'ready' } | { status: 'blocked'; message: string };

function blockMessageFor(loaded: HarvestRecoveryLoad): string {
  if (loaded.kind === 'foreign') return BLOCK_MESSAGES.foreign;
  if (loaded.kind === 'blocked') return BLOCK_MESSAGES[loaded.reason];
  return BLOCK_MESSAGES.corrupt;
}

const FINAL_WARNING =
  'A final harvest permanently sets this batch to HARVESTED. No correction or reversal endpoint currently exists.';

type HarvestMode = 'partial' | 'final';

interface FreshState {
  state: string;
  remaining: number | null;
}

function getFormValues(submission?: HarvestSubmission | null): Record<string, string> {
  if (!submission) {
    return { quantity: '', total_weight: '', weight_unit: 'kg', average_weight: '', notes: '' };
  }
  const payload = submission.payload;
  return {
    quantity: String(payload.quantity),
    total_weight: String(payload.total_weight),
    weight_unit: payload.weight_unit,
    average_weight: payload.average_weight === undefined ? '' : String(payload.average_weight),
    notes: payload.notes ?? '',
  };
}

function readFresh(
  batch: Record<string, unknown>,
  projection: Record<string, unknown>,
): FreshState {
  const remaining = projection.estimated_remaining_population;
  return {
    state: typeof batch.state === 'string' ? batch.state.toLowerCase() : '',
    remaining: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null,
  };
}

export interface HarvestFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  siteName?: string;
  unitName?: string;
  batchState: string;
  currentEstimatedRemainingPopulation?: number | null;
  onSaved?: (submission: HarvestSubmission, reconciliation: WaterQualityReconciliationData) => void;
  onConflictRefreshed?: (reconciliation: WaterQualityReconciliationData) => void;
}

export function HarvestForm({
  batchId,
  batchName,
  farmName,
  siteName,
  unitName,
  batchState,
  currentEstimatedRemainingPopulation = null,
  onSaved,
  onConflictRefreshed,
}: HarvestFormProps) {
  const [mode, setMode] = useState<HarvestMode>('partial');
  const [values, setValues] = useState<Record<string, string>>(() => getFormValues(null));
  const [fresh, setFresh] = useState<FreshState | null>(null);
  const [freshError, setFreshError] = useState<string | null>(null);
  const [confirmLevel, setConfirmLevel] = useState(0);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [hydration, setHydration] = useState<Hydration>({ status: 'loading' });
  const submissionInFlight = useRef(false);
  const retrySubmission = useRef<HarvestSubmission | null>(null);
  const freshRef = useRef<FreshState | null>(null);
  const draftRevision = useRef(0);
  const mounted = useRef(true);
  const userIdRef = useRef<string | null>(null);
  const durableRecord = useRef<HarvestRecoveryRecord | null>(null);
  const context: WaterQualityWriteContext = { batchId, batchName, farmName, unitName };
  const batchLabel = batchName ?? batchId;
  const isFinal = mode === 'final';
  const partialEligible =
    batchState === 'stocked' || batchState === 'active' || batchState === 'suspended';
  const isEligibleState = isFinal ? batchState === 'active' : partialEligible;
  const hydrated = hydration.status === 'ready';
  const locked = busy || recoveryRequired || !hydrated;

  const toInput = (): HarvestInput => ({
    quantity: values.quantity,
    total_weight: values.total_weight,
    weight_unit: values.weight_unit || 'kg',
    average_weight: values.average_weight,
    notes: values.notes,
    is_final: isFinal,
  });

  const signatureFor = (state: FreshState | null): string =>
    `${createHarvestDraftSignature(batchId, toInput(), state?.remaining ?? null)}|${
      isFinal ? (state?.state ?? '') : ''
    }`;

  const readSource = async (): Promise<WaterQualityReconciliationData> => {
    const [batch, projection, eventData] = await Promise.all([
      getProductionBatch(batchId),
      getBatchProjections(batchId),
      listBatchEvents(batchId),
    ]);
    return {
      batch,
      projection,
      events: Array.isArray(eventData.items) ? eventData.items : [],
    };
  };

  const resetConfirmations = () => {
    setConfirmLevel(0);
    setConfirmedSnapshot(null);
  };

  const applyFresh = (next: FreshState): boolean => {
    const previous = freshRef.current;
    const changed =
      previous !== null && (previous.state !== next.state || previous.remaining !== next.remaining);
    freshRef.current = next;
    if (mounted.current) {
      setFresh(next);
      setFreshError(null);
      if (changed) resetConfirmations();
    }
    return changed;
  };

  const refreshFresh = async (): Promise<FreshState | null> => {
    try {
      const [batch, projection] = await Promise.all([
        getProductionBatch(batchId),
        getBatchProjections(batchId),
      ]);
      const next = readFresh(batch, projection);
      applyFresh(next);
      return next;
    } catch {
      if (mounted.current) {
        setFreshError(
          'The latest batch state and projection could not be loaded. A final harvest cannot be confirmed until they are refreshed.',
        );
      }
      return null;
    }
  };

  const reconcileSubmission = (submission: HarvestSubmission) =>
    reconcileHarvestWrite({
      context,
      payload: {
        quantity: submission.payload.quantity,
        total_weight: submission.payload.total_weight,
        weight_unit: submission.payload.weight_unit,
        average_weight: submission.payload.average_weight ?? null,
        notes: submission.payload.notes ?? null,
        is_final: submission.payload.is_final,
      },
      idempotencyKey: submission.idempotencyKey,
      submission,
      post: async (targetBatchId, eventType, data, key, performedAt) =>
        createBatchEvent(
          targetBatchId,
          {
            event_type: eventType,
            ...(performedAt ? { performed_at: performedAt } : {}),
            data,
          },
          key,
        ),
      readAll: readSource,
    });

  const changeDraft = () => {
    draftRevision.current += 1;
    resetConfirmations();
    setError(null);
    setStatusMessage(null);
  };

  const updateField = (field: string, value: string) => {
    if (submissionInFlight.current || locked) return;
    changeDraft();
    setValues((current) => ({ ...current, [field]: value }));
  };

  const selectMode = (next: HarvestMode) => {
    if (submissionInFlight.current || locked || next === mode) return;
    changeDraft();
    setMode(next);
  };

  const clearDurable = async (idempotencyKey: string): Promise<boolean> => {
    try {
      await deleteHarvestRecoveryRecord(batchId, idempotencyKey);
      durableRecord.current = null;
      return true;
    } catch {
      return false;
    }
  };

  const keepSafetyLock = (submission: HarvestSubmission): boolean => {
    if (!restoreHarvestWriteRecovery(submission)) {
      retrySubmission.current = null;
      setRecoveryRequired(true);
      setHydration({ status: 'blocked', message: BLOCK_MESSAGES.mismatch });
      return false;
    }
    retrySubmission.current = submission;
    setRecoveryRequired(true);
    return true;
  };

  const handleWriteResult = async (
    result: Awaited<ReturnType<typeof reconcileHarvestWrite>>,
    submissionRevision: number,
    firstAttempt = false,
  ): Promise<void> => {
    if (!mounted.current) return;
    const recovery = getHarvestWriteRecovery(batchId);
    const retainedAccepted =
      recovery?.retryOutcome === 'accepted' &&
      recovery.submission.idempotencyKey === result.submission.idempotencyKey;
    retrySubmission.current =
      draftRevision.current === submissionRevision
        ? (result.retrySubmission ??
          (retainedAccepted ? (recovery!.submission as HarvestSubmission) : null))
        : null;
    setRecoveryRequired(Boolean(result.retrySubmission) || Boolean(retainedAccepted));

    if (result.outcome === 'accepted' && result.reconciliation) {
      const cleaned = await clearDurable(result.submission.idempotencyKey);
      if (cleaned) clearHarvestWriteRecovery(batchId, result.submission.idempotencyKey);
      if (!mounted.current) return;
      onSaved?.(result.submission, result.reconciliation);
      if (!cleaned) {
        keepSafetyLock(result.submission);
        setError(
          'The harvest was recorded and verified, but its local recovery record could not be cleared. Editing stays locked. Use the retry action to verify and clear it; do not start a new harvest.',
        );
        return;
      }
      clearHarvestWriteRecovery(batchId, result.submission.idempotencyKey);
      retrySubmission.current = null;
      draftRevision.current += 1;
      setRecoveryRequired(false);
      setValues(getFormValues(null));
      resetConfirmations();
      setError(null);
      setStatusMessage(
        result.submission.payload.is_final
          ? 'Final harvest recorded and verified. The batch is HARVESTED.'
          : 'Partial harvest recorded and verified against the refreshed timeline and projection.',
      );
      return;
    }
    if (result.outcome === 'accepted') {
      setError(
        'Harvest was accepted but reconciliation data is unavailable. Reconcile before editing.',
      );
      return;
    }
    if (result.outcome === 'rejected' || result.outcome === 'write_failed') {
      resetConfirmations();
      retrySubmission.current = null;
      const status = result.response?.status;
      const code = result.response?.code;
      // The backend checks auth, tenancy and permissions (401/403/404) and schema validation (422
      // without a code) before the idempotency lookup, so on a retry those statuses cannot prove
      // the original key was never accepted. Only domain rejections, which run after the replay
      // check, are definitive on a retry. On a first attempt the key is fresh, so any 409/422 is definitive; on a retry a payload conflict means the key is already in use.
      const payloadConflict = code === 'idempotency_key_payload_conflict';
      const domainRejection =
        result.outcome === 'rejected' && (firstAttempt || (code !== undefined && !payloadConflict));
      const preAcceptanceRejection =
        firstAttempt &&
        result.outcome === 'write_failed' &&
        (status === 401 || status === 403 || status === 404);
      if (!domainRejection && !preAcceptanceRejection) {
        keepSafetyLock(result.submission);
        setError(
          payloadConflict
            ? 'The server reports this harvest key was already used with different details. The original submission is retained and locked. Escalate to a supervisor; do not start a new harvest.'
            : 'The harvest failed in a way that does not prove it was not recorded. The original submission is retained. Sign in again if your session expired, retry the same harvest when permitted, or escalate to a supervisor. Do not start a new harvest.',
        );
        return;
      }
      if (!(await clearDurable(result.submission.idempotencyKey))) {
        keepSafetyLock(result.submission);
        setError(
          'The server rejected the harvest, but its local recovery record could not be cleared. Editing stays locked. Retry the same harvest to clear it; do not start a new harvest.',
        );
        return;
      }
      if (!mounted.current) return;
      if (status === 409) {
        const message = (code ? CONFLICT_MESSAGES[code] : undefined) ?? GENERIC_CONFLICT_MESSAGE;
        void readSource()
          .then((reconciliation) => {
            if (!mounted.current) return;
            freshRef.current = readFresh(reconciliation.batch, reconciliation.projection);
            setFresh(freshRef.current);
            onConflictRefreshed?.(reconciliation);
          })
          .catch(() => {
            if (mounted.current) {
              setError(
                `${message} The current batch state could not be refreshed, so the state shown may be stale. Reload the batch before proceeding.`,
              );
            }
          });
        setError(message);
      } else if (status === 403) {
        setError('You do not have permission to harvest this batch. Nothing was recorded.');
      } else if (status === 404) {
        setError(
          'The batch could not be found. Refresh the batch list before proceeding. Nothing was recorded.',
        );
      } else if (status === 422) {
        setError(
          (code ? UNPROCESSABLE_MESSAGES[code] : undefined) ??
            'The server rejected the harvest details. Correct the record before submitting again. Nothing was recorded.',
        );
      } else {
        setError(
          'The harvest failed without a retryable outcome. Review the refreshed timeline before starting another submission.',
        );
      }
      return;
    }
    if (result.outcome === 'reconciliation_failed') {
      setError(
        result.error instanceof HarvestReconciliationError
          ? `Harvest recorded — refresh to confirm. ${result.error.message} Use the read-only reconciliation retry; do not start a new harvest.`
          : 'Harvest recorded — refresh to confirm. The server accepted it but the refreshed state could not be verified. Use the read-only reconciliation retry; do not start a new harvest.',
      );
      return;
    }
    setError(
      'The harvest outcome is uncertain. The original submission, key and timestamps are retained for same-key retry. Do not start a new harvest.',
    );
  };

  const handleWriteResultRef = useRef(handleWriteResult);
  handleWriteResultRef.current = handleWriteResult;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      const loaded = await loadHarvestRecovery(batchId);
      if (!active || !mounted.current) return;
      if (loaded.kind === 'blocked' || loaded.kind === 'foreign') {
        setHydration({ status: 'blocked', message: blockMessageFor(loaded) });
        return;
      }
      userIdRef.current = loaded.userId;
      const memory = getHarvestWriteRecovery(batchId);
      if (loaded.kind === 'none') {
        // An in-memory entry without an owned durable record cannot be attributed to this user.
        if (memory) {
          setHydration({ status: 'blocked', message: BLOCK_MESSAGES.mismatch });
          return;
        }
        setHydration({ status: 'ready' });
        return;
      }
      if (memory && memory.submission.idempotencyKey !== loaded.record.idempotencyKey) {
        setHydration({ status: 'blocked', message: BLOCK_MESSAGES.mismatch });
        return;
      }
      durableRecord.current = loaded.record;
      const restored: HarvestSubmission = {
        ...harvestSubmissionFromRecord(loaded.record),
        context,
      };
      if (!memory) restoreHarvestWriteRecovery(restored);
      retrySubmission.current = restored;
      setMode(restored.payload.is_final ? 'final' : 'partial');
      setValues(getFormValues(restored));
      setRecoveryRequired(true);
      setError(RESTORED_MESSAGES[loaded.record.status]);
      setHydration({ status: 'ready' });
    };
    void hydrate().catch(() => {
      if (active && mounted.current) {
        setHydration({ status: 'blocked', message: BLOCK_MESSAGES.storage_unavailable });
      }
    });
    return () => {
      active = false;
    };
  }, [batchId]);

  useEffect(() => {
    if (isFinal && !getHarvestWriteRecovery(batchId)) void refreshFresh();
  }, [batchId, isFinal]);

  useEffect(() => {
    if (!hydrated) return;
    const recovery = getHarvestWriteRecovery(batchId);
    if (!recovery) {
      setRecoveryRequired(false);
      return;
    }
    retrySubmission.current = recovery.submission as HarvestSubmission;
    if (recovery.retryOutcome === 'accepted' || recovery.retryOutcome === 'reconciliation_failed') {
      setRecoveryRequired(true);
      setBusy(true);
      submissionInFlight.current = true;
      let subscribed = true;
      void reconcileSubmission(recovery.submission as HarvestSubmission)
        .then((result) => {
          if (subscribed && mounted.current) {
            return handleWriteResultRef.current(result, draftRevision.current);
          }
          return undefined;
        })
        .catch((caught) => {
          if (subscribed && mounted.current) {
            setError(caught instanceof Error ? caught.message : 'Unable to reconcile harvest.');
          }
        })
        .finally(() => {
          if (subscribed && mounted.current) {
            setBusy(false);
            submissionInFlight.current = false;
          }
        });
      return () => {
        subscribed = false;
      };
    }
    if (!recovery.inFlight || !recovery.promise) {
      setRecoveryRequired(true);
      setBusy(false);
      submissionInFlight.current = false;
      setError(
        (current) =>
          current ??
          'A previous harvest submission has an uncertain outcome. Its identity is retained; retry explicitly to resolve it.',
      );
      return;
    }
    setRecoveryRequired(true);
    setBusy(true);
    submissionInFlight.current = true;
    let subscribed = true;
    void recovery.promise
      .then((result) => {
        if (subscribed && mounted.current) {
          return handleWriteResultRef.current(
            result as Awaited<ReturnType<typeof reconcileHarvestWrite>>,
            draftRevision.current,
          );
        }
        return undefined;
      })
      .catch((caught) => {
        if (subscribed && mounted.current) {
          setError(caught instanceof Error ? caught.message : 'Unable to record harvest.');
        }
      })
      .finally(() => {
        if (subscribed && mounted.current) {
          setBusy(false);
          submissionInFlight.current = false;
        }
      });
    return () => {
      subscribed = false;
    };
  }, [batchId, hydrated]);

  const validateDraft = (state: FreshState | null): string | null => {
    try {
      const payload = buildHarvestPayload(toInput(), new Date().toISOString());
      if (isFinal) {
        if (!state || state.remaining === null) {
          return 'The latest projected remaining population is unavailable. Refresh before a final harvest.';
        }
        if (state.state !== 'active') {
          return 'A final harvest requires an ACTIVE batch. Refresh the batch state.';
        }
        if (payload.quantity !== state.remaining) {
          return `The observed physical count (${payload.quantity}) differs from the server-projected remaining population (${state.remaining}). Final harvest is blocked. Reconcile the discrepancy through an authorized workflow (a sampling population estimate, a mortality record or a partial harvest) or escalate to a supervisor.`;
        }
      }
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : 'Harvest details are invalid.';
    }
  };

  const requiredLevel = isFinal ? 3 : 1;

  const handleConfirm = (step: number) => {
    if (locked || submissionInFlight.current) return;
    if (confirmLevel >= step) {
      setConfirmLevel(step - 1);
      if (step === 1) setConfirmedSnapshot(null);
      return;
    }
    if (confirmLevel !== step - 1) return;
    const invalid = validateDraft(fresh);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setStatusMessage(null);
    setConfirmLevel(step);
    if (step === 1) setConfirmedSnapshot(signatureFor(fresh));
  };

  const handleSubmit = async () => {
    if (submissionInFlight.current || !hydrated) return;
    submissionInFlight.current = true;
    try {
      if (busy) return;
      const recovering = recoveryRequired;
      if (!isEligibleState && !recovering) {
        setError(
          isFinal
            ? 'A final harvest requires an ACTIVE batch. Refresh the batch state.'
            : 'Harvests require a STOCKED, ACTIVE or SUSPENDED batch. Refresh the batch state.',
        );
        return;
      }
      if (confirmLevel < requiredLevel && !recovering) {
        setError(
          isFinal
            ? 'Complete all three confirmations before the final harvest.'
            : 'Explicitly confirm the recorded quantity before submission.',
        );
        return;
      }
      let submission: HarvestSubmission;
      if (recovering) {
        const retained = retrySubmission.current;
        if (!retained || retained.batchId !== batchId) {
          setError(
            'The retained harvest submission does not match this batch and cannot be retried safely.',
          );
          return;
        }
        submission = retained;
      } else {
        let latest = fresh;
        if (isFinal) {
          setBusy(true);
          latest = await refreshFresh();
          if (!latest) {
            resetConfirmations();
            return;
          }
        }
        const invalid = validateDraft(latest);
        if (invalid) {
          resetConfirmations();
          setError(invalid);
          return;
        }
        if (confirmedSnapshot !== signatureFor(latest)) {
          resetConfirmations();
          setError(
            isFinal
              ? 'The harvest or the projected remaining population changed after confirmation. Review and confirm again before submitting.'
              : 'The harvest changed after confirmation. Confirm the updated record before submitting.',
          );
          return;
        }
        submission = createHarvestSubmission(batchId, toInput(), undefined, context);
        const hydratedUserId = userIdRef.current;
        if (!hydratedUserId) {
          resetConfirmations();
          setError(BLOCK_MESSAGES.identity_unavailable);
          return;
        }
        let userId: string;
        try {
          userId = await resolveHarvestRecoveryUserId();
        } catch {
          resetConfirmations();
          setError(BLOCK_MESSAGES.identity_unavailable);
          return;
        }
        if (userId !== hydratedUserId) {
          resetConfirmations();
          userIdRef.current = null;
          retrySubmission.current = null;
          setHydration({ status: 'blocked', message: BLOCK_MESSAGES.identity_changed });
          return;
        }
        const record = createHarvestRecoveryRecord(userId, submission);
        try {
          await persistHarvestRecoveryRecord(record);
        } catch (storageError) {
          resetConfirmations();
          if (
            storageError instanceof HarvestRecoveryStorageError &&
            storageError.kind === 'unresolved_record_exists'
          ) {
            setHydration({ status: 'blocked', message: BLOCK_MESSAGES.mismatch });
            return;
          }
          if (!(await clearDurable(submission.idempotencyKey))) {
            setHydration({ status: 'blocked', message: BLOCK_MESSAGES.cleanup });
            return;
          }
          setError(
            `Recovery storage error: ${
              storageError instanceof HarvestRecoveryStorageError
                ? storageError.message
                : 'The recovery record could not be secured.'
            } The harvest was not sent. Nothing was recorded.`,
          );
          return;
        }
        durableRecord.current = record;
        retrySubmission.current = submission;
      }
      setBusy(true);
      setError(null);
      setStatusMessage(null);
      await handleWriteResultRef.current(
        await reconcileSubmission(submission),
        draftRevision.current,
        !recovering,
      );
    } catch (caught) {
      const pending = retrySubmission.current;
      if (mounted.current) {
        if (pending && durableRecord.current) {
          resetConfirmations();
          keepSafetyLock(pending);
        }
        setError(
          `${caught instanceof Error ? caught.message : 'Unable to record harvest.'} The original submission is retained; retry the same harvest and do not start a new one.`,
        );
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        submissionInFlight.current = false;
      }
    }
  };

  const fields = [
    [
      'quantity',
      isFinal ? 'Observed physical count harvested' : 'Individuals harvested (actual)',
      'numeric',
    ],
    ['total_weight', 'Total harvest weight', 'numeric'],
    ['average_weight', 'Average individual weight (optional)', 'numeric'],
    ['notes', 'Notes (optional)', 'default'],
  ] as const;
  const units = ['g', 'kg'] as const;
  const remainingShown = isFinal
    ? (fresh?.remaining ?? null)
    : (currentEstimatedRemainingPopulation ?? null);
  const quantityNumber = Number(values.quantity);
  const countDiffers =
    isFinal &&
    remainingShown !== null &&
    values.quantity.trim().length > 0 &&
    Number.isInteger(quantityNumber) &&
    quantityNumber !== remainingShown;
  const exceedsProjection =
    !isFinal &&
    remainingShown !== null &&
    Number.isInteger(quantityNumber) &&
    quantityNumber > remainingShown;
  const recoveryOutcome = getHarvestWriteRecovery(batchId)?.retryOutcome;
  const reconcileOnly =
    recoveryOutcome === 'accepted' || recoveryOutcome === 'reconciliation_failed';
  const confirmationTexts = isFinal
    ? [
        `I confirm the observed physical count (${values.quantity || 'not entered'}) equals the projected remaining population (${remainingShown ?? 'unknown'}).`,
        `I confirm this is an irreversible final harvest and ${batchLabel} will become HARVESTED. No correction or reversal endpoint currently exists.`,
        `Second confirmation: I explicitly authorize permanently finalizing ${batchLabel}.`,
      ]
    : [
        `I confirm ${values.quantity || 'the entered quantity'} individuals were actually harvested from ${batchLabel}.`,
      ];

  // A terminal batch only keeps the form visible while recovery or a result needs the operator.
  if (
    batchState === 'harvested' &&
    !recoveryRequired &&
    hydration.status !== 'blocked' &&
    !statusMessage &&
    !error
  ) {
    return null;
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Record a harvest</Text>
      <Text style={styles.subtitle}>
        {`${batchLabel} · ${farmName ?? 'Farm'} · ${siteName ?? 'Site'} · ${unitName ?? 'Unit'}`}
      </Text>
      <Text style={styles.label}>Harvest type</Text>
      <View style={styles.actions}>
        {(['partial', 'final'] as const).map((option) => (
          <Pressable
            key={option}
            onPress={() => selectMode(option)}
            disabled={locked}
            style={[styles.secondaryButton, mode === option && styles.optionSelected]}
          >
            <Text
              style={[styles.secondaryButtonText, mode === option && styles.optionSelectedText]}
            >
              {option === 'partial' ? 'Partial harvest' : 'Final harvest'}
            </Text>
          </Pressable>
        ))}
      </View>
      {!isEligibleState && !recoveryRequired ? (
        <Text style={styles.warning}>
          {isFinal
            ? `A final harvest requires an authoritative ACTIVE batch. Current state: ${batchState}.`
            : `Harvests require an authoritative STOCKED, ACTIVE or SUSPENDED batch. Current state: ${batchState}.`}
        </Text>
      ) : null}
      {hydration.status === 'loading' ? (
        <Text style={styles.warning}>Checking for an unresolved harvest recovery record…</Text>
      ) : null}
      {hydration.status === 'blocked' ? (
        <Text style={styles.error}>{hydration.message}</Text>
      ) : null}
      {recoveryRequired ? (
        <Text style={styles.warning}>
          {busy
            ? 'This harvest is still resolving. Editing and additional writes are locked.'
            : reconcileOnly
              ? 'Harvest recorded — refresh to confirm. Editing is locked until the refreshed state is verified. Never resubmit as a new harvest.'
              : 'The harvest outcome is uncertain. Original submission identity is retained; retry explicitly.'}
        </Text>
      ) : null}
      <Text style={styles.meta}>
        {isFinal
          ? `Projected remaining population (server, fresh): ${remainingShown ?? 'loading'}`
          : `Projected remaining population (context only): ${remainingShown ?? 'unknown'}`}
      </Text>
      {isFinal && freshError ? <Text style={styles.error}>{freshError}</Text> : null}
      {isFinal ? (
        <Pressable
          onPress={() => void refreshFresh()}
          disabled={locked}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Refresh projection</Text>
        </Pressable>
      ) : null}
      {countDiffers ? (
        <Text style={styles.error}>
          The observed count differs from the projected remaining population. Final harvest is
          blocked. Reconcile through an authorized workflow (sampling population estimate, mortality
          or partial harvest) or escalate.
        </Text>
      ) : null}
      {exceedsProjection ? (
        <Text style={styles.warning}>
          The entered quantity exceeds the displayed projection. The server is authoritative and
          will reject it if the projection is current.
        </Text>
      ) : null}
      {fields.map(([field, label, keyboardType]) => (
        <View key={field} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            style={styles.input}
            value={values[field]}
            onChangeText={(value) => updateField(field, value)}
            keyboardType={keyboardType === 'numeric' ? 'numeric' : 'default'}
            editable={!locked}
          />
        </View>
      ))}
      <Text style={styles.label}>Weight unit</Text>
      <View style={styles.actions}>
        {units.map((unit) => (
          <Pressable
            key={unit}
            onPress={() => updateField('weight_unit', unit)}
            disabled={locked}
            style={[styles.secondaryButton, values.weight_unit === unit && styles.optionSelected]}
          >
            <Text
              style={[
                styles.secondaryButtonText,
                values.weight_unit === unit && styles.optionSelectedText,
              ]}
            >
              {unit}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.warning}>
        {isFinal
          ? FINAL_WARNING
          : 'A harvest removes the recorded quantity from this batch. It cannot be edited or reversed through the production API.'}
      </Text>
      <Text style={styles.meta}>{RESTART_LIMITATION}</Text>
      {confirmationTexts.map((text, index) => {
        const step = index + 1;
        const checked = confirmLevel >= step;
        return (
          <Pressable
            key={step}
            onPress={() => handleConfirm(step)}
            disabled={locked}
            style={styles.checkboxRow}
          >
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
              {checked ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <Text style={styles.checkboxText}>{text}</Text>
          </Pressable>
        );
      })}
      {confirmLevel >= requiredLevel || recoveryRequired ? (
        <View style={styles.confirmationSummary}>
          <Text style={styles.summaryText}>Farm: {farmName ?? 'Unknown farm'}</Text>
          <Text style={styles.summaryText}>Type: {isFinal ? 'Final (total)' : 'Partial'}</Text>
          <Text style={styles.summaryText}>Quantity: {values.quantity || 'Not entered'}</Text>
          <Text style={styles.summaryText}>
            Total weight: {values.total_weight || 'Not entered'} {values.weight_unit}
          </Text>
          <Text style={styles.summaryText}>
            Harvest time: assigned once at submission and reused on any retry
          </Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={busy || !hydrated || (!isEligibleState && !recoveryRequired)}
      >
        <Text style={styles.primaryButtonText}>
          {busy
            ? 'Saving…'
            : recoveryRequired
              ? reconcileOnly
                ? 'Reconcile previous harvest'
                : 'Retry same harvest'
              : isFinal
                ? 'Submit final harvest'
                : 'Submit harvest'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 12,
    padding: 20,
    marginTop: 16,
  },
  cardTitle: { color: '#0f2e1e', fontSize: 18, fontWeight: '600', marginBottom: 4 },
  subtitle: { color: '#4a5c50', fontSize: 12, marginBottom: 12 },
  label: { color: '#0f2e1e', fontSize: 12, marginBottom: 6, fontWeight: '600' },
  row: { marginTop: 8 },
  input: {
    backgroundColor: '#f7f4ee',
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#0f2e1e',
    marginBottom: 8,
  },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 10 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#4a5c50',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#0f2e1e' },
  checkboxMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
  checkboxText: { color: '#4a5c50', flex: 1, fontSize: 12 },
  confirmationSummary: {
    marginTop: 10,
    borderLeftWidth: 2,
    borderLeftColor: '#1f5d40',
    paddingLeft: 10,
  },
  summaryText: { color: '#0f2e1e', fontSize: 12, marginTop: 4 },
  warning: { color: '#8a5a00', fontSize: 12, marginTop: 8 },
  meta: { color: '#4a5c50', fontSize: 12, marginTop: 8 },
  error: { color: '#8d2c2c', marginTop: 12, fontSize: 12 },
  success: { color: '#1f5d40', marginTop: 12, fontSize: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 8 },
  primaryButton: {
    backgroundColor: '#0f2e1e',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 12,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: '#f5f2e8', fontWeight: '700' },
  secondaryButton: {
    backgroundColor: '#f2efe8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secondaryButtonText: { color: '#0f2e1e', fontSize: 12, fontWeight: '600' },
  optionSelected: { backgroundColor: '#0f2e1e' },
  optionSelectedText: { color: '#f5f2e8' },
});
