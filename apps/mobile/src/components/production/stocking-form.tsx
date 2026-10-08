import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
} from '../../lib/production-api';
import {
  buildStockingPayload,
  clearStockingWriteRecovery,
  createStockingDraftSignature,
  createStockingSubmission,
  getStockingWriteRecovery,
  normalizeProductionEventTime,
  reconcileStockingWrite,
  type StockingInput,
  type StockingSubmission,
  type WaterQualityReconciliationData,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';

function getLocalDateTimeInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function getStockingFormValues(submission?: StockingSubmission | null): Record<string, string> {
  if (!submission) {
    return {
      species_code: '',
      quantity: '',
      average_weight: '',
      weight_unit: 'g',
      stocked_at: getLocalDateTimeInputValue(),
      source: '',
      notes: '',
    };
  }
  return {
    species_code: submission.payload.species_code,
    quantity: String(submission.payload.quantity),
    average_weight: String(submission.payload.average_weight),
    weight_unit: submission.payload.weight_unit,
    stocked_at: submission.payload.stocked_at,
    source: submission.payload.source ?? '',
    notes: submission.payload.notes ?? '',
  };
}

const LIFECYCLE_CONFLICT_MESSAGES: Record<string, string> = {
  site_closed_no_writes:
    'The site for this batch is closed. An authorized operator must reopen or reactivate the site before stocking can proceed. The batch itself has not changed.',
  unit_closed_no_writes:
    'The production unit for this batch is closed. An authorized operator must reopen or reactivate the unit before stocking can proceed. The batch itself has not changed.',
  site_under_maintenance:
    'The site for this batch is under maintenance. It must be returned to an operational state before stocking can proceed. The batch itself has not changed.',
  unit_under_maintenance:
    'The production unit for this batch is under maintenance. It must be returned to an operational state before stocking can proceed. The batch itself has not changed.',
};

export interface StockingFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  unitName?: string;
  batchState: string;
  onSaved?: (
    submission: StockingSubmission,
    reconciliation: WaterQualityReconciliationData,
  ) => void;
  onConflictRefreshed?: (reconciliation: WaterQualityReconciliationData) => void;
}

