import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createBatchEvent,
  getBatchProjections,
  getProductionBatch,
  listBatchEvents,
} from '../../lib/production-api';
import {
  createFeedingDraftSignature,
  createFeedingSubmission,
  reconcileFeedingWrite,
  type FeedingInput,
  type FeedingSubmission,
  type WaterQualityReconciliationData,
  type WaterQualityWriteContext,
} from '../../features/production/production-write';

export interface FeedingFormProps {
  batchId: string;
  batchName?: string;
  farmName?: string;
  unitName?: string;
  onSaved?: (submission: FeedingSubmission, reconciliation: WaterQualityReconciliationData) => void;
}

export function FeedingForm({ batchId, batchName, farmName, unitName, onSaved }: FeedingFormProps) {
  const [values, setValues] = useState<Record<string, string>>({
    feed_description: '',
    feed_item_ref: '',
    quantity: '',
    unit: 'kg',
    feeding_method: 'broadcast',
    feeding_round: '',
  });
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const submissionInFlight = useRef(false);
  const retrySubmission = useRef<FeedingSubmission | null>(null);
  const draftRevision = useRef(0);

  const updateField = (key: string, value: string) => {
    draftRevision.current += 1;
    retrySubmission.current = null;
    setValues((current) => ({ ...current, [key]: value }));
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
        setError('Please confirm the feeding record before submission.');
        return;
      }
      const draftSignature = createFeedingDraftSignature(
        batchId,
        values as unknown as FeedingInput,
      );
      if (confirmedSnapshot !== draftSignature) {
        setConfirmed(false);
        setConfirmedSnapshot(null);
        setError(
          'The feeding record changed after confirmation. Please confirm again before submitting.',
        );
        return;
      }
      const submissionRevision = draftRevision.current;
      const context: WaterQualityWriteContext = { batchId, batchName, farmName, unitName };
      const submission =
        retrySubmission.current?.batchId === batchId
          ? retrySubmission.current
          : createFeedingSubmission(batchId, values as unknown as FeedingInput, undefined, context);
      setBusy(true);
      setError(null);
      setStatusMessage(null);
      const result = await reconcileFeedingWrite({
        context,
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post: async (targetBatchId, eventType, data, key) =>
          createBatchEvent(targetBatchId, { event_type: eventType, data }, key),
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
        setStatusMessage('Feeding has been recorded and reconciled.');
        if (result.reconciliation) onSaved?.(result.submission, result.reconciliation);
      } else if (result.outcome === 'rejected') {
        setError(
          'The server rejected this feeding record. Review the values and submit a fresh record.',
        );
      } else {
        setError(
          'The feeding write outcome is uncertain. The submission has been preserved for retry.',
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to record feeding.');
    } finally {
      setBusy(false);
      submissionInFlight.current = false;
    }
  };

  const fields = [
    ['feed_description', 'Feed description', 'text'],
    ['feed_item_ref', 'Feed item reference', 'text'],
    ['quantity', 'Quantity', 'numeric'],
    ['feeding_round', 'Feeding round (optional)', 'numeric'],
  ] as const;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Record feeding</Text>
      <Text style={styles.subtitle}>
        {batchName
          ? `${batchName} · ${farmName ?? 'Farm'} · ${unitName ?? 'Unit'}`
          : 'Batch feeding'}
      </Text>
      {fields.map(([field, label, keyboardType]) => (
        <View key={field} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            style={styles.input}
            value={values[field]}
            onChangeText={(value) => updateField(field, value)}
            keyboardType={keyboardType === 'numeric' ? 'numeric' : 'default'}
            placeholder={field === 'quantity' ? '0' : ''}
          />
        </View>
      ))}
      <Text style={styles.label}>Unit</Text>
      <View style={styles.actions}>
        {(['kg', 'g'] as const).map((unit) => (
          <Pressable
            key={unit}
            onPress={() => updateField('unit', unit)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>{unit}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>Feeding method</Text>
      <View style={styles.actions}>
        {(['broadcast', 'tray', 'automatic', 'hand'] as const).map((method) => (
          <Pressable
            key={method}
            onPress={() => updateField('feeding_method', method)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>{method}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={() => {
          const next = !confirmed;
          setConfirmed(next);
          setError(null);
          setStatusMessage(null);
          setConfirmedSnapshot(
            next ? createFeedingDraftSignature(batchId, values as unknown as FeedingInput) : null,
          );
        }}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
          {confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
        <Text style={styles.checkboxText}>I confirm this is the exact feeding to save.</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusMessage ? <Text style={styles.success}>{statusMessage}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={busy}
      >
        <Text style={styles.primaryButtonText}>{busy ? 'Saving…' : 'Submit feeding'}</Text>
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
  secondaryButtonText: { color: '#0f2e1e' },
});
