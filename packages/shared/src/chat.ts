import type { ChatMessage, ISO8601, UUID } from '@vuhlp/contracts';
import { stripToolCallLines } from './toolCallFilter.js';

export const appendAssistantDelta = (
    messages: ChatMessage[],
    nodeId: UUID,
    delta: string,
    timestamp: ISO8601
): ChatMessage[] => {
    const streamId = `stream-${nodeId}`;
    const thinkingStreamId = `thinking-stream-${nodeId}`;

    // 1. Try to find existing stream message
    const existingIndex = messages.findIndex((msg) => msg.id === streamId);
    if (existingIndex >= 0) {
        const existing = messages[existingIndex];
        if (!existing) return messages;

        const rawContent = `${existing.rawContent ?? existing.content}${delta}`;
        const content = stripToolCallLines(rawContent);
        const next = [...messages];
        next[existingIndex] = {
            ...existing,
            content,
            rawContent,
            createdAt: timestamp,
            streaming: true,
            // Text content arriving means thinking is complete
            thinkingStreaming: false,
        };
        return next;
    }

    // 2. Check if there's an existing thinking-only message to merge into
    const thinkingOnlyIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);
    if (thinkingOnlyIndex >= 0) {
        const existing = messages[thinkingOnlyIndex];
        if (!existing) return messages;

        const rawContent = delta;
        const content = stripToolCallLines(delta);
        const next = [...messages];
        // Upgrade the thinking-only message to a full stream message
        next[thinkingOnlyIndex] = {
            ...existing,
            id: streamId, // Change ID to stream ID
            content,
            rawContent,
            createdAt: timestamp,
            streaming: true,
            // Text content arriving means thinking is complete
            thinkingStreaming: false,
        };
        return next;
    }

    // 3. Create new stream message
    const rawContent = delta;
    const content = stripToolCallLines(delta);
    const nextMessage: ChatMessage = {
        id: streamId,
        nodeId,
        role: 'assistant',
        content,
        rawContent,
        createdAt: timestamp,
        streaming: true,
    };
    return [...messages, nextMessage];
};

export const finalizeAssistantMessage = (
    messages: ChatMessage[],
    nodeId: UUID,
    content: string,
    timestamp: ISO8601,
    status?: ChatMessage['status'],
    id?: string
): ChatMessage[] => {
    const streamId = `stream-${nodeId}`;
    const thinkingStreamId = `thinking-stream-${nodeId}`;

    // Check if we already have this message (by ID)
    // This handles race conditions where the backend event is processed multiple times
    // or during history replay
    const hasExistingMessage = id ? messages.some((msg) => msg.id === id) : false;

    const filtered = messages.filter((msg) => msg.id !== streamId && msg.id !== thinkingStreamId);

    if (hasExistingMessage) {
        // If message exists, just remove stream and thinking
        return filtered;
    }

    // Find the thinking content from the streaming message before we filter it out
    const streamingMsg = messages.find((msg) => msg.id === streamId);
    const thinkingStreamingMsg = messages.find((msg) => msg.id === thinkingStreamId);
    const thinking = streamingMsg?.thinking ?? thinkingStreamingMsg?.thinking;

    const nextMessage: ChatMessage = {
        id: id ?? `local-${crypto.randomUUID()}`,
        nodeId,
        role: 'assistant',
        content,
        createdAt: timestamp,
        status,
        thinking,
    };
    return [...filtered, nextMessage];
};

export const appendAssistantThinkingDelta = (
    messages: ChatMessage[],
    nodeId: UUID,
    delta: string,
    timestamp: ISO8601
): ChatMessage[] => {
    const streamId = `stream-${nodeId}`;
    const existingStreamIndex = messages.findIndex((msg) => msg.id === streamId);

    // If there's an existing stream message, append thinking to it
    if (existingStreamIndex >= 0) {
        const existing = messages[existingStreamIndex];
        if (!existing) return messages;

        const next = [...messages];
        next[existingStreamIndex] = {
            ...existing,
            thinking: `${existing.thinking ?? ''}${delta}`,
            thinkingStreaming: true,
            createdAt: timestamp,
        };
        return next;
    }

    // Otherwise create/update thinking-only message
    const thinkingStreamId = `thinking-stream-${nodeId}`;
    const existingThinkingIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);

    if (existingThinkingIndex >= 0) {
        const existing = messages[existingThinkingIndex];
        if (!existing) return messages;

        const next = [...messages];
        next[existingThinkingIndex] = {
            ...existing,
            thinking: `${existing.thinking ?? ''}${delta}`,
            thinkingStreaming: true,
            createdAt: timestamp,
        };
        return next;
    }

    const nextMessage: ChatMessage = {
        id: thinkingStreamId,
        nodeId,
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        streaming: true,
        thinking: delta,
        thinkingStreaming: true,
    };
    return [...messages, nextMessage];
};

export const finalizeAssistantThinking = (
    messages: ChatMessage[],
    nodeId: UUID,
    content: string,
    timestamp: ISO8601
): ChatMessage[] => {
    const streamId = `stream-${nodeId}`;
    const thinkingStreamId = `thinking-stream-${nodeId}`;

    // Try to find the stream message first
    const streamIndex = messages.findIndex((msg) => msg.id === streamId);
    if (streamIndex >= 0) {
        const existing = messages[streamIndex];
        if (!existing) return messages;

        const next = [...messages];
        next[streamIndex] = {
            ...existing,
            thinking: content,
            thinkingStreaming: false,
            createdAt: timestamp,
        };
        return next;
    }

    // Try to find the thinking stream message
    const thinkingStreamIndex = messages.findIndex((msg) => msg.id === thinkingStreamId);
    if (thinkingStreamIndex >= 0) {
        const existing = messages[thinkingStreamIndex];
        if (!existing) return messages;

        const next = [...messages];
        next[thinkingStreamIndex] = {
            ...existing,
            thinking: content,
            thinkingStreaming: false,
            createdAt: timestamp,
        };
        return next;
    }

    // Create new message with just thinking
    const nextMessage: ChatMessage = {
        id: thinkingStreamId,
        nodeId,
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        streaming: true,
        thinking: content,
        thinkingStreaming: false,
    };
    return [...messages, nextMessage];
};

export const finalizeNodeMessages = (
    messages: ChatMessage[],
    timestamp: ISO8601
): ChatMessage[] => {
    if (!messages) return [];

    const needsFinalization = messages.some(
        (m) => m.streaming || m.thinkingStreaming
    );
    if (!needsFinalization) return messages;

    return messages.map((m) => {
        if (!m.streaming && !m.thinkingStreaming) return m;

        return {
            ...m,
            streaming: false,
            thinkingStreaming: false,
            status: m.status ?? 'interrupted',
            createdAt: timestamp,
        };
    });
};

export const clearNodeMessages = (
    chatMessages: Record<UUID, ChatMessage[]>,
    nodeId: UUID
): Record<UUID, ChatMessage[]> => {
    if (!chatMessages[nodeId]) {
        return chatMessages;
    }
    const { [nodeId]: _removed, ...remaining } = chatMessages;
    return remaining;
};
