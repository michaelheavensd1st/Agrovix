import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
} from '../../lib/production-api';
import {
  buildSamplingPayload,
  clearSamplingWriteRecovery,
  createSamplingDraftSignature,
  createSamplingSubmission,
  getSamplingWriteRecovery,
  normalizeProductionEventTime,
  reconcileSamplingWrite,
  type SamplingInput,
  type SamplingSubmission,
  type WaterQualityReconciliationData,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';

function getLocalDateTimeInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function getSamplingFormValues(submission?: SamplingSubmission | null): Record<string, string> {
  if (!submission) {
    return {
      performed_at: getLocalDateTimeInputValue(),
      sample_size: '',
      average_weight: '',
      minimum_weight: '',
      maximum_weight: '',
      weight_unit: 'g',
      estimated_population: '',
      notes: '',
    };
  }

  return {
    performed_at: submission.performedAt ?? '',
    sample_size: String(submission.payload.sample_size),
    average_weight: String(submission.payload.average_weight),
    minimum_weight: submission.payload.minimum_weight?.toString() ?? '',
    maximum_weight: submission.payload.maximum_weight?.toString() ?? '',
    weight_unit: submission.payload.weight_unit,
    estimated_population: submission.payload.estimated_population?.toString() ?? '',
    notes: submission.payload.notes ?? '',
  };
}

export interface SamplingFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  siteName?: string;
  unitName?: string;
  currentEstimatedRemainingPopulation?: number | null;
  onSaved?: (
    submission: SamplingSubmission,
    reconciliation: WaterQualityReconciliationData,
  ) => void;
}

