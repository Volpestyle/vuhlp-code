
export async function streamSse(response: Response, onData: (data: string) => void): Promise<void> {
    const body = response.body;
    if (!body) {
        throw new Error("response body is empty");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flush = (flushRemaining = false) => {
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = extractSseData(chunk);
            if (data !== null) {
                onData(data);
            }
            boundary = buffer.indexOf("\n\n");
        }
        if (flushRemaining && buffer.trim().length > 0) {
            const data = extractSseData(buffer);
            if (data !== null) {
                onData(data);
            }
            buffer = "";
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        flush();
    }

    buffer += decoder.decode();
    flush(true);
}

export function extractSseData(chunk: string): string | null {
    const lines = chunk.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
        }
    }
    if (dataLines.length === 0) {
        return null;
    }
    return dataLines.join("\n");
}

export async function streamJsonLines(response: Response, onLine: (line: string) => void): Promise<void> {
    const body = response.body;
    if (!body) {
        throw new Error("response body is empty");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flush = (flushRemaining = false) => {
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n");
        while (boundary !== -1) {
            const line = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 1);
            if (line.length > 0) {
                onLine(line);
            }
            boundary = buffer.indexOf("\n");
        }
        if (flushRemaining && buffer.trim().length > 0) {
            onLine(buffer.trim());
            buffer = "";
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        flush();
    }

    buffer += decoder.decode();
    flush(true);
}
