import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
} from '../../lib/production-api';
import {
  createWaterQualityDraftSignature,
  createWaterQualitySubmission,
  hasActualWaterQualityMeasurement,
  reconcileWaterQualityWrite,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';

export interface WaterQualityFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  unitName?: string;
  onSaved?: (submission: ReturnType<typeof createWaterQualitySubmission>) => void;
  onCancel?: () => void;
}

export function WaterQualityForm({
  batchId,
  batchName,
  farmName,
  unitName,
  onSaved,
  onCancel,
}: WaterQualityFormProps) {
  const initialMeasuredAt = new Date().toISOString().slice(0, 16);
  const [values, setValues] = useState<Record<string, string>>({
    temperature: '',
    ph: '',
    dissolved_oxygen: '',
    ammonia: '',
    nitrite: '',
    turbidity: '',
    measured_at: initialMeasuredAt,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const submissionInFlight = useRef(false);

  const updateField = (key: string, nextValue: string) => {
    setValues((current) => ({ ...current, [key]: nextValue }));
    if (confirmed) {
      setConfirmed(false);
      setConfirmedSnapshot(null);
      setError(null);
      setStatusMessage(null);
    }
  };

  const handleSubmit = async () => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;

    try {
      if (busy) return;
      if (!confirmed) {
        setError('Please confirm the water-quality record before submission.');
        return;
      }

      const draftSignature = createWaterQualityDraftSignature(batchId, {
        temperature: values.temperature,
        ph: values.ph,
        dissolved_oxygen: values.dissolved_oxygen,
        ammonia: values.ammonia,
        nitrite: values.nitrite,
        turbidity: values.turbidity,
        measured_at: values.measured_at,
      });

      if (confirmedSnapshot && confirmedSnapshot !== draftSignature) {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        setError('The reading changed after confirmation. Please confirm again before submitting.');
        return;
      }

      const measurementSet = {
        temperature: values.temperature,
        ph: values.ph,
        dissolved_oxygen: values.dissolved_oxygen,
        ammonia: values.ammonia,
        nitrite: values.nitrite,
        turbidity: values.turbidity,
        measured_at: values.measured_at,
      };

      if (!hasActualWaterQualityMeasurement(measurementSet)) {
        setError(
          'At least one actual measurement is required before submitting a water-quality record.',
        );
        return;
      }

      const parsedTimestamp = measurementSet.measured_at?.trim();
      if (parsedTimestamp && parsedTimestamp.length > 0) {
        const dateCandidate = new Date(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(parsedTimestamp)
            ? `${parsedTimestamp}:00Z`
            : parsedTimestamp,
        );
        if (Number.isNaN(dateCandidate.getTime())) {
          setError(
            'The measured-at timestamp is invalid. Use ISO format such as 2026-09-25T14:30Z.',
          );
          return;
        }
      }

      setBusy(true);
      setError(null);
      setStatusMessage(null);

      try {
        const context: WaterQualityWriteContext = {
          batchId,
          batchName,
          farmName,
          unitName,
        };
        const submission = createWaterQualitySubmission(
          batchId,
          measurementSet,
          undefined,
          context,
        );

        const result = await reconcileWaterQualityWrite({
          context,
          payload: submission.payload,
          idempotencyKey: submission.idempotencyKey,
          post: async (targetBatchId, eventType, data, key) =>
            createBatchEvent(targetBatchId, { event_type: eventType, data }, key),
          readAll: async (targetBatchId) => {
            await Promise.all([
              getProductionBatch(targetBatchId),
              getBatchProjections(targetBatchId),
              listBatchEvents(targetBatchId),
            ]);
          },
        });

        if (result.outcome === 'accepted') {
          setStatusMessage('Water quality has been recorded and reconciled.');
          onSaved?.(result.submission);
          return;
        }

        if (result.outcome === 'rejected') {
          setError(
            'The server rejected this water-quality record. Please review the values and submit a fresh record.',
          );
          return;
        }

        if (result.outcome === 'reconciliation_failed') {
          setError(
            'The write was accepted but reconciliation failed. The immutable submission remains preserved for a read-only retry.',
          );
          return;
        }

        setError(
          'The water-quality write outcome is uncertain. The submission has been preserved for retry without re-posting.',
        );
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : 'Unable to record water quality.';
        setError(message);
      } finally {
        setBusy(false);
      }
    } finally {
      submissionInFlight.current = false;
    }
  };

  const formRows = [
    ['temperature', 'Temperature (°C)'],
    ['ph', 'pH'],
    ['dissolved_oxygen', 'Dissolved oxygen (mg/L)'],
    ['ammonia', 'Ammonia (mg/L)'],
    ['nitrite', 'Nitrite (mg/L)'],
    ['turbidity', 'Turbidity (NTU)'],
  ] as const;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Record water quality</Text>
      <Text style={styles.subtitle}>
        {batchName
          ? `${batchName} · ${farmName ?? 'Farm'} · ${unitName ?? 'Unit'}`
          : 'Batch water quality'}
      </Text>

      <Text style={styles.label}>Measured at</Text>
      <TextInput
        style={styles.input}
        value={values.measured_at}
        onChangeText={(next) => updateField('measured_at', next)}
        placeholder="2026-09-25T14:30Z"
        keyboardType="default"
      />

      {formRows.map(([field, label]) => (
        <View key={field} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            style={styles.input}
            value={String(values[field] ?? '')}
            onChangeText={(next) => updateField(field, next)}
            keyboardType="numeric"
            placeholder="0"
          />
        </View>
      ))}

      <Pressable
        onPress={() => {
          const nextState = !confirmed;
          setConfirmed(nextState);
          setError(null);
          setStatusMessage(null);
          if (nextState) {
            setConfirmedSnapshot(createWaterQualityDraftSignature(batchId, values));
          } else {
            setConfirmedSnapshot(null);
          }
        }}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>I confirm this is the exact reading to save.</Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}

      <View style={styles.actions}>
        {onCancel ? (
          <Pressable style={styles.secondaryButton} onPress={onCancel}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
          onPress={() => {
            void handleSubmit();
          }}
          disabled={busy}
        >
          <Text style={styles.primaryButtonText}>{busy ? 'Saving…' : 'Submit water quality'}</Text>
        </Pressable>
      </View>
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
  error: { color: '#8d2c2c', marginTop: 12, fontSize: 12 },
  success: { color: '#1f5d40', marginTop: 12, fontSize: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 16 },
  primaryButton: {
    backgroundColor: '#0f2e1e',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: '#f5f2e8', fontWeight: '700' },
  secondaryButton: {
    backgroundColor: '#f2efe8',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonText: { color: '#0f2e1e', fontWeight: '700' },
});
