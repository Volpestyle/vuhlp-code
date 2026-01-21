import React, { memo } from 'react';
import { StyleSheet, View, Text, Linking, type TextStyle, type ViewStyle } from 'react-native';
import Markdown, { type RenderRules } from 'react-native-markdown-display';
import { colors, fontFamily } from '@/lib/theme';

interface MarkdownMessageProps {
  children: string;
}

export const MarkdownMessage = memo(function MarkdownMessage({
  children,
}: MarkdownMessageProps) {
  return (
    <View style={containerStyles.container}>
      <Markdown style={markdownStyles} rules={markdownRules}>
        {children}
      </Markdown>
    </View>
  );
});

const markdownStyles = StyleSheet.create<Record<string, TextStyle | ViewStyle>>({
  body: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 22,
  },
  text: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 22,
  },
  textgroup: {
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
    fontFamily: fontFamily.mono,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  code_block: {
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    fontFamily: fontFamily.mono,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  fence: {
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    fontFamily: fontFamily.mono,
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
});

function handleMarkdownLinkPress(
  url: string | undefined,
  onLinkPress?: (url: string) => boolean
) {
  if (!url) return;
  const handled = onLinkPress ? onLinkPress(url) : false;
  if (handled) return;
  Linking.openURL(url).catch((err) => {
    console.error('[markdown] failed to open link:', err);
  });
}

// Ensure markdown text and groups are selectable across iOS and Android.
const markdownRules: RenderRules = {
  text: (node, children, parentNodes, styles, inheritedStyles = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.text]}>
      {node.content}
    </Text>
  ),
  textgroup: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.textgroup}>
      {children}
    </Text>
  ),
  link: (node, children, parentNodes, styles, onLinkPress) => (
    <Text
      key={node.key}
      selectable
      style={styles.link}
      onPress={() => handleMarkdownLinkPress(node.attributes?.href, onLinkPress)}
    >
      {children}
    </Text>
  ),
  heading1: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.heading1}>
      {children}
    </Text>
  ),
  heading2: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.heading2}>
      {children}
    </Text>
  ),
  heading3: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.heading3}>
      {children}
    </Text>
  ),
  strong: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.strong}>
      {children}
    </Text>
  ),
  em: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.em}>
      {children}
    </Text>
  ),
  s: (node, children, parentNodes, styles) => (
    <Text key={node.key} selectable style={styles.s}>
      {children}
    </Text>
  ),
  code_inline: (node, children, parentNodes, styles, inheritedStyles = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.code_inline]}>
      {node.content}
    </Text>
  ),
  code_block: (node, children, parentNodes, styles, inheritedStyles = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.code_block]}>
      {node.content}
    </Text>
  ),
  fence: (node, children, parentNodes, styles, inheritedStyles = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.fence]}>
      {node.content}
    </Text>
  ),
};

const containerStyles = StyleSheet.create({
  container: {
    width: '100%',
  },
});
