import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
} from '../../lib/production-api';
import {
  buildMortalityPayload,
  createMortalityDraftSignature,
  createMortalitySubmission,
  normalizeMortalityObservedAt,
  reconcileMortalityWrite,
  type MortalityInput,
  type MortalitySubmission,
  type WaterQualityReconciliationData,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';

function getLocalDateTimeInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export interface MortalityFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  siteName?: string;
  unitName?: string;
  currentEstimatedRemainingPopulation?: number | null;
  onConflictRefreshed?: (reconciliation: WaterQualityReconciliationData) => void;
  onSaved?: (
    submission: MortalitySubmission,
    reconciliation: WaterQualityReconciliationData,
  ) => void;
}

export function MortalityForm({
  batchId,
  batchName,
  farmName,
  siteName,
  unitName,
  currentEstimatedRemainingPopulation,
  onConflictRefreshed,
  onSaved,
}: MortalityFormProps) {
  const [values, setValues] = useState<Record<string, string>>({
    count: '',
    observed_at: getLocalDateTimeInputValue(),
    suspected_cause: '',
    disposal_method: '',
    photos: '',
    lab_report_ref: '',
    veterinarian_id: '',
    evidence_notes: '',
  });
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const submissionInFlight = useRef(false);
  const retrySubmission = useRef<MortalitySubmission | null>(null);
  const draftRevision = useRef(0);

  const context: WaterQualityWriteContext = {
    batchId,
    batchName,
    farmName,
    siteName,
    unitName,
  };
  const batchLabel = batchName ?? batchId;
  const currentPopulation =
    typeof currentEstimatedRemainingPopulation === 'number' &&
    Number.isFinite(currentEstimatedRemainingPopulation)
      ? currentEstimatedRemainingPopulation
      : null;

  const toInput = (): MortalityInput => ({
    count: values.count,
    observed_at: values.observed_at,
    suspected_cause: values.suspected_cause,
    disposal_method: values.disposal_method || null,
    evidence: {
      photos: values.photos
        .split('\n')
        .map((photo) => photo.trim())
        .filter(Boolean),
      lab_report_ref: values.lab_report_ref,
      veterinarian_id: values.veterinarian_id,
      notes: values.evidence_notes,
    },
  });

  const updateField = (field: string, value: string) => {
    if (submissionInFlight.current || busy) return;
    draftRevision.current += 1;
    retrySubmission.current = null;
    setValues((current) => ({ ...current, [field]: value }));
    setConfirmed(false);
    setConfirmedSnapshot(null);
    setError(null);
    setStatusMessage(null);
  };

  const handleSubmit = async () => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    try {
      if (busy) return;
      if (!confirmed) {
        setError('Please confirm this mortality record before submission.');
        return;
      }
      const input = toInput();
      const signature = createMortalityDraftSignature(batchId, input);
      if (confirmedSnapshot !== signature) {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        retrySubmission.current = null;
        setError(
          'The mortality record changed after confirmation. Confirm the updated record before submitting.',
        );
        return;
      }

      let payload;
      try {
        payload = buildMortalityPayload(input);
      } catch (validationError) {
        setError(
          validationError instanceof Error
            ? validationError.message
            : 'Mortality details are invalid.',
        );
        return;
      }

      const submissionRevision = draftRevision.current;
      const submission =
        retrySubmission.current?.batchId === batchId
          ? retrySubmission.current
          : createMortalitySubmission(batchId, input, undefined, context);
      setBusy(true);
      setError(null);
      setStatusMessage(null);

      const result = await reconcileMortalityWrite({
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

      retrySubmission.current =
        draftRevision.current === submissionRevision ? result.retrySubmission : null;
      if (result.outcome === 'accepted') {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        retrySubmission.current = null;
        setStatusMessage('Mortality has been recorded and reconciled against the current batch.');
        if (result.reconciliation) onSaved?.(result.submission, result.reconciliation);
      } else if (result.outcome === 'rejected') {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        retrySubmission.current = null;
        if (result.response?.status === 409) {
          try {
            const [batch, projection, eventData] = await Promise.all([
              getProductionBatch(batchId),
              getBatchProjections(batchId),
              listBatchEvents(batchId),
            ]);
            onConflictRefreshed?.({
              batch,
              projection,
              events: Array.isArray(eventData.items) ? eventData.items : [],
            });
            setError(
              'The server rejected this mortality write (409). Current authoritative population and events have been refreshed. Review them and confirm a new record before submitting.',
            );
          } catch {
            setError(
              'The server rejected this mortality record because the batch may have changed. Refresh the batch and review its current population before submitting again.',
            );
          }
        } else {
          setError(
            'The server rejected this mortality record. Review the current batch state before submitting a corrected record.',
          );
        }
      } else if (result.outcome === 'reconciliation_failed') {
        setError(
          'The mortality event was accepted, but reconciliation failed. The immutable submission is preserved for a read-only retry.',
        );
      } else if (result.outcome === 'outcome_unknown') {
        setError(
          'The mortality write outcome is uncertain. The immutable submission is preserved for retry with the same key.',
        );
      } else {
        setError(
          'The mortality write failed. No retry submission was preserved; review the record before starting a new submission.',
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to record mortality.');
    } finally {
      setBusy(false);
      submissionInFlight.current = false;
    }
  };

  const fields = [
    ['count', 'Number of mortalities', 'numeric'],
    ['observed_at', 'Observed at', 'default'],
    ['suspected_cause', 'Suspected cause (optional)', 'default'],
    ['photos', 'Photo references or URIs (optional, one per line)', 'default'],
    ['lab_report_ref', 'Lab report reference (optional)', 'default'],
    ['veterinarian_id', 'Veterinarian ID (optional)', 'default'],
    ['evidence_notes', 'Evidence notes (optional)', 'default'],
  ] as const;
  const disposalMethods = ['burial', 'incineration', 'compost', 'rendering', 'other'] as const;
  const mortalityCount = Number(values.count);
  const projectedPopulationAfter =
    currentPopulation !== null && Number.isInteger(mortalityCount) && mortalityCount > 0
      ? currentPopulation - mortalityCount
      : null;
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time';

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Record mortality</Text>
      <Text style={styles.subtitle}>
        {`${batchLabel} · ${farmName ?? 'Farm'} · ${siteName ?? 'Site'} · ${unitName ?? 'Unit'}`}
      </Text>
      <Text style={styles.subtitle}>
        Current authoritative projected population: {currentPopulation ?? 'unavailable'}
      </Text>
      {projectedPopulationAfter !== null ? (
        <Text style={styles.previewWarning}>
          Preview only: after {values.count} mortalities, estimated remaining population would be{' '}
          {projectedPopulationAfter}. The server validates the current population when submitted.
        </Text>
      ) : null}
      {fields.map(([field, label, keyboardType]) => (
        <View key={field} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            style={[styles.input, field === 'photos' && styles.multilineInput]}
            value={values[field]}
            onChangeText={(value) => updateField(field, value)}
            keyboardType={keyboardType === 'numeric' ? 'numeric' : 'default'}
            editable={!busy}
            multiline={field === 'photos' || field === 'evidence_notes'}
            placeholder={field === 'count' ? '1' : ''}
          />
        </View>
      ))}
      <Text style={styles.label}>Disposal method (optional)</Text>
      <View style={styles.actions}>
        <Pressable
          onPress={() => updateField('disposal_method', '')}
          disabled={busy}
          style={[styles.secondaryButton, !values.disposal_method && styles.optionSelected]}
        >
          <Text
            style={[
              styles.secondaryButtonText,
              !values.disposal_method && styles.optionSelectedText,
            ]}
          >
            None
          </Text>
        </Pressable>
        {disposalMethods.map((method) => (
          <Pressable
            key={method}
            onPress={() => updateField('disposal_method', method)}
            disabled={busy}
            style={[
              styles.secondaryButton,
              values.disposal_method === method && styles.optionSelected,
            ]}
          >
            <Text
              style={[
                styles.secondaryButtonText,
                values.disposal_method === method && styles.optionSelectedText,
              ]}
            >
              {method}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={() => {
          if (submissionInFlight.current || busy) return;
          const next = !confirmed;
          if (next && !normalizeMortalityObservedAt(values.observed_at)) {
            setConfirmed(false);
            setConfirmedSnapshot(null);
            setError('Enter a valid observed-at date before confirming this mortality record.');
            return;
          }
          setConfirmed(next);
          setError(null);
          setStatusMessage(null);
          setConfirmedSnapshot(next ? createMortalityDraftSignature(batchId, toInput()) : null);
        }}
        disabled={busy}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>
          I confirm this mortality record for {batchLabel}. I understand an accepted mortality event
          is not editable or reversible through the production API.
        </Text>
      </Pressable>
      {confirmed ? (
        <View style={styles.confirmationSummary}>
          <Text style={styles.summaryText}>Mortality count: {values.count || 'Not entered'}</Text>
          <Text style={styles.summaryText}>
            Observation time ({deviceTimeZone}): {values.observed_at || 'Not entered'}
          </Text>
          <Text style={styles.summaryText}>
            Sent as UTC: {normalizeMortalityObservedAt(values.observed_at) ?? 'Invalid'}
          </Text>
          {values.suspected_cause ? (
            <Text style={styles.summaryText}>Cause: {values.suspected_cause}</Text>
          ) : null}
          {values.disposal_method ? (
            <Text style={styles.summaryText}>Disposal: {values.disposal_method}</Text>
          ) : null}
          {values.photos ||
          values.lab_report_ref ||
          values.veterinarian_id ||
          values.evidence_notes ? (
            <Text style={styles.summaryText}>Evidence details supplied</Text>
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={busy}
      >
        <Text style={styles.primaryButtonText}>{busy ? 'Saving…' : 'Submit mortality'}</Text>
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
  multilineInput: { minHeight: 76, textAlignVertical: 'top' },
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
  previewWarning: { color: '#8a5a00', fontSize: 12, marginTop: 8 },
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
  secondaryButtonText: { color: '#0f2e1e' },
  optionSelected: { backgroundColor: '#dfeecf', borderColor: '#1f5d40', borderWidth: 1 },
  optionSelectedText: { color: '#1f5d40', fontWeight: '700' },
});
