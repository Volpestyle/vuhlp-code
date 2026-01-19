import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import type { GlobalMode, OrchestrationMode, RunState } from '@vuhlp/contracts';
import { Network, Code, Plus } from 'iconoir-react-native';
import { colors, fontFamily, fontSize, radius, spacing } from '@/lib/theme';
import { api } from '@/lib/api';

interface NewSessionModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: (run: RunState) => void;
}

export function NewSessionModal({ visible, onClose, onSuccess }: NewSessionModalProps) {
  const [globalMode, setGlobalMode] = useState<GlobalMode>('IMPLEMENTATION');
  const [mode, setMode] = useState<OrchestrationMode>('AUTO');
  const [cwd, setCwd] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setGlobalMode('IMPLEMENTATION');
      setMode('AUTO');
      setCwd('');
      setError(null);
    }
  }, [visible]);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      console.log('[NewSessionModal] Creating session:', { mode, globalMode, cwd: cwd.trim() || undefined });
      const created = await api.createRun({
        mode,
        globalMode,
        cwd: cwd.trim() || undefined,
      });
      console.log('[NewSessionModal] Session created:', created.id);
      onSuccess(created);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      console.error('[NewSessionModal] Error creating session:', message);
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [mode, globalMode, cwd, onSuccess, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={styles.modal}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>New Session</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {/* Error display */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Global Mode selection */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Global Mode</Text>
              <View style={styles.modeToggle}>
                <TouchableOpacity
                  style={[
                    styles.modeButton,
                    globalMode === 'PLANNING' && styles.modeButtonActive,
                  ]}
                  onPress={() => setGlobalMode('PLANNING')}
                  disabled={isSubmitting}
                >
                  <Network
                    width={20}
                    height={20}
                    color={globalMode === 'PLANNING' ? colors.accent : colors.textMuted}
                  />
                  <View style={styles.modeContent}>
                    <Text
                      style={[
                        styles.modeTitle,
                        globalMode === 'PLANNING' && styles.modeTitleActive,
                      ]}
                    >
                      Planning
                    </Text>
                    <Text style={styles.modeDesc}>Research and architectural design</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.modeButton,
                    globalMode === 'IMPLEMENTATION' && styles.modeButtonActive,
                  ]}
                  onPress={() => setGlobalMode('IMPLEMENTATION')}
                  disabled={isSubmitting}
                >
                  <Code
                    width={20}
                    height={20}
                    color={globalMode === 'IMPLEMENTATION' ? colors.accent : colors.textMuted}
                  />
                  <View style={styles.modeContent}>
                    <Text
                      style={[
                        styles.modeTitle,
                        globalMode === 'IMPLEMENTATION' && styles.modeTitleActive,
                      ]}
                    >
                      Implementation
                    </Text>
                    <Text style={styles.modeDesc}>Coding and execution</Text>
                  </View>
                </TouchableOpacity>
              </View>
            </View>

            {/* Orchestration Mode selection */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Orchestration Mode</Text>
              <View style={styles.radioGroup}>
                <TouchableOpacity
                  style={styles.radioRow}
                  onPress={() => setMode('AUTO')}
                  disabled={isSubmitting}
                >
                  <View style={[styles.radio, mode === 'AUTO' && styles.radioSelected]}>
                    {mode === 'AUTO' && <View style={styles.radioInner} />}
                  </View>
                  <View style={styles.radioContent}>
                    <Text style={styles.radioTitle}>Auto</Text>
                    <Text style={styles.radioDesc}>Agents run autonomously</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.radioRow}
                  onPress={() => setMode('INTERACTIVE')}
                  disabled={isSubmitting}
                >
                  <View style={[styles.radio, mode === 'INTERACTIVE' && styles.radioSelected]}>
                    {mode === 'INTERACTIVE' && <View style={styles.radioInner} />}
                  </View>
                  <View style={styles.radioContent}>
                    <Text style={styles.radioTitle}>Interactive</Text>
                    <Text style={styles.radioDesc}>Guided execution</Text>
                  </View>
                </TouchableOpacity>
              </View>
            </View>

            {/* Working Directory */}
            <View style={styles.formGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>Working Directory</Text>
                <Text style={styles.labelOptional}>(Optional)</Text>
              </View>
              <TextInput
                style={styles.input}
                value={cwd}
                onChangeText={setCwd}
                placeholder="Absolute path to working directory..."
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSubmitting}
              />
              <Text style={styles.hint}>
                Defaults to project root. Agents will have read/write access here.
              </Text>
            </View>
          </ScrollView>

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={onClose}
              disabled={isSubmitting}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.createButton, isSubmitting && styles.createButtonDisabled]}
              onPress={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color={colors.bgPrimary} />
              ) : (
                <View style={styles.createButtonContent}>
                  <Plus width={16} height={16} color={colors.bgPrimary} strokeWidth={2} />
                  <Text style={styles.createButtonText}>Create Session</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  modal: {
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    width: '90%',
    maxWidth: 500,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgElevated,
  },
  title: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  closeButton: {
    padding: spacing.sm,
  },
  closeButtonText: {
    color: colors.textMuted,
    fontSize: fontSize['4xl'],
    lineHeight: fontSize['4xl'],
  },
  content: {
    padding: spacing.xl,
  },
  errorContainer: {
    padding: spacing.lg,
    backgroundColor: 'rgba(255, 100, 100, 0.1)',
    borderWidth: 1,
    borderColor: colors.statusFailed,
    borderRadius: radius.sm,
    marginBottom: spacing.xl,
  },
  errorText: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.statusFailed,
  },
  formGroup: {
    marginBottom: spacing.xl,
  },
  label: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  labelOptional: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  input: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
  },
  hint: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  modeToggle: {
    gap: spacing.md,
  },
  modeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    backgroundColor: colors.bgSecondary,
    gap: spacing.lg,
    marginBottom: spacing.md,
  },
  modeButtonActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSubtle,
  },
  modeContent: {
    flex: 1,
  },
  modeTitle: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  modeTitleActive: {
    color: colors.accent,
  },
  modeDesc: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  radioGroup: {
    gap: spacing.md,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.sm,
    backgroundColor: colors.bgSecondary,
    gap: spacing.lg,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioSelected: {
    borderColor: colors.accent,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  radioContent: {
    flex: 1,
  },
  radioTitle: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
  },
  radioDesc: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    padding: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  cancelButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
  },
  cancelButtonText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    letterSpacing: 0.5,
  },
  createButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    minWidth: 140,
    alignItems: 'center',
  },
  createButtonDisabled: {
    opacity: 0.5,
  },
  createButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  createButtonText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.bgPrimary,
    letterSpacing: 0.5,
  },
});
