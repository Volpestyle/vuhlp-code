import { useCallback, useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Modal } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, MediaImageList, Folder, Xmark } from 'iconoir-react-native';
import { colors, fontFamily } from '@/lib/theme';

interface MediaPickerDrawerProps {
  visible: boolean;
  onClose: () => void;
  onSelectCamera: () => void;
  onSelectPhotos: () => void;
  onSelectFiles: () => void;
}

export function MediaPickerDrawer({
  visible,
  onClose,
  onSelectCamera,
  onSelectPhotos,
  onSelectFiles,
}: MediaPickerDrawerProps) {
  const insets = useSafeAreaInsets();
  const [modalVisible, setModalVisible] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);

  // Sync modal visibility with prop
  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      setShowDrawer(true);
    } else {
      setShowDrawer(false);
    }
  }, [visible]);

  const closeModal = useCallback(() => {
    'worklet';
    runOnJS(setModalVisible)(false);
  }, []);

  const handleCamera = useCallback(() => {
    console.log('[media-picker] camera selected');
    onSelectCamera();
    onClose();
  }, [onSelectCamera, onClose]);

  const handlePhotos = useCallback(() => {
    console.log('[media-picker] photos selected');
    onSelectPhotos();
    onClose();
  }, [onSelectPhotos, onClose]);

  const handleFiles = useCallback(() => {
    console.log('[media-picker] files selected');
    onSelectFiles();
    onClose();
  }, [onSelectFiles, onClose]);

  return (
    <Modal
      visible={modalVisible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        {showDrawer && (
        <Animated.View
          entering={SlideInDown.duration(200)}
          exiting={SlideOutDown.duration(150).withCallback((finished) => {
            'worklet';
            if (finished) {
              closeModal();
            }
          })}
          style={[styles.drawer, { paddingBottom: insets.bottom + 16 }]}
        >
          {/* Handle */}
          <View style={styles.handleContainer}>
            <View style={styles.handle} />
          </View>

          {/* Header */}
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              hitSlop={12}
            >
              <Xmark width={20} height={20} color={colors.textSecondary} strokeWidth={2} />
            </Pressable>
            <Text style={styles.title}>Add to Chat</Text>
            <View style={styles.closeButton} />
          </View>

          {/* Media Options */}
          <View style={styles.optionsRow}>
            <Pressable style={styles.optionButton} onPress={handleCamera}>
              <View style={styles.optionIconContainer}>
                <Camera width={24} height={24} color={colors.textPrimary} strokeWidth={1.5} />
              </View>
              <Text style={styles.optionLabel}>Camera</Text>
            </Pressable>

            <Pressable style={styles.optionButton} onPress={handlePhotos}>
              <View style={styles.optionIconContainer}>
                <MediaImageList width={24} height={24} color={colors.textPrimary} strokeWidth={1.5} />
              </View>
              <Text style={styles.optionLabel}>Photos</Text>
            </Pressable>

            <Pressable style={styles.optionButton} onPress={handleFiles}>
              <View style={styles.optionIconContainer}>
                <Folder width={24} height={24} color={colors.textPrimary} strokeWidth={1.5} />
              </View>
              <Text style={styles.optionLabel}>Files</Text>
            </Pressable>
          </View>
        </Animated.View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  drawer: {
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fontFamily.semibold,
  },
  optionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: 12,
    paddingVertical: 16,
  },
  optionButton: {
    alignItems: 'center',
    gap: 8,
  },
  optionIconContainer: {
    width: 80,
    height: 64,
    borderRadius: 12,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: fontFamily.medium,
  },
});