export function StockingForm({
  batchId,
  batchName,
  farmName,
  unitName,
  batchState,
  onSaved,
  onConflictRefreshed,
}: StockingFormProps) {
  const recoveryAtMount = getStockingWriteRecovery(batchId);
  const [values, setValues] = useState<Record<string, string>>(() =>
    getStockingFormValues(recoveryAtMount?.submission as StockingSubmission | undefined),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(recoveryAtMount?.inFlight ?? false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(Boolean(recoveryAtMount));
  const submissionInFlight = useRef(recoveryAtMount?.inFlight ?? false);
  const retrySubmission = useRef<StockingSubmission | null>(
    (recoveryAtMount?.submission as StockingSubmission | undefined) ?? null,
  );
  const draftRevision = useRef(0);
  const mounted = useRef(true);
  const context: WaterQualityWriteContext = { batchId, batchName, farmName, unitName };
  const batchLabel = batchName ?? batchId;
  const isPlanned = batchState === 'planned';

  const toInput = (): StockingInput => ({
    species_code: values.species_code,
    quantity: values.quantity,
    average_weight: values.average_weight,
    weight_unit: values.weight_unit || 'g',
    stocked_at: values.stocked_at,
    source: values.source,
    notes: values.notes,
  });

  const readAll = async (targetBatchId: string): Promise<WaterQualityReconciliationData> => {
    const [batch, projection, eventData] = await Promise.all([
      getProductionBatch(targetBatchId),
      getBatchProjections(targetBatchId),
      listBatchEvents(targetBatchId),
    ]);
    return {
      batch,
      projection,
      events: Array.isArray(eventData.items) ? eventData.items : [],
    };
  };

  const reconcileSubmission = (submission: StockingSubmission) =>
    reconcileStockingWrite({
      context,
      payload: submission.payload,
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
      readAll,
    });

  const updateField = (field: string, value: string) => {
    if (submissionInFlight.current || busy || recoveryRequired || !isPlanned) return;
    draftRevision.current += 1;
    setValues((current) => ({ ...current, [field]: value }));
    setConfirmed(false);
    setConfirmedSnapshot(null);
    setError(null);
    setStatusMessage(null);
  };

  const handleWriteResult = (
    result: Awaited<ReturnType<typeof reconcileStockingWrite>>,
    submissionRevision: number,
  ) => {
    if (!mounted.current) return;
    const recovery = getStockingWriteRecovery(batchId);
    const retainedAccepted =
      recovery?.retryOutcome === 'accepted' &&
      recovery.submission.idempotencyKey === result.submission.idempotencyKey;
    retrySubmission.current =
      draftRevision.current === submissionRevision
        ? (result.retrySubmission ??
          (retainedAccepted ? (recovery!.submission as StockingSubmission) : null))
        : null;
    setRecoveryRequired(Boolean(result.retrySubmission) || Boolean(retainedAccepted));

    if (result.outcome === 'accepted' && result.reconciliation) {
      onSaved?.(result.submission, result.reconciliation);
      clearStockingWriteRecovery(batchId, result.submission.idempotencyKey);
      retrySubmission.current = null;
      setRecoveryRequired(false);
      setConfirmed(false);
      setConfirmedSnapshot(null);
      setStatusMessage(
        'Initial stocking has been recorded and reconciled against the current batch.',
      );
      return;
    }
    if (result.outcome === 'accepted') {
      setError(
        'Stocking was accepted but reconciliation data is unavailable. Reconcile before editing.',
      );
      return;
    }
    if (result.outcome === 'rejected' || result.outcome === 'write_failed') {
      setConfirmed(false);
      setConfirmedSnapshot(null);
      retrySubmission.current = null;
      if (result.response?.status === 409) {
        const lifecycleMessage = result.response.code
          ? LIFECYCLE_CONFLICT_MESSAGES[result.response.code]
          : undefined;
        void readAll(batchId)
          .then((reconciliation) => {
            if (mounted.current) onConflictRefreshed?.(reconciliation);
          })
          .catch(() => {
            if (mounted.current) {
              setError(
                lifecycleMessage
                  ? `${lifecycleMessage} The current batch state could not be refreshed, so the state shown may be stale and is not confirmed. Reload the batch before proceeding.`
                  : 'The batch rejected stocking because its current state changed, but the current batch state could not be refreshed. The state shown may be stale and is not confirmed. Reload the batch before proceeding.',
              );
            }
          });
        setError(
          lifecycleMessage ??
            'The batch rejected stocking because its current state changed. Review authoritative batch data before proceeding.',
        );
      } else if (result.response?.status === 403) {
        setError(
          'You do not have permission to stock this batch. No local batch state was changed.',
        );
      } else if (result.response?.status === 404) {
        setError('This batch could not be found. Refresh the batch list before proceeding.');
      } else if (result.response?.status === 422) {
        setError(
          'The server rejected the stocking details. Correct the record before submitting again.',
        );
      } else {
        setError(
          'The server rejected this stocking record. Correct the highlighted details before retrying.',
        );
      }
      return;
    }
    if (result.outcome === 'reconciliation_failed') {
      setError(
        'Stocking was accepted, but reconciliation failed. Use the read-only reconciliation retry.',
      );
      return;
    }
    if (result.outcome === 'outcome_unknown') {
      setError(
        'The stocking write outcome is uncertain. The original submission is retained for same-key retry.',
      );
      return;
    }
    setError(
      'The stocking write failed without a retryable outcome. Review the batch before starting another submission.',
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
    const recovery = getStockingWriteRecovery(batchId);
    if (!recovery) {
      setRecoveryRequired(false);
      return;
    }
    retrySubmission.current = recovery.submission as StockingSubmission;
    if (recovery.retryOutcome === 'accepted' || recovery.retryOutcome === 'reconciliation_failed') {
      setRecoveryRequired(true);
      setBusy(true);
      submissionInFlight.current = true;
      let subscribed = true;
      void reconcileSubmission(recovery.submission as StockingSubmission)
        .then((result) => {
          if (subscribed && mounted.current) {
            handleWriteResultRef.current(result, draftRevision.current);
          }
        })
        .catch((caught) => {
          if (subscribed && mounted.current) {
            setError(caught instanceof Error ? caught.message : 'Unable to reconcile stocking.');
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
        'A previous stocking submission has an uncertain outcome. Its identity is retained; retry explicitly to resolve it.',
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
          handleWriteResultRef.current(
            result as Awaited<ReturnType<typeof reconcileStockingWrite>>,
            draftRevision.current,
          );
        }
      })
      .catch((caught) => {
        if (subscribed && mounted.current) {
          setError(caught instanceof Error ? caught.message : 'Unable to record stocking.');
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
  }, [batchId]);

  const handleSubmit = async () => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    try {
      if (busy) return;
      const recovering = recoveryRequired;
      if (!isPlanned && !recovering) {
        setError('Stocking is available only for a PLANNED batch. Refresh the batch state.');
        return;
      }
      if (!confirmed && !recovering) {
        setError('Explicitly confirm this irreversible initial stocking before submission.');
        return;
      }
      const input = toInput();
      let payload: ReturnType<typeof buildStockingPayload>;
      try {
        payload = buildStockingPayload(input);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Stocking details are invalid.');
        return;
      }
      const signature = createStockingDraftSignature(batchId, input);
      if (!recovering && confirmedSnapshot !== signature) {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        setError(
          'The stocking record changed after confirmation. Confirm the updated record before submitting.',
        );
        return;
      }

      let submission: StockingSubmission;
      if (recovering) {
        const retained = retrySubmission.current;
        if (
          !retained ||
          retained.batchId !== batchId ||
          JSON.stringify(retained.payload) !== JSON.stringify(payload)
        ) {
          setError(
            'The retained stocking submission does not match this batch and cannot be retried safely.',
          );
          return;
        }
        submission = retained;
      } else {
        submission =
          retrySubmission.current ?? createStockingSubmission(batchId, input, undefined, context);
      }
      setBusy(true);
      setError(null);
      setStatusMessage(null);
      handleWriteResultRef.current(await reconcileSubmission(submission), draftRevision.current);
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : 'Unable to record stocking.');
    } finally {
      if (mounted.current) {
        setBusy(false);
        submissionInFlight.current = false;
      }
    }
  };

  const fields = [
    ['species_code', 'Species code', 'default'],
    ['quantity', 'Individuals stocked', 'numeric'],
    ['average_weight', 'Average individual weight', 'numeric'],
    ['stocked_at', 'Physical stocked-at time', 'default'],
    ['source', 'Hatchery / supplier (optional)', 'default'],
    ['notes', 'Notes (optional)', 'default'],
  ] as const;
  const units = ['g', 'kg'] as const;
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time';
  const enteredOffset = /(?:Z|([+-]\d{2}:?\d{2}))$/i.exec(values.stocked_at.trim());
  const observedZone = enteredOffset
    ? enteredOffset[0].toUpperCase() === 'Z'
      ? 'UTC'
      : `entered offset ${enteredOffset[1]}`
    : `device local time (${deviceTimeZone})`;
  const normalizedPhysicalTime = normalizeProductionEventTime(values.stocked_at);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Record initial stocking</Text>
      <Text
        style={styles.subtitle}
      >{`${batchLabel} · ${farmName ?? 'Farm'} · ${unitName ?? 'Unit'}`}</Text>
      {!isPlanned && !recoveryRequired ? (
        <Text style={styles.warning}>
          Stocking requires an authoritative PLANNED batch. Current state: {batchState}.
        </Text>
      ) : null}
      {recoveryRequired ? (
        <Text style={styles.warning}>
          {busy
            ? 'This stocking write is still resolving. Editing and additional writes are locked.'
            : getStockingWriteRecovery(batchId)?.retryOutcome === 'accepted' ||
                getStockingWriteRecovery(batchId)?.retryOutcome === 'reconciliation_failed'
              ? 'Stocking was accepted. Editing is locked until authoritative batch, projection, and timeline reconciliation succeeds.'
              : 'The stocking write outcome is uncertain. Original submission identity is retained; retry explicitly.'}
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
            editable={!busy && !recoveryRequired && isPlanned}
          />
        </View>
      ))}
      <Text style={styles.label}>Weight unit</Text>
      <View style={styles.actions}>
        {units.map((unit) => (
          <Pressable
            key={unit}
            onPress={() => updateField('weight_unit', unit)}
            disabled={busy || recoveryRequired || !isPlanned}
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
        STOCKING establishes this batch's initial cohort and cannot be edited or reversed through
        the production API.
      </Text>
      <Text style={styles.meta}>
        The physical time is stored on the STOCKING event. The batch lifecycle stocked-at timestamp
        is assigned by the server and is not backdated by this input.
      </Text>
      <Pressable
        onPress={() => {
          if (busy || submissionInFlight.current || recoveryRequired || !isPlanned) return;
          try {
            buildStockingPayload(toInput());
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Enter a valid stocking record.');
            return;
          }
          const next = !confirmed;
          setConfirmed(next);
          setError(null);
          setStatusMessage(null);
          setConfirmedSnapshot(next ? createStockingDraftSignature(batchId, toInput()) : null);
        }}
        disabled={busy || recoveryRequired || !isPlanned}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>
          I confirm initial stocking of {batchLabel}. This establishes the initial population and
          weight for projections.
        </Text>
      </Pressable>
      {confirmed || recoveryRequired ? (
        <View style={styles.confirmationSummary}>
          <Text style={styles.summaryText}>
            Species code: {values.species_code || 'Not entered'}
          </Text>
          <Text style={styles.summaryText}>Individuals: {values.quantity || 'Not entered'}</Text>
          <Text style={styles.summaryText}>
            Physical stocking time ({observedZone}): {values.stocked_at}
          </Text>
          <Text style={styles.summaryText}>
            Physical time sent as UTC: {normalizedPhysicalTime}
          </Text>
          <Text style={styles.summaryText}>
            Average weight: {values.average_weight || 'Not entered'} {values.weight_unit || 'g'}
          </Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={busy || (!isPlanned && !recoveryRequired)}
      >
        <Text style={styles.primaryButtonText}>
          {busy
            ? 'Saving…'
            : recoveryRequired
              ? getStockingWriteRecovery(batchId)?.retryOutcome === 'accepted' ||
                getStockingWriteRecovery(batchId)?.retryOutcome === 'reconciliation_failed'
                ? 'Reconcile previous stocking'
                : 'Retry previous stocking'
              : 'Submit stocking'}
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
