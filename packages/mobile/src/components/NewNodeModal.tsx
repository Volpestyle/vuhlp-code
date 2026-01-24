import { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import type { NodeCapabilities, NodePermissions, ProviderName, TemplateInfo } from '@vuhlp/contracts';
import { Plus } from 'iconoir-react-native';
import { colors, fontFamily, fontSize, radius, spacing } from '@/lib/theme';
import { api } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PERMISSIONS,
  EDGE_MANAGEMENT_OPTIONS,
  PERMISSIONS_MODE_OPTIONS,
  PROVIDER_OPTIONS,
  ROLE_TEMPLATES,
  getEdgeManagementDefaults,
  parseEdgeManagement,
} from '@vuhlp/shared';

interface NewNodeModalProps {
  visible: boolean;
  onClose: () => void;
  runId: string;
}

type BooleanCapability = Exclude<keyof NodeCapabilities, 'edgeManagement'>;
const BOOLEAN_CAPABILITIES: BooleanCapability[] = [
  'writeCode',
  'writeDocs',
  'runCommands',
  'delegateOnly',
];

export function NewNodeModal({ visible, onClose, runId }: NewNodeModalProps) {
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const addNode = useGraphStore((s) => s.addNode);
  const selectNode = useGraphStore((s) => s.selectNode);
  const scrollViewRef = useRef<ScrollView>(null);

  const [label, setLabel] = useState('');
  const [roleMode, setRoleMode] = useState<'basic' | 'custom'>('basic');
  const [roleTemplate, setRoleTemplate] = useState('implementer');
  const [customTemplates, setCustomTemplates] = useState<TemplateInfo[]>([]);
  const [provider, setProvider] = useState<ProviderName>('claude');
  const [capabilities, setCapabilities] = useState<NodeCapabilities>(DEFAULT_CAPABILITIES);
  const [permissions, setPermissions] = useState<NodePermissions>(DEFAULT_PERMISSIONS);
  const [edgeManagementTouched, setEdgeManagementTouched] = useState(false);
  const [agentManagementApprovalTouched, setAgentManagementApprovalTouched] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (!visible) return;
    setLabel(`New Agent ${nodeCount + 1}`);
    setRoleMode('basic');
    setRoleTemplate('implementer');
    setProvider('claude');
    setCapabilities(DEFAULT_CAPABILITIES);
    setPermissions(DEFAULT_PERMISSIONS);
    setEdgeManagementTouched(false);
    setAgentManagementApprovalTouched(false);
    setError(null);
    // Flash scroll indicator to show content is scrollable
    setTimeout(() => {
      scrollViewRef.current?.flashScrollIndicators();
    }, 300);
  }, [visible, nodeCount]);

  // Smart defaults based on role template
  useEffect(() => {
    if (!visible) return;
    const defaults = getEdgeManagementDefaults(roleTemplate);
    if (!edgeManagementTouched) {
      setCapabilities((prev) => ({ ...prev, edgeManagement: defaults.edgeManagement }));
    }
    if (!agentManagementApprovalTouched) {
      setPermissions((prev) => ({
        ...prev,
        agentManagementRequiresApproval: defaults.agentManagementRequiresApproval,
      }));
    }
  }, [visible, roleTemplate, edgeManagementTouched, agentManagementApprovalTouched]);

  // Load custom templates
  useEffect(() => {
    if (visible && roleMode === 'custom') {
      api.listTemplates()
        .then((res) => {
           const filtered = res.templates.filter(t => !ROLE_TEMPLATES.includes(t.name));
           setCustomTemplates(filtered);
        })
        .catch((err) => console.error('[NewNodeModal] Failed to list templates', err));
    }
  }, [visible, roleMode]);

  const canSubmit = label.trim().length > 0 && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);

    try {
      console.log('[NewNodeModal] Creating node:', { label, roleTemplate, provider });
      const created = await api.createNode(runId, {
        label: label.trim(),
        roleTemplate: roleTemplate.trim() || 'implementer',
        provider,
        capabilities,
        permissions,
        session: {
          resume: true,
          resetCommands: ['/new', '/clear'],
        },
      });
      console.log('[NewNodeModal] Node created:', created.id);
      addNode(created);
      selectNode(created.id);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create node';
      console.error('[NewNodeModal] Error creating node:', message);
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    runId,
    label,
    roleTemplate,
    provider,
    capabilities,
    permissions,
    addNode,
    selectNode,
    onClose,
  ]);

  const handleBooleanCapabilityToggle = useCallback((key: BooleanCapability) => {
    setCapabilities((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleEdgeManagementChange = useCallback((value: string) => {
    const parsed = parseEdgeManagement(value);
    if (!parsed) {
      console.warn('[NewNodeModal] unsupported edge management', value);
      setError('Unsupported edge management selected.');
      return;
    }
    setEdgeManagementTouched(true);
    setCapabilities((prev) => ({ ...prev, edgeManagement: parsed }));
  }, []);

  const handlePermissionsToggle = useCallback(() => {
    setAgentManagementApprovalTouched(true);
    setPermissions((prev) => ({
      ...prev,
      agentManagementRequiresApproval: !prev.agentManagementRequiresApproval,
    }));
  }, []);

  const handlePermissionsModeChange = useCallback((mode: NodePermissions['cliPermissionsMode']) => {
    setPermissions((prev) => ({ ...prev, cliPermissionsMode: mode }));
  }, []);

  const formatCapabilityLabel = (key: string): string => {
    return key.replace(/([A-Z])/g, ' $1').trim();
  };

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
            <Text style={styles.title}>New Agent</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView ref={scrollViewRef} style={styles.content} showsVerticalScrollIndicator={true} indicatorStyle="white">
            {/* Error display */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Label input */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Label</Text>
              <TextInput
                style={styles.input}
                value={label}
                onChangeText={setLabel}
                placeholder="Node label"
                placeholderTextColor={colors.textMuted}
                autoFocus
              />
            </View>

            {/* Role Template input */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Role Template</Text>
              
              <View style={styles.tabsRow}>
                <TouchableOpacity
                  style={[styles.tab, roleMode === 'basic' && styles.tabActive]}
                  onPress={() => {
                    setRoleMode('basic');
                    setRoleTemplate(ROLE_TEMPLATES[0] || 'implementer');
                  }}
                >
                  <Text style={[styles.tabText, roleMode === 'basic' && styles.tabTextActive]}>
                    Basic
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tab, roleMode === 'custom' && styles.tabActive]}
                  onPress={() => {
                    setRoleMode('custom');
                    setRoleTemplate('');
                  }}
                >
                  <Text style={[styles.tabText, roleMode === 'custom' && styles.tabTextActive]}>
                    Custom
                  </Text>
                </TouchableOpacity>
              </View>

              {roleMode === 'basic' ? (
                <View style={styles.providerRow}>
                  {ROLE_TEMPLATES.map((template: string) => (
                    <TouchableOpacity
                      key={template}
                      style={[
                        styles.providerOption,
                        roleTemplate === template && styles.providerOptionSelected,
                      ]}
                      onPress={() => setRoleTemplate(template)}
                    >
                      <Text
                        style={[
                          styles.providerOptionText,
                          roleTemplate === template && styles.providerOptionTextSelected,
                        ]}
                      >
                        {template.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                 <View style={styles.providerRow}>
                  {customTemplates.length === 0 ? (
                    <Text style={styles.label}>No saved templates found</Text>
                  ) : (
                    customTemplates.map((template) => (
                      <TouchableOpacity
                        key={template.name}
                        style={[
                          styles.providerOption,
                          roleTemplate === template.name && styles.providerOptionSelected,
                        ]}
                        onPress={() => setRoleTemplate(template.name)}
                      >
                        <Text
                          style={[
                            styles.providerOptionText,
                            roleTemplate === template.name && styles.providerOptionTextSelected,
                          ]}
                        >
                          {template.name}
                        </Text>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              )}
            </View>

            {/* Provider selection */}
            <View style={styles.formGroup}>
              <Text style={styles.label}>Provider</Text>
              <View style={styles.providerRow}>
                {PROVIDER_OPTIONS.map((option) => (
                  <TouchableOpacity
                    key={option}
                    style={[
                      styles.providerOption,
                      provider === option && styles.providerOptionSelected,
                    ]}
                    onPress={() => setProvider(option)}
                  >
                    <Text
                      style={[
                        styles.providerOptionText,
                        provider === option && styles.providerOptionTextSelected,
                      ]}
                    >
                      {option.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Permissions section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Permissions</Text>

            <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Agent management requires approval</Text>
                <Switch
                  value={permissions.agentManagementRequiresApproval}
                  onValueChange={handlePermissionsToggle}
                  trackColor={{ false: colors.bgHover, true: colors.accentDim }}
                  thumbColor={
                    permissions.agentManagementRequiresApproval ? colors.accent : colors.textMuted
                  }
                  disabled={isSubmitting}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>CLI Permissions</Text>
                <View style={styles.providerRow}>
                  {PERMISSIONS_MODE_OPTIONS.map((mode) => (
                    <TouchableOpacity
                      key={mode}
                      style={[
                        styles.providerOption,
                        permissions.cliPermissionsMode === mode && styles.providerOptionSelected,
                      ]}
                      onPress={() => handlePermissionsModeChange(mode)}
                      disabled={isSubmitting}
                    >
                      <Text
                        style={[
                          styles.providerOptionText,
                          permissions.cliPermissionsMode === mode &&
                            styles.providerOptionTextSelected,
                        ]}
                      >
                        {mode.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>

            {/* Capabilities section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Capabilities</Text>
              <View style={styles.formGroup}>
                <Text style={styles.label}>Edge Management</Text>
                <View style={styles.providerRow}>
                  {EDGE_MANAGEMENT_OPTIONS.map((option) => (
                    <TouchableOpacity
                      key={option}
                      style={[
                        styles.providerOption,
                        capabilities.edgeManagement === option && styles.providerOptionSelected,
                      ]}
                      onPress={() => handleEdgeManagementChange(option)}
                      disabled={isSubmitting}
                    >
                      <Text
                        style={[
                          styles.providerOptionText,
                          capabilities.edgeManagement === option && styles.providerOptionTextSelected,
                        ]}
                      >
                        {option.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              {BOOLEAN_CAPABILITIES.map((key) => (
                <View key={key} style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>{formatCapabilityLabel(key)}</Text>
                  <Switch
                    value={capabilities[key]}
                    onValueChange={() => handleBooleanCapabilityToggle(key)}
                    trackColor={{ false: colors.bgHover, true: colors.accentDim }}
                    thumbColor={capabilities[key] ? colors.accent : colors.textMuted}
                    disabled={isSubmitting}
                  />
                </View>
              ))}
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
              style={[styles.createButton, !canSubmit && styles.createButtonDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color={colors.bgPrimary} />
              ) : (
                <View style={styles.createButtonContent}>
                  <Plus width={16} height={16} color={colors.bgPrimary} strokeWidth={2} />
                  <Text style={styles.createButtonText}>Create Node</Text>
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
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    padding: 2,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    borderRadius: radius.sm,
  },
  tabActive: {
    backgroundColor: colors.bgElevated,
  },
  tabText: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  tabTextActive: {
    color: colors.textPrimary,
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
  providerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  providerOption: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    backgroundColor: colors.bgSecondary,
  },
  providerOptionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSubtle,
  },
  providerOptionText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.xs,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  providerOptionTextSelected: {
    color: colors.accent,
  },
  section: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.sm,
    backgroundColor: colors.bgSecondary,
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.lg,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  toggleLabel: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
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
    minWidth: 120,
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
