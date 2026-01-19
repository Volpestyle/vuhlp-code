import React, { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Markdown, { type MarkdownProps } from 'react-native-markdown-display';

interface MarkdownMessageProps {
  children: string;
}

export const MarkdownMessage = memo(function MarkdownMessage({
  children,
}: MarkdownMessageProps) {
  // Styles for the markdown renderer
  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          color: '#e5e5e5', // nearly white for readability on dark
          fontSize: 15,
          lineHeight: 22,
        },
        heading1: {
          color: '#ffffff',
          fontSize: 22,
          fontWeight: '700',
          marginTop: 10,
          marginBottom: 10,
        },
        heading2: {
          color: '#ffffff',
          fontSize: 20,
          fontWeight: '700',
          marginTop: 10,
          marginBottom: 10,
        },
        heading3: {
          color: '#ffffff',
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
          color: '#60a5fa', // blue-400
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
          backgroundColor: '#333',
          color: '#efefef',
          fontFamily: 'Menlo', // or monospace
          borderRadius: 4,
          paddingHorizontal: 4,
          paddingVertical: 2,
        },
        fence: {
          backgroundColor: '#2a2a2a',
          color: '#efefef',
          fontFamily: 'Menlo',
          borderRadius: 8,
          padding: 10,
          marginTop: 10,
          marginBottom: 10,
          borderWidth: 1,
          borderColor: '#444',
        },
        blockquote: {
          backgroundColor: '#2a2a2a',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderLeftWidth: 4,
          borderLeftColor: '#444',
          marginBottom: 10,
        },
        table: {
          borderWidth: 1,
          borderColor: '#444',
          borderRadius: 4,
        },
        tr: {
          borderBottomWidth: 1,
          borderColor: '#444',
          flexDirection: 'row',
        },
        th: {
          padding: 8,
          borderRightWidth: 1,
          borderColor: '#444',
          alignItems: 'center',
          backgroundColor: '#333',
        },
        td: {
          padding: 8,
          borderRightWidth: 1,
          borderColor: '#444',
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
