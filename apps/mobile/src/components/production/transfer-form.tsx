import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
  listTransferDestinations,
} from '../../lib/production-api';
import {
  buildTransferPayload,
  clearTransferWriteRecovery,
  createTransferDraftSignature,
  createTransferSubmission,
  getTransferWriteRecovery,
  isTransferReconciliation,
  normalizeProductionEventTime,
  reconcileTransferWrite,
  TransferReconciliationError,
  type TransferInput,
  type TransferReaders,
  type TransferSubmission,
  type WaterQualityReconciliationData,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';

export interface TransferDestinationOption {
  id: string;
  unitId: string;
  label: string;
}

const LIFECYCLE_CONFLICT_MESSAGES: Record<string, string> = {
  site_closed_no_writes:
    'The source or destination site is closed. An authorized operator must reopen or reactivate it before transferring. Nothing was transferred.',
  unit_closed_no_writes:
    'The source or destination unit is closed. An authorized operator must reopen or reactivate it before transferring. Nothing was transferred.',
  site_under_maintenance:
    'The source or destination site is under maintenance. It must return to an operational state before transferring. Nothing was transferred.',
  unit_under_maintenance:
    'The source or destination unit is under maintenance. It must return to an operational state before transferring. Nothing was transferred.',
};

const CONFLICT_MESSAGES: Record<string, string> = {
  transfer_exceeds_population:
    'The transfer plus loss exceeds the batch’s current remaining population. Refresh and enter a smaller quantity. Nothing was transferred.',
  transfer_source_changed:
    'The source batch or unit changed since this transfer was prepared. Review the refreshed batch and start a new transfer. Nothing was transferred.',
  transfer_destination_batch_state:
    'The destination batch is no longer eligible to receive transfers. Reload destinations and select again. Nothing was transferred.',
  idempotency_key_payload_conflict:
    'This submission identity conflicts with a different recorded transfer. Review the batch timeline before starting a new transfer.',
};

const UNPROCESSABLE_MESSAGES: Record<string, string> = {
  transfer_destination_ineligible:
    'The destination is no longer eligible. Reload destinations and select again. Nothing was transferred.',
  transfer_destination_batch_ineligible:
    'The destination batch is no longer eligible. Reload destinations and select again. Nothing was transferred.',
  transfer_invalid_unit_id: 'The server rejected the unit identity. Reload the batch and retry.',
  transfer_invalid_destination_batch_id:
    'The server rejected the destination batch identity. Reload destinations and select again.',
  transfer_same_batch: 'The destination must be a different batch than the source.',
};

function getLocalDateTimeInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function getTransferFormValues(submission?: TransferSubmission | null): Record<string, string> {
  if (!submission) {
    return {
      destination_batch_id: '',
      destination_unit_id: '',
      destination_label: '',
      quantity: '',
      transfer_loss: '0',
      average_weight: '',
      weight_unit: 'g',
      transferred_at: getLocalDateTimeInputValue(),
      notes: '',
    };
  }
  return {
    destination_batch_id: submission.payload.destination_batch_id,
    destination_unit_id: submission.payload.destination_unit_id,
    destination_label: `Batch ${submission.payload.destination_batch_id}`,
    quantity: String(submission.payload.quantity),
    transfer_loss: String(submission.payload.transfer_loss),
    average_weight:
      submission.payload.average_weight === undefined
        ? ''
        : String(submission.payload.average_weight),
    weight_unit: submission.payload.weight_unit ?? 'g',
    transferred_at: submission.payload.transferred_at,
    notes: submission.payload.notes ?? '',
  };
}

export function toTransferDestinationOptions(
  entries: Array<Record<string, unknown>>,
  sourceBatchId: string,
  sourceUnitId: string | undefined,
): TransferDestinationOption[] {
  const options: TransferDestinationOption[] = [];
  for (const entry of entries) {
    const { id, unit_id: unitId, label } = entry;
    if (typeof id !== 'string' || typeof unitId !== 'string' || !id || !unitId) continue;
    if (id === sourceBatchId || unitId === sourceUnitId) continue;
    options.push({ id, unitId, label: typeof label === 'string' && label ? label : unitId });
  }
  return options;
}

export interface TransferFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  unitName?: string;
  sourceUnitId?: string;
  batchState: string;
  currentEstimatedRemainingPopulation?: number | null;
  onSaved?: (
    submission: TransferSubmission,
    reconciliation: WaterQualityReconciliationData,
  ) => void;
  onConflictRefreshed?: (reconciliation: WaterQualityReconciliationData) => void;
}