export function SamplingForm({
  batchId,
  batchName,
  farmName,
  siteName,
  unitName,
  currentEstimatedRemainingPopulation,
  onSaved,
}: SamplingFormProps) {
  const recoveryAtMount = getSamplingWriteRecovery(batchId);
  const [values, setValues] = useState<Record<string, string>>(() =>
    getSamplingFormValues(recoveryAtMount?.submission),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(recoveryAtMount?.inFlight ?? false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(Boolean(recoveryAtMount));
  const submissionInFlight = useRef(recoveryAtMount?.inFlight ?? false);
  const retrySubmission = useRef<SamplingSubmission | null>(recoveryAtMount?.submission ?? null);
  const draftRevision = useRef(0);
  const mounted = useRef(true);

  const context: WaterQualityWriteContext = {
    batchId,
    batchName,
    farmName,
    siteName,
    unitName,
  };
  const batchLabel = batchName ?? batchId;

  const toInput = (): SamplingInput => ({
    performed_at: values.performed_at,
    sample_size: values.sample_size,
    average_weight: values.average_weight,
    minimum_weight: values.minimum_weight || null,
    maximum_weight: values.maximum_weight || null,
    weight_unit: values.weight_unit || 'g',
    estimated_population: values.estimated_population || null,
    notes: values.notes,
  });

  const updateField = (field: string, value: string) => {
    if (submissionInFlight.current || busy || recoveryRequired) return;
    draftRevision.current += 1;
    if (retrySubmission.current) {
      clearSamplingWriteRecovery(batchId, retrySubmission.current.idempotencyKey);
    }
    retrySubmission.current = null;
    setValues((current) => ({ ...current, [field]: value }));
    setConfirmed(false);
    setConfirmedSnapshot(null);
    setError(null);
    setStatusMessage(null);
  };

  const handleWriteResult = (
    result: Awaited<ReturnType<typeof reconcileSamplingWrite>>,
    submissionRevision: number,
  ) => {
    if (!mounted.current) return;
    retrySubmission.current =
      draftRevision.current === submissionRevision ? result.retrySubmission : null;
    setRecoveryRequired(Boolean(result.retrySubmission));
    if (result.outcome === 'accepted') {
      setConfirmed(false);
      setConfirmedSnapshot(null);
      retrySubmission.current = null;
      setStatusMessage('Sampling has been recorded and reconciled against the current batch.');
      if (result.reconciliation) onSaved?.(result.submission, result.reconciliation);
    } else if (result.outcome === 'rejected') {
      setConfirmed(false);
      setConfirmedSnapshot(null);
      retrySubmission.current = null;
      setError(
        'The server rejected this sampling record. Refresh the batch and review the current state before submitting a corrected record.',
      );
    } else if (result.outcome === 'reconciliation_failed') {
      setError(
        'The sampling event was accepted, but reconciliation failed. The immutable submission is preserved for a read-only retry.',
      );
    } else if (result.outcome === 'outcome_unknown') {
      setError(
        'The sampling write outcome is uncertain. The immutable submission has been preserved for retry with the same key.',
      );
    } else {
      setError(
        'The sampling write failed. No retry submission was preserved; review the record before starting a new submission.',
      );
    }
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
    const recovery = getSamplingWriteRecovery(batchId);
    if (!recovery) {
      setRecoveryRequired(false);
      if (submissionInFlight.current) {
        submissionInFlight.current = false;
        retrySubmission.current = null;
        setConfirmed(false);
        setConfirmedSnapshot(null);
        setBusy(false);
      }
      return;
    }

    retrySubmission.current = recovery.submission as SamplingSubmission;
    if (!recovery.inFlight || !recovery.promise) {
      setRecoveryRequired(true);
      setBusy(false);
      submissionInFlight.current = false;
      setError(
        recovery.retryOutcome === 'reconciliation_failed'
          ? 'A previous sampling was accepted but could not be reconciled. Use Reconcile previous sampling to refresh with the original submission.'
          : 'A previous sampling submission has an uncertain outcome. Its original details and key are retained. Use Retry previous sampling to resolve it before editing.',
      );
      return;
    }

    setRecoveryRequired(true);
    submissionInFlight.current = true;
    setBusy(true);
    let subscribed = true;
    void recovery.promise
      .then((result) => {
        if (subscribed && mounted.current) {
          handleWriteResultRef.current(
            result as Awaited<ReturnType<typeof reconcileSamplingWrite>>,
            draftRevision.current,
          );
        }
      })
      .catch((caught) => {
        if (subscribed && mounted.current) {
          setError(caught instanceof Error ? caught.message : 'Unable to record sampling.');
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
      if (!confirmed && !recovering) {
        setError('Please confirm this sampling record before submission.');
        return;
      }
      const input = toInput();
      const normalizedPerformedAt = normalizeProductionEventTime(input.performed_at ?? null);
      if (!normalizedPerformedAt) {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        setError('Enter a valid observation date and time before submitting.');
        return;
      }
      const signature = createSamplingDraftSignature(batchId, input);
      if (!recovering && confirmedSnapshot !== signature) {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        if (retrySubmission.current) {
          clearSamplingWriteRecovery(batchId, retrySubmission.current.idempotencyKey);
        }
        retrySubmission.current = null;
        setError(
          'The sampling record changed after confirmation. Confirm the updated record before submitting.',
        );
        return;
      }

      let payload;
      try {
        payload = buildSamplingPayload(input);
      } catch (validationError) {
        setError(
          validationError instanceof Error
            ? validationError.message
            : 'Sampling details are invalid.',
        );
        return;
      }

      const submissionRevision = draftRevision.current;
      let submission: SamplingSubmission;
      if (recovering) {
        const recovered = retrySubmission.current;
        if (
          !recovered ||
          recovered.batchId !== batchId ||
          JSON.stringify(recovered.payload) !== JSON.stringify(payload) ||
          recovered.performedAt !== normalizedPerformedAt
        ) {
          setError(
            'The retained sampling submission does not match this batch and cannot be retried safely.',
          );
          return;
        }
        submission = recovered;
      } else {
        submission =
          retrySubmission.current?.batchId === batchId
            ? retrySubmission.current
            : createSamplingSubmission(batchId, input, undefined, context);
      }
      setBusy(true);
      setError(null);
      setStatusMessage(null);

      const result = await reconcileSamplingWrite({
        context,
        payload,
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
        readAll: async (targetBatchId) => {
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
        },
      });

      if (mounted.current) handleWriteResultRef.current(result, submissionRevision);
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : 'Unable to record sampling.');
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        submissionInFlight.current = false;
      }
    }
  };

  const fields = [
    ['performed_at', 'Observation time', 'default'],
    ['sample_size', 'Sample size (individuals weighed)', 'numeric'],
    ['average_weight', 'Average weight', 'numeric'],
    ['minimum_weight', 'Minimum weight (optional)', 'numeric'],
    ['maximum_weight', 'Maximum weight (optional)', 'numeric'],
    ['estimated_population', 'Re-estimated remaining population (optional)', 'numeric'],
    ['notes', 'Notes (optional)', 'default'],
  ] as const;
  const weightUnits = ['g', 'kg'] as const;
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time';
  const enteredOffset = /(?:Z|([+-]\d{2}:?\d{2}))$/i.exec(values.performed_at.trim());
  const observationTimeZone = enteredOffset
    ? enteredOffset[0].toUpperCase() === 'Z'
      ? 'UTC'
      : `entered offset ${enteredOffset[1]}`
    : `device local time (${deviceTimeZone})`;
  const normalizedPerformedAt = normalizeProductionEventTime(values.performed_at);
  const estimatedPopulationEntered = values.estimated_population.trim().length > 0;
  const estimatedPopulation = Number(values.estimated_population);
  const populationChange =
    estimatedPopulationEntered &&
    Number.isFinite(estimatedPopulation) &&
    typeof currentEstimatedRemainingPopulation === 'number' &&
    Number.isFinite(currentEstimatedRemainingPopulation)
      ? estimatedPopulation - currentEstimatedRemainingPopulation
      : null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Record sampling</Text>
      <Text style={styles.subtitle}>
        {`${batchLabel} · ${farmName ?? 'Farm'} · ${siteName ?? 'Site'} · ${unitName ?? 'Unit'}`}
      </Text>
      {retrySubmission.current ? (
        <Text style={styles.warning}>
          {busy
            ? 'A sampling submission from this batch is still resolving. No new write will be sent.'
            : recoveryRequired
              ? getSamplingWriteRecovery(batchId)?.retryOutcome === 'reconciliation_failed'
                ? 'A previous sampling was accepted but could not be reconciled. Editing is locked; use Reconcile previous sampling to refresh with the original submission.'
                : 'A previous sampling submission has an uncertain outcome. Its original submission and key are retained. Editing is locked until you retry it explicitly.'
              : 'A previous sampling submission has an uncertain outcome. Confirming and retrying will reuse its original submission and key.'}
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
            editable={!busy && !recoveryRequired}
            placeholder={field === 'sample_size' ? '30' : ''}
          />
        </View>
      ))}
      <Text style={styles.label}>Weight unit</Text>
      <View style={styles.actions}>
        {weightUnits.map((unit) => (
          <Pressable
            key={unit}
            onPress={() => updateField('weight_unit', unit)}
            disabled={busy || recoveryRequired}
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
      {estimatedPopulationEntered ? (
        <Text style={styles.warning}>
          Supplying a re-estimated population will replace the projected remaining population on
          this batch. Current projected remaining population:{' '}
          {typeof currentEstimatedRemainingPopulation === 'number'
            ? currentEstimatedRemainingPopulation
            : 'unknown'}
          . Proposed: {values.estimated_population}.
        </Text>
      ) : null}
      <Pressable
        onPress={() => {
          if (submissionInFlight.current || busy || recoveryRequired) return;
          const next = !confirmed;
          if (next) {
            if (!normalizeProductionEventTime(values.performed_at)) {
              setConfirmed(false);
              setConfirmedSnapshot(null);
              setError('Enter a valid observation date and time before confirming.');
              return;
            }
            try {
              buildSamplingPayload(toInput());
            } catch (validationError) {
              setConfirmed(false);
              setConfirmedSnapshot(null);
              setError(
                validationError instanceof Error
                  ? validationError.message
                  : 'Enter a valid sampling record before confirming.',
              );
              return;
            }
          }
          setConfirmed(next);
          setError(null);
          setStatusMessage(null);
          setConfirmedSnapshot(next ? createSamplingDraftSignature(batchId, toInput()) : null);
        }}
        disabled={busy || recoveryRequired}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>
          {recoveryRequired
            ? `Previously confirmed sampling for ${batchLabel}; recovery is locked until its outcome is resolved.`
            : `I confirm this sampling record for ${batchLabel}.`}
        </Text>
      </Pressable>
      {confirmed || recoveryRequired ? (
        <View style={styles.confirmationSummary}>
          <Text style={styles.summaryText}>
            Observation time ({observationTimeZone}): {values.performed_at}
          </Text>
          <Text style={styles.summaryText}>Sent as UTC: {normalizedPerformedAt}</Text>
          <Text style={styles.summaryText}>Sample size: {values.sample_size || 'Not entered'}</Text>
          <Text style={styles.summaryText}>
            Average weight:{' '}
            {values.average_weight.trim().length > 0 ? values.average_weight : 'Not entered'}{' '}
            {values.weight_unit || 'g'}
          </Text>
          {values.minimum_weight.trim().length > 0 ? (
            <Text style={styles.summaryText}>
              Minimum weight: {values.minimum_weight} {values.weight_unit || 'g'}
            </Text>
          ) : null}
          {values.maximum_weight.trim().length > 0 ? (
            <Text style={styles.summaryText}>
              Maximum weight: {values.maximum_weight} {values.weight_unit || 'g'}
            </Text>
          ) : null}
          <Text style={styles.summaryText}>
            Current projected remaining population:{' '}
            {typeof currentEstimatedRemainingPopulation === 'number'
              ? currentEstimatedRemainingPopulation
              : 'unknown'}
          </Text>
          {estimatedPopulationEntered ? (
            <Text style={styles.summaryText}>
              Proposed estimated population: {values.estimated_population} (this will replace the
              projected remaining population)
            </Text>
          ) : (
            <Text style={styles.summaryText}>
              No population re-estimate supplied — projected remaining population will not change.
            </Text>
          )}
          {populationChange !== null ? (
            <Text
              style={styles.summaryText}
            >{`Population change: ${populationChange > 0 ? '+' : ''}${populationChange}`}</Text>
          ) : null}
          {values.notes ? <Text style={styles.summaryText}>Notes: {values.notes}</Text> : null}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={busy}
      >
        <Text style={styles.primaryButtonText}>
          {busy
            ? 'Saving…'
            : recoveryRequired
              ? getSamplingWriteRecovery(batchId)?.retryOutcome === 'reconciliation_failed'
                ? 'Reconcile previous sampling'
                : 'Retry previous sampling'
              : 'Submit sampling'}
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
    borderRadius: 16,
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
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 10,
  },
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
