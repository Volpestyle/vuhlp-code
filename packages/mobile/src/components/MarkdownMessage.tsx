import React, { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { colors } from '@/lib/theme';

interface MarkdownMessageProps {
  children: string;
}

export const MarkdownMessage = memo(function MarkdownMessage({
  children,
}: MarkdownMessageProps) {
  // Styles for the markdown renderer - matching web UI warm cream tones
  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          color: colors.textPrimary,
          fontSize: 15,
          lineHeight: 22,
        },
        heading1: {
          color: colors.textPrimary,
          fontSize: 22,
          fontWeight: '700',
          marginTop: 10,
          marginBottom: 10,
        },
        heading2: {
          color: colors.textPrimary,
          fontSize: 20,
          fontWeight: '700',
          marginTop: 10,
          marginBottom: 10,
        },
        heading3: {
          color: colors.textPrimary,
          fontSize: 18,
          fontWeight: '700',
          marginTop: 10,
          marginBottom: 10,
        },
        paragraph: {
          marginTop: 0,
          marginBottom: 10,
          flexWrap: 'wrap',
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          width: '100%',
        },
        link: {
          color: colors.linkBlue,
          textDecorationLine: 'underline',
        },
        list_item: {
          marginTop: 5,
          marginBottom: 5,
        },
        bullet_list: {
          marginTop: 0,
          marginBottom: 10,
        },
        ordered_list: {
          marginTop: 0,
          marginBottom: 10,
        },
        code_inline: {
          backgroundColor: colors.bgElevated,
          color: colors.textPrimary,
          fontFamily: 'Menlo',
          borderRadius: 4,
          paddingHorizontal: 4,
          paddingVertical: 2,
        },
        fence: {
          backgroundColor: colors.bgSecondary,
          color: colors.textPrimary,
          fontFamily: 'Menlo',
          borderRadius: 8,
          padding: 10,
          marginTop: 10,
          marginBottom: 10,
          borderWidth: 1,
          borderColor: colors.borderStrong,
        },
        blockquote: {
          backgroundColor: colors.bgSecondary,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderLeftWidth: 4,
          borderLeftColor: colors.accentDim,
          marginBottom: 10,
        },
        table: {
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: 4,
        },
        tr: {
          borderBottomWidth: 1,
          borderColor: colors.borderStrong,
          flexDirection: 'row',
        },
        th: {
          padding: 8,
          borderRightWidth: 1,
          borderColor: colors.borderStrong,
          alignItems: 'center',
          backgroundColor: colors.bgElevated,
        },
        td: {
          padding: 8,
          borderRightWidth: 1,
          borderColor: colors.borderStrong,
        },
      }),
    []
  );

  return (
    <View style={containerStyles.container}>
      <Markdown style={styles as any}>{children}</Markdown>
    </View>
  );
});

const containerStyles = StyleSheet.create({
  container: {
    width: '100%',
  },
});