export function TransferForm({
  batchId,
  batchName,
  farmName,
  unitName,
  sourceUnitId,
  batchState,
  currentEstimatedRemainingPopulation = null,
  onSaved,
  onConflictRefreshed,
}: TransferFormProps) {
  const recoveryAtMount = getTransferWriteRecovery(batchId);
  const [values, setValues] = useState<Record<string, string>>(() =>
    getTransferFormValues(recoveryAtMount?.submission as TransferSubmission | undefined),
  );
  const [destinations, setDestinations] = useState<TransferDestinationOption[]>([]);
  const [destinationStatus, setDestinationStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(recoveryAtMount?.inFlight ?? false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(Boolean(recoveryAtMount));
  const submissionInFlight = useRef(recoveryAtMount?.inFlight ?? false);
  const retrySubmission = useRef<TransferSubmission | null>(
    (recoveryAtMount?.submission as TransferSubmission | undefined) ?? null,
  );
  const draftRevision = useRef(0);
  const mounted = useRef(true);
  const context: WaterQualityWriteContext = { batchId, batchName, farmName, unitName };
  const batchLabel = batchName ?? batchId;
  const isEligibleState =
    batchState === 'stocked' || batchState === 'active' || batchState === 'suspended';
  const locked = busy || recoveryRequired || !isEligibleState;

  const toInput = (): TransferInput => ({
    source_unit_id: sourceUnitId ?? null,
    destination_unit_id: values.destination_unit_id,
    destination_batch_id: values.destination_batch_id,
    quantity: values.quantity,
    transfer_loss: values.transfer_loss,
    average_weight: values.average_weight,
    weight_unit: values.weight_unit || 'g',
    transferred_at: values.transferred_at,
    notes: values.notes,
  });

  const readers: TransferReaders = {
    getBatch: getProductionBatch,
    getProjection: getBatchProjections,
    listEvents: async (targetBatchId, options) => {
      const page = await listBatchEvents(targetBatchId, options);
      return { items: Array.isArray(page.items) ? page.items : [], next_cursor: page.next_cursor };
    },
  };

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

  const loadDestinations = async () => {
    setDestinationStatus('loading');
    try {
      const entries = await listTransferDestinations(batchId);
      if (!mounted.current) return;
      setDestinations(toTransferDestinationOptions(entries, batchId, sourceUnitId));
      setDestinationStatus('ready');
    } catch {
      if (!mounted.current) return;
      setDestinations([]);
      setDestinationStatus('error');
    }
  };

  const reconcileSubmission = (submission: TransferSubmission) =>
    reconcileTransferWrite({
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
      readers,
    });

  const updateField = (field: string, value: string) => {
    if (submissionInFlight.current || locked) return;
    draftRevision.current += 1;
    setValues((current) => ({ ...current, [field]: value }));
    setConfirmed(false);
    setConfirmedSnapshot(null);
    setError(null);
    setStatusMessage(null);
  };

  const selectDestination = (option: TransferDestinationOption) => {
    if (submissionInFlight.current || locked) return;
    draftRevision.current += 1;
    setValues((current) => ({
      ...current,
      destination_batch_id: option.id,
      destination_unit_id: option.unitId,
      destination_label: option.label,
    }));
    setConfirmed(false);
    setConfirmedSnapshot(null);
    setError(null);
    setStatusMessage(null);
  };

  const handleWriteResult = (
    result: Awaited<ReturnType<typeof reconcileTransferWrite>>,
    submissionRevision: number,
  ) => {
    if (!mounted.current) return;
    const recovery = getTransferWriteRecovery(batchId);
    const retainedAccepted =
      recovery?.retryOutcome === 'accepted' &&
      recovery.submission.idempotencyKey === result.submission.idempotencyKey;
    retrySubmission.current =
      draftRevision.current === submissionRevision
        ? (result.retrySubmission ??
          (retainedAccepted ? (recovery!.submission as TransferSubmission) : null))
        : null;
    setRecoveryRequired(Boolean(result.retrySubmission) || Boolean(retainedAccepted));

    if (result.outcome === 'accepted' && result.reconciliation) {
      if (!isTransferReconciliation(result.reconciliation)) {
        setError(
          'Transfer was accepted but both-batch reconciliation data is unavailable. Reconcile before editing.',
        );
        return;
      }
      onSaved?.(result.submission, result.reconciliation);
      clearTransferWriteRecovery(batchId, result.submission.idempotencyKey);
      retrySubmission.current = null;
      draftRevision.current += 1;
      setRecoveryRequired(false);
      setValues(getTransferFormValues(null));
      setDestinations([]);
      void loadDestinations();
      setConfirmed(false);
      setConfirmedSnapshot(null);
      setStatusMessage(
        `Transfer ${result.reconciliation.transfer_id} was recorded and verified on both the source and destination batches.`,
      );
      return;
    }
    if (result.outcome === 'accepted') {
      setError(
        'Transfer was accepted but reconciliation data is unavailable. Reconcile before editing.',
      );
      return;
    }
    if (result.outcome === 'rejected' || result.outcome === 'write_failed') {
      setConfirmed(false);
      setConfirmedSnapshot(null);
      retrySubmission.current = null;
      const status = result.response?.status;
      const code = result.response?.code;
      if (status === 409) {
        const message =
          (code ? (LIFECYCLE_CONFLICT_MESSAGES[code] ?? CONFLICT_MESSAGES[code]) : undefined) ??
          'The server rejected the transfer because the batch state changed. Review the refreshed batch before proceeding. Nothing was transferred.';
        void readSource()
          .then((reconciliation) => {
            if (mounted.current) onConflictRefreshed?.(reconciliation);
          })
          .catch(() => {
            if (mounted.current) {
              setError(
                `${message} The current batch state could not be refreshed, so the state shown may be stale. Reload the batch before proceeding.`,
              );
            }
          });
        void loadDestinations();
        setError(message);
      } else if (status === 403) {
        setError(
          'You do not have permission to transfer from this batch. Nothing was transferred.',
        );
      } else if (status === 404) {
        setError(
          'The source batch could not be found. Refresh the batch list before proceeding. Nothing was transferred.',
        );
      } else if (status === 422) {
        void loadDestinations();
        setError(
          (code ? UNPROCESSABLE_MESSAGES[code] : undefined) ??
            'The server rejected the transfer details. Correct the record before submitting again. Nothing was transferred.',
        );
      } else {
        setError(
          'The transfer failed without a retryable outcome. Review the batch before starting another submission.',
        );
      }
      return;
    }
    if (result.outcome === 'reconciliation_failed') {
      const anomaly =
        result.error instanceof TransferReconciliationError &&
        result.error.kind === 'integrity_anomaly';
      setError(
        anomaly
          ? `${result.error?.message ?? 'Integrity anomaly.'}`
          : 'Transfer recorded — refresh to confirm. The server accepted it but the source and destination could not be verified. Use the read-only reconciliation retry; do not start a new transfer.',
      );
      return;
    }
    setError(
      'The transfer outcome is uncertain. The original submission is retained for same-key retry.',
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
    if (!getTransferWriteRecovery(batchId) && isEligibleState) void loadDestinations();
  }, [batchId, isEligibleState]);

  useEffect(() => {
    const recovery = getTransferWriteRecovery(batchId);
    if (!recovery) {
      setRecoveryRequired(false);
      return;
    }
    retrySubmission.current = recovery.submission as TransferSubmission;
    if (recovery.retryOutcome === 'accepted' || recovery.retryOutcome === 'reconciliation_failed') {
      setRecoveryRequired(true);
      setBusy(true);
      submissionInFlight.current = true;
      let subscribed = true;
      void reconcileSubmission(recovery.submission as TransferSubmission)
        .then((result) => {
          if (subscribed && mounted.current) {
            handleWriteResultRef.current(result, draftRevision.current);
          }
        })
        .catch((caught) => {
          if (subscribed && mounted.current) {
            setError(caught instanceof Error ? caught.message : 'Unable to reconcile transfer.');
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
        'A previous transfer submission has an uncertain outcome. Its identity is retained; retry explicitly to resolve it.',
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
            result as Awaited<ReturnType<typeof reconcileTransferWrite>>,
            draftRevision.current,
          );
        }
      })
      .catch((caught) => {
        if (subscribed && mounted.current) {
          setError(caught instanceof Error ? caught.message : 'Unable to record transfer.');
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

  const validateDraft = (): string | null => {
    try {
      const payload = buildTransferPayload(toInput());
      if (
        currentEstimatedRemainingPopulation !== null &&
        payload.quantity + payload.transfer_loss > currentEstimatedRemainingPopulation
      ) {
        return `Quantity plus loss (${payload.quantity + payload.transfer_loss}) exceeds the current remaining population (${currentEstimatedRemainingPopulation}).`;
      }
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : 'Transfer details are invalid.';
    }
  };

  const handleSubmit = async () => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    try {
      if (busy) return;
      const recovering = recoveryRequired;
      if (!isEligibleState && !recovering) {
        setError(
          'Transfers require a STOCKED, ACTIVE or SUSPENDED source batch. Refresh the batch state.',
        );
        return;
      }
      if (!confirmed && !recovering) {
        setError('Explicitly confirm the source and destination before submission.');
        return;
      }
      let submission: TransferSubmission;
      if (recovering) {
        const retained = retrySubmission.current;
        if (!retained || retained.batchId !== batchId) {
          setError(
            'The retained transfer submission does not match this batch and cannot be retried safely.',
          );
          return;
        }
        submission = retained;
      } else {
        const invalid = validateDraft();
        if (invalid) {
          setError(invalid);
          return;
        }
        const signature = createTransferDraftSignature(batchId, toInput());
        if (confirmedSnapshot !== signature) {
          setConfirmed(false);
          setConfirmedSnapshot(null);
          setError(
            'The transfer changed after confirmation. Confirm the updated record before submitting.',
          );
          return;
        }
        submission = createTransferSubmission(batchId, toInput(), undefined, context);
        retrySubmission.current = submission;
      }
      setBusy(true);
      setError(null);
      setStatusMessage(null);
      handleWriteResultRef.current(await reconcileSubmission(submission), draftRevision.current);
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : 'Unable to record transfer.');
    } finally {
      if (mounted.current) {
        setBusy(false);
        submissionInFlight.current = false;
      }
    }
  };

  const fields = [
    ['quantity', 'Individuals transferred (net, received)', 'numeric'],
    ['transfer_loss', 'Individuals lost in transit', 'numeric'],
    ['average_weight', 'Average individual weight (optional)', 'numeric'],
    ['transferred_at', 'Physical transfer time', 'default'],
    ['notes', 'Notes (optional)', 'default'],
  ] as const;
  const units = ['g', 'kg'] as const;
  const normalizedPhysicalTime = normalizeProductionEventTime(values.transferred_at);
  const quantityNumber = Number(values.quantity);
  const lossNumber = Number(values.transfer_loss || 0);
  const remainingAfter =
    currentEstimatedRemainingPopulation !== null &&
    Number.isInteger(quantityNumber) &&
    Number.isInteger(lossNumber)
      ? currentEstimatedRemainingPopulation - quantityNumber - lossNumber
      : null;
  const recoveryOutcome = getTransferWriteRecovery(batchId)?.retryOutcome;
  const reconcileOnly =
    recoveryOutcome === 'accepted' || recoveryOutcome === 'reconciliation_failed';

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Transfer individuals to another batch</Text>
      <Text
        style={styles.subtitle}
      >{`${batchLabel} · ${farmName ?? 'Farm'} · ${unitName ?? 'Unit'}`}</Text>
      {!isEligibleState && !recoveryRequired ? (
        <Text style={styles.warning}>
          Transfers require an authoritative STOCKED, ACTIVE or SUSPENDED source batch. Current
          state: {batchState}.
        </Text>
      ) : null}
      {recoveryRequired ? (
        <Text style={styles.warning}>
          {busy
            ? 'This transfer is still resolving. Editing and additional writes are locked.'
            : reconcileOnly
              ? 'Transfer recorded — refresh to confirm. Editing is locked until both batches reconcile. Never resubmit as a new transfer.'
              : 'The transfer outcome is uncertain. Original submission identity is retained; retry explicitly.'}
        </Text>
      ) : null}
      <Text style={styles.label}>Destination (server-eligible only)</Text>
      {recoveryRequired ? (
        <Text style={styles.summaryText}>{values.destination_label}</Text>
      ) : destinationStatus === 'loading' ? (
        <Text style={styles.meta}>Loading eligible destinations…</Text>
      ) : destinationStatus === 'error' ? (
        <Text style={styles.error}>
          Eligible destinations could not be loaded. Reload before transferring.
        </Text>
      ) : destinations.length === 0 ? (
        <Text style={styles.meta}>No eligible destination batches are available.</Text>
      ) : (
        <View style={styles.actions}>
          {destinations.map((option) => (
            <Pressable
              key={option.id}
              onPress={() => selectDestination(option)}
              disabled={locked}
              style={[
                styles.secondaryButton,
                values.destination_batch_id === option.id && styles.optionSelected,
              ]}
            >
              <Text
                style={[
                  styles.secondaryButtonText,
                  values.destination_batch_id === option.id && styles.optionSelectedText,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {!recoveryRequired ? (
        <Pressable
          onPress={() => void loadDestinations()}
          disabled={locked}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Reload destinations</Text>
        </Pressable>
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
        A transfer atomically removes quantity plus loss from this batch and adds quantity to the
        destination. It cannot be edited or reversed through the production API.
      </Text>
      <Pressable
        onPress={() => {
          if (locked || submissionInFlight.current) return;
          const invalid = validateDraft();
          if (invalid) {
            setError(invalid);
            return;
          }
          const next = !confirmed;
          setConfirmed(next);
          setError(null);
          setStatusMessage(null);
          setConfirmedSnapshot(next ? createTransferDraftSignature(batchId, toInput()) : null);
        }}
        disabled={locked}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>
          I confirm transferring from {batchLabel} to{' '}
          {values.destination_label || 'the selected destination'}.
        </Text>
      </Pressable>
      {confirmed || recoveryRequired ? (
        <View style={styles.confirmationSummary}>
          <Text style={styles.summaryText}>Farm: {farmName ?? 'Unknown farm'}</Text>
          <Text style={styles.summaryText}>
            Source: {batchLabel} · {unitName ?? 'Unit'} ({sourceUnitId ?? 'unit unknown'})
          </Text>
          <Text style={styles.summaryText}>
            Destination: {values.destination_label || 'Not selected'}
          </Text>
          <Text style={styles.summaryText}>
            Net transferred: {values.quantity || 'Not entered'}
          </Text>
          <Text style={styles.summaryText}>Loss in transit: {values.transfer_loss || '0'}</Text>
          <Text style={styles.summaryText}>
            Source remaining after transfer: {remainingAfter ?? 'Unknown'}
          </Text>
          <Text style={styles.summaryText}>
            Average weight:{' '}
            {values.average_weight
              ? `${values.average_weight} ${values.weight_unit}`
              : 'Not entered'}
          </Text>
          <Text style={styles.summaryText}>
            Physical time sent as UTC: {normalizedPhysicalTime}
          </Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={busy || (!isEligibleState && !recoveryRequired)}
      >
        <Text style={styles.primaryButtonText}>
          {busy
            ? 'Saving…'
            : recoveryRequired
              ? reconcileOnly
                ? 'Reconcile previous transfer'
                : 'Retry same transfer'
              : 'Submit transfer'}
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
